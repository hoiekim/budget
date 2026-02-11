/**
 * Chart repository - CRUD operations for charts.
 */

import { JSONChart, ChartType } from "common";
import { pool } from "../client";
import { buildSelectWithFilters, selectWithFilters } from "../database";
import {
  MaskedUser,
  ChartModel,
  ChartRow,
  CHARTS,
  CHART_ID,
  USER_ID,
} from "../models";

// =============================================
// Query Helpers
// =============================================

const rowToChart = (row: ChartRow): JSONChart => new ChartModel(row).toJSON();

// =============================================
// Repository Functions
// =============================================

/**
 * Gets all charts for a user.
 */
export const getCharts = async (user: MaskedUser): Promise<JSONChart[]> => {
  const rows = await selectWithFilters<ChartRow>(pool, CHARTS, "*", {
    user_id: user.user_id,
  });
  return rows.map(rowToChart);
};

/**
 * Gets a single chart by ID.
 */
export const getChart = async (
  user: MaskedUser,
  chart_id: string
): Promise<JSONChart | null> => {
  const rows = await selectWithFilters<ChartRow>(pool, CHARTS, "*", {
    user_id: user.user_id,
    primaryKey: { column: CHART_ID, value: chart_id },
  });
  return rows.length > 0 ? rowToChart(rows[0]) : null;
};

/**
 * Searches charts with optional filters.
 */
export const searchCharts = async (
  user: MaskedUser,
  options: { chart_id?: string; type?: string } = {}
): Promise<JSONChart[]> => {
  const { sql, values } = buildSelectWithFilters(CHARTS, "*", {
    user_id: user.user_id,
    filters: {
      [CHART_ID]: options.chart_id,
      type: options.type,
    },
  });

  const result = await pool.query<ChartRow>(sql, values);
  return result.rows.map(rowToChart);
};

/**
 * Creates a new chart.
 */
export const createChart = async (
  user: MaskedUser,
  data: Partial<JSONChart>
): Promise<JSONChart | null> => {
  try {
    const config = data.configuration
      ? typeof data.configuration === "string"
        ? data.configuration
        : JSON.stringify(data.configuration)
      : "{}";

    const result = await pool.query<ChartRow>(
      `INSERT INTO ${CHARTS} (${USER_ID}, name, type, configuration, updated)
       VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP)
       RETURNING *`,
      [user.user_id, data.name || "New Chart", data.type || ChartType.BALANCE, config]
    );
    return result.rows.length > 0 ? rowToChart(result.rows[0]) : null;
  } catch (error) {
    console.error("Failed to create chart:", error);
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
  const updates: string[] = ["updated = CURRENT_TIMESTAMP"];
  const values: (string | undefined)[] = [];
  let paramIndex = 1;

  if (data.name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }
  if (data.type !== undefined) {
    updates.push(`type = $${paramIndex++}`);
    values.push(data.type);
  }
  if (data.configuration !== undefined) {
    updates.push(`configuration = $${paramIndex++}`);
    values.push(
      typeof data.configuration === "string"
        ? data.configuration
        : JSON.stringify(data.configuration)
    );
  }

  values.push(chart_id, user.user_id);

  const result = await pool.query(
    `UPDATE ${CHARTS} SET ${updates.join(", ")}
     WHERE ${CHART_ID} = $${paramIndex} AND ${USER_ID} = $${paramIndex + 1}
     RETURNING ${CHART_ID}`,
    values
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Deletes a single chart.
 */
export const deleteChart = async (
  user: MaskedUser,
  chart_id: string
): Promise<boolean> => {
  const result = await pool.query(
    `UPDATE ${CHARTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${CHART_ID} = $1 AND ${USER_ID} = $2
     RETURNING ${CHART_ID}`,
    [chart_id, user.user_id]
  );
  return (result.rowCount || 0) > 0;
};

/**
 * Deletes multiple charts.
 */
export const deleteCharts = async (
  user: MaskedUser,
  chart_ids: string[]
): Promise<{ deleted: number }> => {
  if (!chart_ids.length) return { deleted: 0 };

  const placeholders = chart_ids.map((_, i) => `$${i + 2}`).join(", ");
  const result = await pool.query(
    `UPDATE ${CHARTS} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
     WHERE ${CHART_ID} IN (${placeholders}) AND ${USER_ID} = $1
     RETURNING ${CHART_ID}`,
    [user.user_id, ...chart_ids]
  );

  return { deleted: result.rowCount || 0 };
};
