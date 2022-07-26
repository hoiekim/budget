import { Client } from "@elastic/elasticsearch";
import mappings from "./mappings.json";

export const client = new Client({ node: process.env.ELASTICSEARCH_HOST });

const { version }: any = mappings;
export const index = "budget" + (version ? `-${version}` : "");
