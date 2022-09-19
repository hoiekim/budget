import { Client } from "@elastic/elasticsearch";
import mappings from "./mappings.json";

export const elasticsearchClient = new Client({ node: process.env.ELASTICSEARCH_HOST });

export const { version }: any = mappings;
export const index = "budget" + (version ? `-${version}` : "");
