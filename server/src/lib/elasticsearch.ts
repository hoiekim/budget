import { Client } from "@elastic/elasticsearch";
import { Transaction } from "plaid";
import { Item } from "lib";

const client = new Client({ node: "https://localhost:9200" });

const index = "budget";

export const initializeIndex = async () => {
  const properties: any = {
    type: { type: "keyword" },
    user: {
      type: "object",
      properties: {
        username: { type: "keyword" },
        email: { type: "keyword" },
        expiry: { type: "date" },
        item: { type: "keyword" },
        password: { type: "keyword" },
        token: { type: "keyword" },
      },
    },
    transactions: {
      type: "object",
      properties: {
        username: { type: "keyword" },
        email: { type: "keyword" },
        expiry: { type: "date" },
        item: { type: "keyword" },
        password: { type: "keyword" },
        token: { type: "keyword" },
      },
    },
  };

  const indexAlreadyExists = await client.indices.exists({ index });
  if (indexAlreadyExists) {
    const response = await client.indices.putMapping({
      index,
      properties,
    });
    return response.acknowledged;
  }

  const response = await client.indices.create({
    index,
    mappings: { properties },
  });
  return response.index;
};

export const findUser = async (username: string) => {
  const response = await client.search({
    index,
    query: { match: { username } },
  });
  return response.hits.hits;
};

export const addItem = async (user_id: string, item: Item) => {
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

export const addTransactions = async (
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

export const getTransactions = async (user_id: string) => {
  const response = await client.search({
    index: "transactions",
    query: { match: { user_id } },
  });
  return response.hits.hits;
};
