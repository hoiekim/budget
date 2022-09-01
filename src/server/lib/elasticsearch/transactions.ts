import { RemovedTransaction } from "plaid";
import { Transaction, deepFlatten, MaskedUser } from "server";
import { client, index } from "./client";

/**
 * Creates transactions documents associated with given user.
 * @param user
 * @param transactions
 * @returns A promise to be an array of Elasticsearch bulk response objects
 */
export const indexTransactions = async (
  user: MaskedUser,
  transactions: Transaction[]
) => {
  if (!transactions.length) return [];
  const { user_id } = user;

  const operations = transactions.flatMap((transaction) => {
    return [
      { index: { _index: index, _id: transaction.transaction_id } },
      { type: "transaction", user: { user_id }, transaction },
    ];
  });

  const response = await client.bulk({ operations });

  return response.items.map((e) => e.index);
};

export type PartialTransaction = { transaction_id: string } & Partial<Transaction>;

/**
 * Updates transaction document with given object.
 * @param user
 * @param transactions
 * @returns A promise to be an Elasticsearch response object
 */
export const updateTransactions = async (
  user: MaskedUser,
  transactions: PartialTransaction[]
) => {
  if (!transactions || !transactions.length) return [];
  const { user_id } = user;

  const operations = transactions.flatMap((transaction) => {
    const { transaction_id } = transaction;

    const source = `
  if (ctx._source.user.user_id == "${user_id}") {
    if (ctx._source.type == "transaction") {
      ${Object.entries(deepFlatten(transaction)).reduce((acc, [key, value]) => {
        if (key === "transaction_id") return acc;
        return acc + `ctx._source.transaction.${key} = ${JSON.stringify(value)};\n`;
      }, "")}
    } else {
      throw new Exception("Found document is not transaction type.");
    }
  } else {
    throw new Exception("Request user doesn't have permission for this document.");
  }
  `;

    return [
      { update: { _index: index, _id: transaction_id } },
      { script: { source, lang: "painless" } },
    ];
  });

  const response = await client.bulk({ operations });

  return response.items;
};

/**
 * Searches for transactions associated with given user.
 * @param user
 * @returns A promise to be an array of Transaction objects
 */
export const searchTransactions = async (user: MaskedUser) => {
  const { user_id } = user;

  const response = await client.search<{ transaction: Transaction }>({
    index,
    from: 0,
    size: 10000,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          { term: { type: "transaction" } },
        ],
      },
    },
  });

  return response.hits.hits
    .map((e) => {
      const source = e._source;
      if (!source) return;
      return { ...source.transaction, transaction_id: e._id };
    })
    .filter((e) => e) as Transaction[];
};

/**
 * Deletes transactions by transaction_id in given transactions data.
 * @param user
 * @param transactions
 * @returns A promise to be an array of Account objects
 */
export const deleteTransactions = async (
  user: MaskedUser,
  transactions: (Transaction | RemovedTransaction)[]
) => {
  if (!Array.isArray(transactions) || !transactions.length) return;
  const { user_id } = user;

  const response = await client.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          { term: { type: "transaction" } },
          {
            bool: {
              should: transactions.map((e) => ({ term: { _id: e.transaction_id } })),
            },
          },
        ],
      },
    },
  });

  return response;
};
