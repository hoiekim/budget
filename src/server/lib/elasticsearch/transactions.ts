import {
  Transaction,
  RemovedTransaction,
  InvestmentTransaction,
  RemovedInvestmentTransaction,
  SplitTransaction,
  RemovedSplitTransaction,
} from "common";
import {
  MaskedUser,
  getUpdateTransactionScript,
  getUpdateInvestmentTransactionScript,
  getUpdateSplitTransactionScript,
} from "server";
import { elasticsearchClient, index } from "./client";

export type PartialTransaction = { transaction_id: string } & Partial<Transaction>;

/**
 * Updates or inserts transactions documents associated with given user.
 * @param user
 * @param transactions
 * @param upsert
 * @returns A promise to be an array of Elasticsearch bulk response objects
 */
export const upsertTransactions = async (
  user: MaskedUser,
  transactions: PartialTransaction[],
  upsert: boolean = true
) => {
  if (!transactions.length) return [];
  const { user_id } = user;

  const operations = transactions.flatMap((transaction) => {
    const { transaction_id } = transaction;

    const bulkHead = { update: { _index: index, _id: transaction_id } };

    const script = getUpdateTransactionScript(user, transaction);
    const bulkBody: any = { script };

    if (upsert) {
      bulkBody.upsert = { type: "transaction", user: { user_id }, transaction };
    }

    return [bulkHead, bulkBody];
  });

  const response = await elasticsearchClient.bulk({ operations });

  return response.items;
};

/**
 * Searches for transactions associated with given user.
 * @param user
 * @returns A promise to be an array of Transaction objects
 */
export const searchTransactions = async (user: MaskedUser) => {
  const { user_id } = user;

  type Response = {
    transaction: Transaction;
    investment_transaction: InvestmentTransaction;
    split_transaction: SplitTransaction;
  };

  const response = await elasticsearchClient.search<Response>({
    index,
    from: 0,
    size: 10000,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          {
            bool: {
              should: [
                { term: { type: "transaction" } },
                { term: { type: "investment_transaction" } },
                { term: { type: "split_transaction" } },
              ],
            },
          },
        ],
      },
    },
  });

  type Result = {
    transactions: Transaction[];
    investment_transactions: InvestmentTransaction[];
    split_transactions: SplitTransaction[];
  };

  const result: Result = {
    transactions: [],
    investment_transactions: [],
    split_transactions: [],
  };

  response.hits.hits.forEach((e) => {
    const source = e._source;
    if (!source) return;
    const { transaction, investment_transaction, split_transaction } = source;
    if (transaction) result.transactions.push(transaction);
    else if (investment_transaction) {
      result.investment_transactions.push(investment_transaction);
    } else if (split_transaction) {
      result.split_transactions.push(split_transaction);
    }
  });

  return result;
};

/**
 * Deletes transactions by transaction_id in given transactions data.
 * @param user
 * @param transactions
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteTransactions = async (
  user: MaskedUser,
  transactions: (Transaction | RemovedTransaction)[]
) => {
  if (!Array.isArray(transactions) || !transactions.length) return;
  const { user_id } = user;

  const response = await elasticsearchClient.deleteByQuery({
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

export type PartialInvestmentTransaction = {
  investment_transaction_id: string;
} & Partial<InvestmentTransaction>;

/**
 * Updates or inserts investment transactions with given data.
 * @param user
 * @param investment_transactions
 * @returns A promise to be an array of Elasticsearch bulk response objects
 */
export const upsertInvestmentTransactions = async (
  user: MaskedUser,
  investment_transactions: PartialInvestmentTransaction[],
  upsert: boolean = true
) => {
  if (!investment_transactions.length) return [];
  const { user_id } = user;

  const operations = investment_transactions.flatMap((investment_transaction) => {
    const { investment_transaction_id } = investment_transaction;

    const bulkHead = { update: { _index: index, _id: investment_transaction_id } };

    const script = getUpdateInvestmentTransactionScript(user, investment_transaction);
    const bulkBody: any = { script };

    if (upsert) {
      bulkBody.upsert = {
        type: "investment_transaction",
        user: { user_id },
        investment_transaction,
      };
    }

    return [bulkHead, bulkBody];
  });

  const response = await elasticsearchClient.bulk({ operations });

  return response.items;
};

/**
 * Deletes investment transactions by id in given data.
 * @param user
 * @param investment_transactions
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteInvestmentTransactions = async (
  user: MaskedUser,
  investment_transactions: (InvestmentTransaction | RemovedInvestmentTransaction)[]
) => {
  if (!Array.isArray(investment_transactions) || !investment_transactions.length) return;
  const { user_id } = user;

  const response = await elasticsearchClient.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          { term: { type: "investment_transaction" } },
          {
            bool: {
              should: investment_transactions.map((e) => ({
                term: { _id: e.investment_transaction_id },
              })),
            },
          },
        ],
      },
    },
  });

  return response;
};

export type PartialSplitTransaction = { split_transaction_id: string } & Partial<SplitTransaction>;

/**
 * Updates or inserts split transactions documents associated with given user.
 * @param user
 * @param splitTransactions
 * @param upsert
 * @returns A promise to be an array of Elasticsearch bulk response objects
 */
export const upsertSplitTransactions = async (
  user: MaskedUser,
  splitTransactions: PartialSplitTransaction[],
  upsert: boolean = true
) => {
  if (!splitTransactions.length) return [];
  const { user_id } = user;

  const operations = splitTransactions.flatMap((splitTransaction) => {
    const { split_transaction_id } = splitTransaction;

    const bulkHead = { update: { _index: index, _id: split_transaction_id } };

    const script = getUpdateSplitTransactionScript(user, splitTransaction);
    const bulkBody: any = { script };

    if (upsert) {
      bulkBody.upsert = {
        type: "split_transaction",
        user: { user_id },
        transaction: splitTransaction,
      };
    }

    return [bulkHead, bulkBody];
  });

  const response = await elasticsearchClient.bulk({ operations });

  return response.items;
};

/**
 * Deletes split transactions by id in given data.
 * @param user
 * @param split_transactions
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteSplitTransactions = async (
  user: MaskedUser,
  split_transactions: (SplitTransaction | RemovedSplitTransaction)[]
) => {
  if (!Array.isArray(split_transactions) || !split_transactions.length) return;
  const { user_id } = user;

  const response = await elasticsearchClient.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          { term: { type: "split_transaction" } },
          {
            bool: {
              should: split_transactions.map((e) => ({
                term: { _id: e.split_transaction_id },
              })),
            },
          },
        ],
      },
    },
  });

  return response;
};
