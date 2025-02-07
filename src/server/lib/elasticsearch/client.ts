import { Client, ClientOptions } from "@elastic/elasticsearch";

const {
  ELASTICSEARCH_HOST: node,
  ELASTICSEARCH_USERNAME: username,
  ELASTICSEARCH_PASSWORD: password,
} = process.env;

let auth: ClientOptions["auth"] = undefined;
if (username && password) auth = { username, password };

export const client = new Client({ node, auth });
