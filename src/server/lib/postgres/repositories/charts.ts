import { JSONChart, ChartType } from "common";
import { MaskedUser, chartsTable, ChartModel, CHART_ID, USER_ID } from "../models";

export const getCharts = async (user: MaskedUser): Promise<JSONChart[]> => {
  const models = await chartsTable.query({ [USER_ID]: user.user_id });
  return models.map(m => m.toJSON());
};

export const getChart = async (user: MaskedUser, chart_id: string): Promise<JSONChart | null> => {
  const model = await chartsTable.queryOne({ [USER_ID]: user.user_id, [CHART_ID]: chart_id });
  return model?.toJSON() ?? null;
};

export const searchCharts = async (
  user: MaskedUser,
  options: { chart_id?: string; type?: string } = {}
): Promise<JSONChart[]> => {
  const filters: Record<string, unknown> = { [USER_ID]: user.user_id };
  if (options.chart_id) filters[CHART_ID] = options.chart_id;
  if (options.type) filters.type = options.type;
  
  const models = await chartsTable.query(filters);
  return models.map(m => m.toJSON());
};

export const createChart = async (user: MaskedUser, data: Partial<JSONChart>): Promise<JSONChart | null> => {
  try {
    const config = data.configuration
      ? typeof data.configuration === "string" ? data.configuration : JSON.stringify(data.configuration)
      : "{}";

    const row = {
      [USER_ID]: user.user_id,
      name: data.name || "New Chart",
      type: data.type || ChartType.BALANCE,
      configuration: config,
    };
    
    const result = await chartsTable.insert(row, ["*"]);
    if (!result) return null;
    const model = new ChartModel(result);
    return model.toJSON();
  } catch (error) {
    console.error("Failed to create chart:", error);
    return null;
  }
};

export const updateChart = async (user: MaskedUser, chart_id: string, data: Partial<JSONChart>): Promise<boolean> => {
  const updates: Record<string, unknown> = {};
  if (data.name !== undefined) updates.name = data.name;
  if (data.type !== undefined) updates.type = data.type;
  if (data.configuration !== undefined) {
    updates.configuration = typeof data.configuration === "string"
      ? data.configuration
      : JSON.stringify(data.configuration);
  }

  if (Object.keys(updates).length === 0) return false;

  const model = await chartsTable.update(chart_id, updates);
  return model !== null;
};

export const deleteChart = async (user: MaskedUser, chart_id: string): Promise<boolean> => {
  return await chartsTable.softDelete(chart_id);
};

export const deleteCharts = async (user: MaskedUser, chart_ids: string[]): Promise<{ deleted: number }> => {
  if (!chart_ids.length) return { deleted: 0 };
  let deleted = 0;
  for (const id of chart_ids) {
    if (await chartsTable.softDelete(id)) deleted++;
  }
  return { deleted };
};
