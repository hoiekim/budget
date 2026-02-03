import { ChartType, JSONBalanceChartConfiguration, JSONChart } from "common";
import { pool } from "./client";
import { MaskedUser } from "./users";

/**
 * Creates a document that represents a chart.
 * @param user
 * @returns A promise with the created chart id
 */
export const createChart = async (user: MaskedUser) => {
  const { user_id } = user;
  const updated = new Date().toISOString();

  const defaultChartConfiguration: JSONBalanceChartConfiguration = {
    account_ids: [],
    budget_ids: [],
  };

  const chart = {
    name: "Unnamed",
    type: ChartType.BALANCE,
    configuration: JSON.stringify(defaultChartConfiguration),
  };

  const result = await pool.query(
    `INSERT INTO charts (user_id, name, type, configuration, updated)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING chart_id`,
    [user_id, chart.name, chart.type, chart.configuration, updated]
  );

  return { _id: result.rows[0].chart_id };
};

export type PartialChart = { chart_id: string } & Partial<JSONChart>;

/**
 * Updates chart document with given object.
 * @param user
 * @param chart
 * @returns A promise with the update result
 */
export const updateChart = async (user: MaskedUser, chart: PartialChart) => {
  const { user_id } = user;
  const { chart_id, name, type, configuration } = chart;
  const updated = new Date().toISOString();

  const updates: string[] = [];
  const values: any[] = [];
  let paramIndex = 1;

  if (name !== undefined) {
    updates.push(`name = $${paramIndex++}`);
    values.push(name);
  }
  if (type !== undefined) {
    updates.push(`type = $${paramIndex++}`);
    values.push(type);
  }
  if (configuration !== undefined) {
    updates.push(`configuration = $${paramIndex++}`);
    // Handle both string and object configurations
    const configString = typeof configuration === "string" 
      ? configuration 
      : JSON.stringify(configuration);
    values.push(configString);
  }

  updates.push(`updated = $${paramIndex++}`);
  values.push(updated);

  values.push(chart_id);
  values.push(user_id);

  const result = await pool.query(
    `UPDATE charts SET ${updates.join(", ")} 
     WHERE chart_id = $${paramIndex++} AND user_id = $${paramIndex}`,
    values
  );

  return result;
};

/**
 * Deletes chart document with given id.
 * @param user
 * @param chart_id
 * @returns A promise with the delete result
 */
export const deleteChart = async (user: MaskedUser, chart_id: string) => {
  if (!chart_id) return;
  const { user_id } = user;

  const result = await pool.query(
    `DELETE FROM charts WHERE user_id = $1 AND chart_id = $2`,
    [user_id, chart_id]
  );

  return { deleted: result.rowCount };
};

/**
 * Searches for charts associated with given user.
 * @param user
 * @returns A promise to be an array of chart objects
 */
export const searchCharts = async (user: MaskedUser) => {
  const { user_id } = user;

  const result = await pool.query<{
    chart_id: string;
    name: string;
    type: ChartType;
    configuration: string;
  }>(
    `SELECT chart_id, name, type, configuration FROM charts WHERE user_id = $1`,
    [user_id]
  );

  return result.rows.map((row) => ({
    chart_id: row.chart_id,
    name: row.name,
    type: row.type,
    configuration: row.configuration,
  })) as JSONChart[];
};
