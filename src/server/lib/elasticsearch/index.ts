/**
 * https://www.elastic.co/guide/en/elasticsearch/reference/current/quickstart.html
 */

import mappings from "./mappings.json";

export const { version }: any = mappings;
export const index = "budget" + (version ? `-${version}` : "");

export * from "./accounts";
export * from "./budgets";
export * from "./users";
export * from "./initialize";
export * from "./session";
export * from "./transactions";
export * from "./items";
export * from "./snapshots";
export * from "./charts";
