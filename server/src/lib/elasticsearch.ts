import { Client } from "@elastic/elasticsearch";
import { Transaction } from "plaid";
import { Item } from "lib/plaid";
import mappings from "./mappings.json"

const client = new Client({ node: "https://localhost:9200" });

const index = "budget";
const { properties }: any = mappings

export const initializeIndex = async () => {
  const indexAlreadyExists = await client.indices.exists({ index });
  if (indexAlreadyExists) {
    console.info("Existing Elasticsearch index is found.")
    const response = await client.indices.putMapping({
      index,
      properties,
    });

    if ((response as any).error) {
      throw new Error("Failed to setup mappings for Elasticsearch index.")
    }

    console.info("Successfully setup mappings for Elasticsearch index.")
    return response.acknowledged;
  }

  const response = await client.indices.create({
    index,
    mappings: { properties },
  });

  if ((response as any).error) {
    throw new Error("Failed to create Elasticsearch index.")
  }

  console.info("Successfully created Elasticsearch index.")
  return response.index;
};

export const searchUser = async (username: string) => {
  const response = await client.search({
    index,
    query: { match: { username } },
  });
  return response.hits.hits;
};

export const indexItem = async (user_id: string, item: Item) => {
  const { id, token } = item;
  const response = await client.update({
    index,
    id: user_id,
    script: {
      source: "ctx._source.item.add(params.val)",
      lang: "painless",
      params: { val: { id, token } },
    },
  });
  return response.result;
};

export const indexTransactions = async (
  user_id: string,
  transactions: Transaction[]
) => {
  const operations = transactions.map((transaction) => {
    return {
      index: {
        _index: "transactions",
        _id: transaction.transaction_id,
        ...transaction,
        user_id,
      },
    };
  });
  const response = await client.bulk({ operations });
  return response.items;
};

export const searchTransactions = async (user_id: string) => {
  const response = await client.search({
    index: "transactions",
    query: { match: { user_id } },
  });
  return response.hits.hits;
};
