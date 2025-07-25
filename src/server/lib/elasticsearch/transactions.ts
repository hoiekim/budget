import {
  Transaction,
  RemovedTransaction,
  InvestmentTransaction,
  RemovedInvestmentTransaction,
  SplitTransaction,
  RemovedSplitTransaction,
  DeepPartial,
} from "common";
import { MaskedUser, flatten } from "server";
import { client } from "./client";
import {
  getUpdateTransactionScript,
  getUpdateInvestmentTransactionScript,
  getUpdateSplitTransactionScript,
} from "./scripts";
import { index } from ".";

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
      const updated = new Date().toISOString();
      bulkBody.upsert = { type: "transaction", updated, user: { user_id }, transaction };
    }

    return [bulkHead, bulkBody];
  });

  const response = await client.bulk({ operations });

  return response.items;
};

export interface SearchTransactionsOptions {
  range?: DateRange;
  query?: DeepPartial<Transaction>;
}

interface DateRange {
  start: Date;
  end: Date;
}

const transactionTypes = ["transaction", "investment_transaction"];

/**
 * Searches for transactions associated with given user.
 * @param user
 * @param options (optional)
 * @returns A promise to have arrays of Transaction objects
 */
export const searchTransactions = async (user: MaskedUser, options?: SearchTransactionsOptions) => {
  const { user_id } = user;
  const { range, query } = options || {};
  const { start, end } = range || {};
  const isValidRange = start && end && start < end;

  type Response = {
    transaction: Transaction;
    investment_transaction: InvestmentTransaction;
  };

  const filter: any[] = [
    { term: { "user.user_id": user_id } },
    { bool: { should: transactionTypes.map((type) => ({ term: { type } })) } },
  ];

  if (isValidRange) {
    filter.push({
      bool: {
        filter: [
          { range: { updated: { gte: start.toISOString() } } },
          { range: { updated: { lt: end.toISOString() } } },
        ],
      },
    });
  }

  if (query) {
    filter.push(
      ...Object.entries(flatten(query)).map(([key, value]) => {
        const should = transactionTypes.map((type) => ({ term: { [`${type}.${key}`]: value } }));
        return { bool: { should } };
      })
    );
  }

  const response = await client.search<Response>({
    index,
    from: 0,
    size: 10000,
    query: { bool: { filter } },
  });

  type Result = {
    transactions: Transaction[];
    investment_transactions: InvestmentTransaction[];
  };

  const result: Result = {
    transactions: [],
    investment_transactions: [],
  };

  response.hits.hits.forEach(({ _source, _id }) => {
    if (!_source) return;
    const { transaction, investment_transaction } = _source;
    if (transaction) result.transactions.push(new Transaction(transaction));
    else if (investment_transaction) {
      result.investment_transactions.push(new InvestmentTransaction(investment_transaction));
    }
  });

  return result;
};

export interface SearchSplitTransactionsOptions {
  range?: DateRange;
  query?: DeepPartial<SplitTransaction>;
}

/**
 * Searches for split transactions associated with given user.
 * @param user
 * @param options (optional)
 * @returns A promise to have arrays of SplitTransaction objects
 */
export const searchSplitTransactions = async (
  user: MaskedUser,
  options?: SearchSplitTransactionsOptions
) => {
  const { user_id } = user;
  const { range, query } = options || {};
  const { start, end } = range || {};
  const isValidRange = start && end && start < end;

  type Response = {
    split_transaction: SplitTransaction;
  };

  const filter: any[] = [
    { term: { "user.user_id": user_id } },
    { term: { type: "split_transaction" } },
  ];

  if (isValidRange) {
    filter.push({
      bool: {
        filter: [
          { range: { updated: { gte: start.toISOString() } } },
          { range: { updated: { lt: end.toISOString() } } },
        ],
      },
    });
  }

  if (query) {
    filter.push(
      ...Object.entries(flatten(query)).map(([key, value]) => {
        return { term: { [`split_transaction.${key}`]: value } };
      })
    );
  }

  const response = await client.search<Response>({
    index,
    from: 0,
    size: 10000,
    query: { bool: { filter } },
  });

  type Result = {
    split_transactions: SplitTransaction[];
  };

  const result: Result = {
    split_transactions: [],
  };

  response.hits.hits.forEach(({ _source, _id }) => {
    if (!_source || !_id) return;
    const { split_transaction } = _source;
    if (split_transaction) {
      split_transaction.split_transaction_id = _id;
      result.split_transactions.push(new SplitTransaction(split_transaction));
    }
  });

  return result;
};

/**
 * Searches for transactions associated with given user and account id.
 * @param user
 * @param accountIds
 * @param range (optional)
 * @returns A promise to have arrays of Transaction objects
 */
