import { Client, ClientOptions } from "@elastic/elasticsearch";
import mappings from "./mappings.json";

const {
  ELASTICSEARCH_HOST: node,
  ELASTICSEARCH_USERNAME: username,
  ELASTICSEARCH_PASSWORD: password,
} = process.env;

let auth: ClientOptions["auth"] = undefined;
if (username && password) auth = { username, password };

export const elasticsearchClient = new Client({ node, auth });

export const { version }: any = mappings;
export const index = "budget" + (version ? `-${version}` : "");
