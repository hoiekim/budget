import { JSONChart } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";

type PartialChart = { chart_id?: string } & Partial<JSONChart>;

/**
 * Converts a chart to Postgres row.
 */
function chartToRow(chart: PartialChart): Record<string, any> {
  const row: Record<string, any> = {};
  
  if (chart.chart_id !== undefined) row.chart_id = chart.chart_id;
  if (chart.name !== undefined) row.name = chart.name;
  if (chart.type !== undefined) row.type = chart.type;
  if (chart.configuration !== undefined) {
    row.configuration = typeof chart.configuration === 'string' 
      ? chart.configuration 
      : JSON.stringify(chart.configuration);
  }
  
  return row;
}

/**
 * Converts a Postgres row to chart.
 */
function rowToChart(row: Record<string, any>): JSONChart {
  let configuration = row.configuration;
  if (configuration && typeof configuration === 'string') {
    try {
      configuration = JSON.parse(configuration);
    } catch {
      // Keep as string if not valid JSON
    }
  }
  
  return {
    chart_id: row.chart_id,
    user_id: row.user_id,
    name: row.name,
    type: row.type,
    configuration,
  } as JSONChart;
}

/**
 * Upserts charts for a user.
 */
export const upsertCharts = async (
  user: MaskedUser,
  charts: PartialChart[]
) => {
  if (!charts.length) return [];
  const { user_id } = user;
  const results: { update: { _id: string }; status: number }[] = [];

  for (const chart of charts) {
    const row = chartToRow(chart);
    row.user_id = user_id;
    
    try {
      const columns = Object.keys(row);
      const values = Object.values(row);
      const placeholders = values.map((_, i) => `$${i + 1}`);
      
      if (chart.chart_id) {
        const updateClauses = columns
          .filter(col => col !== "chart_id" && col !== "user_id")
          .map(col => `${col} = EXCLUDED.${col}`);
        updateClauses.push("updated = CURRENT_TIMESTAMP");
        
        const query = `
          INSERT INTO charts (${columns.join(", ")}, updated)
          VALUES (${placeholders.join(", ")}, CURRENT_TIMESTAMP)
          ON CONFLICT (chart_id) DO UPDATE SET
            ${updateClauses.join(", ")}
          WHERE charts.user_id = $${columns.indexOf("user_id") + 1}
          RETURNING chart_id
        `;
        
        const result = await pool.query(query, values);
        results.push({
          update: { _id: chart.chart_id },
          status: result.rowCount ? 200 : 404,
        });
      } else {
        // Insert new with auto-generated UUID
        const insertColumns = columns.filter(c => c !== "chart_id");
        const insertValues = values.filter((_, i) => columns[i] !== "chart_id");
        const insertPlaceholders = insertValues.map((_, i) => `$${i + 1}`);
        
        const query = `
          INSERT INTO charts (${insertColumns.join(", ")}, updated)
          VALUES (${insertPlaceholders.join(", ")}, CURRENT_TIMESTAMP)
          RETURNING chart_id
        `;
        
        const result = await pool.query(query, insertValues);
        const id = result.rows[0]?.chart_id;
        results.push({
          update: { _id: id },
          status: result.rowCount ? 201 : 500,
        });
      }
    } catch (error: any) {
      console.error(`Failed to upsert chart:`, error.message);
      results.push({
        update: { _id: chart.chart_id || "unknown" },
        status: 500,
      });
    }
  }

  return results;
};

/**
 * Gets all charts for a user.
 */
export const getCharts = async (user: MaskedUser): Promise<JSONChart[]> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM charts WHERE user_id = $1 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [user_id]
  );
  return result.rows.map(rowToChart);
};

/**
 * Gets a single chart by ID.
 */
export const getChart = async (
  user: MaskedUser,
  chart_id: string
): Promise<JSONChart | null> => {
  const { user_id } = user;
  const result = await pool.query(
    `SELECT * FROM charts WHERE chart_id = $1 AND user_id = $2 AND (is_deleted IS NULL OR is_deleted = FALSE)`,
    [chart_id, user_id]
  );
  return result.rows.length > 0 ? rowToChart(result.rows[0]) : null;
};

/**
 * Deletes charts (soft delete).
 */
export const deleteCharts = async (
  user: MaskedUser,
  chart_ids: string[]
): Promise<{ deleted: number }> => {
  if (!chart_ids.length) return { deleted: 0 };
  const { user_id } = user;
  
  const placeholders = chart_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE charts SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE chart_id IN (${placeholders}) AND user_id = $1
     RETURNING chart_id`,
    [user_id, ...chart_ids]
  );
  
  return { deleted: result.rowCount || 0 };
};

/**
 * Searches charts with optional filters.
 */
export const searchCharts = async (
  user: MaskedUser,
  options: { chart_id?: string; type?: string } = {}
): Promise<JSONChart[]> => {
  const { user_id } = user;
  const conditions: string[] = ["user_id = $1", "(is_deleted IS NULL OR is_deleted = FALSE)"];
  const values: any[] = [user_id];
  let paramIndex = 2;

  if (options.chart_id) {
    conditions.push(`chart_id = $${paramIndex}`);
    values.push(options.chart_id);
    paramIndex++;
  }

  if (options.type) {
    conditions.push(`type = $${paramIndex}`);
    values.push(options.type);
    paramIndex++;
  }

  const result = await pool.query(
    `SELECT * FROM charts WHERE ${conditions.join(" AND ")}`,
    values
  );
  return result.rows.map(rowToChart);
};

/**
 * Creates a new chart.
 */
export const createChart = async (
  user: MaskedUser,
  data: Partial<JSONChart>
): Promise<JSONChart | null> => {
  const { user_id } = user;
  
  try {
    const config = data.configuration 
      ? (typeof data.configuration === 'string' ? data.configuration : JSON.stringify(data.configuration))
      : '{}';
      
    const result = await pool.query(
      `INSERT INTO charts (user_id, name, type, configuration, updated)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       RETURNING *`,
      [
        user_id,
        data.name || "New Chart",
        data.type || "line",
        config,
      ]
    );
    return result.rows.length > 0 ? rowToChart(result.rows[0]) : null;
  } catch (error: any) {
    console.error("Failed to create chart:", error.message);
    return null;
  }
};

/**
 * Updates a chart.
 */
export const updateChart = async (
  user: MaskedUser,
  chart_id: string,
  data: Partial<JSONChart>
): Promise<boolean> => {
  const { user_id } = user;
  const updates: string[] = ["updated = CURRENT_TIMESTAMP"];
  const values: any[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex}`);
    values.push(data.name);
    paramIndex++;
  }
  if (data.type !== undefined) {
    updates.push(`type = $${paramIndex}`);
    values.push(data.type);
    paramIndex++;
  }
  if (data.configuration !== undefined) {
    updates.push(`configuration = $${paramIndex}`);
    values.push(typeof data.configuration === 'string' ? data.configuration : JSON.stringify(data.configuration));
    paramIndex++;
  }

  values.push(chart_id, user_id);

  const result = await pool.query(
    `UPDATE charts SET ${updates.join(", ")} 
     WHERE chart_id = $${paramIndex} AND user_id = $${paramIndex + 1}
     RETURNING chart_id`,
    values
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single chart (soft delete).
 */
export const deleteChart = async (
  user: MaskedUser,
  chart_id: string
): Promise<boolean> => {
  const { user_id } = user;
  const result = await pool.query(
    `UPDATE charts SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP 
     WHERE chart_id = $1 AND user_id = $2
     RETURNING chart_id`,
    [chart_id, user_id]
  );
  return (result.rowCount || 0) > 0;
};