export const searchTransactionsByAccountId = async (
  user: MaskedUser,
  accountIds: string[],
  range?: DateRange
) => {
  type Result = {
    transactions: Transaction[];
    investment_transactions: InvestmentTransaction[];
    split_transactions: SplitTransaction[];
  };

  if (!Array.isArray(accountIds) || !accountIds.length) {
    return {
      transactions: [],
      investment_transactions: [],
      split_transactions: [],
    };
  }

  const { user_id } = user;
  const { start, end } = range || {};
  const isValidRange = start && end && start < end;

  type Response = {
    transaction: Transaction;
    investment_transaction: InvestmentTransaction;
    split_transaction: SplitTransaction;
  };

  const filter: any[] = [
    { term: { "user.user_id": user_id } },
    { bool: { should: transactionTypes.map((type) => ({ term: { type } })) } },
    {
      bool: {
        should: transactionTypes.map((type) => {
          const should = accountIds.map((id) => ({ term: { [`${type}.account_id`]: id } }));
          return { bool: { should } };
        }),
      },
    },
  ];

  if (isValidRange) {
    filter.push({
      bool: {
        filter: [
          { range: { updated: { gte: start.toISOString() } } },
          { range: { updated: { lt: end.toISOString() } } },
        ],
      },
    });
  }

  const response = await client.search<Response>({
    index,
    from: 0,
    size: 10000,
    query: { bool: { filter } },
  });

  const result: Result = {
    transactions: [],
    investment_transactions: [],
    split_transactions: [],
  };

  response.hits.hits.forEach(({ _source, _id }) => {
    if (!_source || !_id) return;
    const { transaction, investment_transaction, split_transaction } = _source;
    if (transaction) result.transactions.push(new Transaction(transaction));
    else if (investment_transaction) {
      result.investment_transactions.push(new InvestmentTransaction(investment_transaction));
    } else if (split_transaction) {
      split_transaction.split_transaction_id = _id;
      result.split_transactions.push(new SplitTransaction(split_transaction));
    }
  });

  return result;
};

/**
 * Searches for transactions associated with given user.
 * @param user
 * @returns A promise to be an array of Transaction objects
 */
export const getOldestTransactionDate = async (user: MaskedUser) => {
  const { user_id } = user;

  const { aggregations } = await client.search({
    index,
    size: 0,
    query: { term: { "user.user_id": user_id } },
    aggs: {
      min_transaction_date: { min: { field: "transaction.date", format: "yyyy-MM-dd" } },
      min_investment_date: {
        min: { field: "investment_transaction.date", format: "yyyy-MM-dd" },
      },
    },
  });

  type MinDateAggregation = { value: number; value_as_string: string };

  const min_transaction_date = aggregations?.min_transaction_date as MinDateAggregation;
  const min_investment_date = aggregations?.min_investment_date as MinDateAggregation;

  if (min_transaction_date?.value) {
    if (min_investment_date?.value) {
      const minTime = Math.min(min_transaction_date.value, min_investment_date.value);
      return new Date(minTime);
    } else {
      return new Date(min_transaction_date.value);
    }
  } else if (min_investment_date?.value) {
    return new Date(min_investment_date.value);
  } else {
    return new Date();
  }
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
      const updated = new Date().toISOString();
      bulkBody.upsert = {
        type: "investment_transaction",
        updated,
        user: { user_id },
        investment_transaction,
      };
    }

    return [bulkHead, bulkBody];
  });

  const response = await client.bulk({ operations });

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

  const response = await client.deleteByQuery({
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

/**
 * Creates a document that represents a split transaction.
 * @param user
 * @param split_transaction_id parent transaction's id
 * @returns A promise to be an Elasticsearch response object
 */
export const createSplitTransaction = async (
  user: MaskedUser,
  transaction_id: string,
  account_id: string
) => {
  const { user_id } = user;

  type UnindexedSplitTransaction = Omit<SplitTransaction, "split_transaction_id"> & {
    split_transaction_id?: string;
  };
  const split_transaction: UnindexedSplitTransaction = new SplitTransaction({
    transaction_id,
    account_id,
  });
  delete split_transaction.split_transaction_id;

  const response = await client.index({
    index,
    document: { type: "split_transaction", user: { user_id }, split_transaction },
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
      const updated = new Date().toISOString();
      bulkBody.upsert = {
        type: "split_transaction",
        updated,
        user: { user_id },
        split_transaction: splitTransaction,
      };
    }

    return [bulkHead, bulkBody];
  });

  const response = await client.bulk({ operations });

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

  const response = await client.deleteByQuery({
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

/**
 * Deletes split transactions by id in transactionIds.
 * @param user
 * @param transactionIds
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteSplitTransactionsByTransactionId = async (
  user: MaskedUser,
  transactionIds: string[]
) => {
  if (!Array.isArray(transactionIds) || !transactionIds.length) return;
  const { user_id } = user;

  const response = await client.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          { term: { type: "split_transaction" } },
          {
            bool: {
              should: transactionIds.map((id) => ({
                term: { "split_transaction.transaction_id": id },
              })),
            },
          },
        ],
      },
    },
  });

  return response;
};

/**
 * Deletes split transactions by id in given accountIds.
 * @param user
 * @param accountIds
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteSplitTransactionsByAccountId = async (
  user: MaskedUser,
  accountIds: string[]
) => {
  if (!Array.isArray(accountIds) || !accountIds.length) return;
  const { user_id } = user;

  const response = await client.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          { term: { type: "split_transaction" } },
          {
            bool: {
              should: accountIds.map((id) => ({
                term: { "split_transaction.account_id": id },
              })),
            },
          },
        ],
      },
    },
  });

  return response;
};
