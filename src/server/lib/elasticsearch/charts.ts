import { MaskedUser } from "server";
import { ChartType, JSONBalanceChartConfiguration, JSONChart } from "common";
import { client } from "./client";
import { getUpdateChartScript } from "./scripts";
import { index } from ".";

/**
 * Creates a document that represents a chart.
 * @param user
 * @returns A promise to be an Elasticsearch response object
 */
export const createChart = async (user: MaskedUser) => {
  const { user_id } = user;

  type UnindexedChart = Omit<JSONChart, "chart_id">;
  const defaultChartConfiguration: JSONBalanceChartConfiguration = {
    account_ids: [],
    budget_ids: [],
  };
  const chart: UnindexedChart = {
    name: "Unnamed",
    type: ChartType.BALANCE,
    configuration: JSON.stringify(defaultChartConfiguration),
  };

  const updated = new Date().toISOString();

  const response = await client.index({
    index,
    document: { type: "chart", updated, user: { user_id }, chart },
  });

  return response;
};

export type PartialChart = { chart_id: string } & Partial<JSONChart>;

/**
 * Updates chart document with given object.
 * @param user
 * @param chart
 * @returns A promise to be an Elasticsearch response object
 */
export const updateChart = async (user: MaskedUser, chart: PartialChart) => {
  if (chart.configuration) {
    const { chart_id, configuration } = chart;
    const configString = configuration && JSON.stringify(configuration);
    const script = getUpdateChartScript(user, { ...chart, configuration: configString });
    return client.update({ index, id: chart_id, script });
  } else {
    const { chart_id } = chart;
    const script = getUpdateChartScript(user, chart as Partial<JSONChart>);
    return client.update({ index, id: chart_id, script });
  }
};

/**
 * Deletes chart document with given id.
 * @param user
 * @param chart_id
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteChart = async (user: MaskedUser, chart_id: string) => {
  if (!chart_id) return;

  const { user_id } = user;

  const response = await client.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          { term: { type: "chart" } },
          { term: { _id: chart_id } },
        ],
      },
    },
  });

  return response;
};

/**
 * Searches for charts associated with given user.
 * @param user
 * @returns A promise to be an array of chart objects
 */
export const searchCharts = async (user: MaskedUser) => {
  const response = await client.search<{
    type: string;
    chart?: JSONChart;
  }>({
    index,
    from: 0,
    size: 10000,
    query: {
      bool: {
        filter: [{ term: { "user.user_id": user.user_id } }, { term: { type: "chart" } }],
      },
    },
  });

  return response.hits.hits
    .map((e) => {
      const source = e._source;
      const id = e._id;
      if (!source) return;
      if (source.type === "chart" && source.chart) {
        return { ...source.chart, chart_id: id };
      }
    })
    .filter((e): e is JSONChart => !!e);
};
