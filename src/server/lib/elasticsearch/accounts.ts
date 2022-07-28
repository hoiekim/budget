import { Transaction, Account, MaskedUser, flattenAllAddresses } from "server";
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
      {
        index: {
          _index: index,
          _id: transaction.transaction_id,
        },
      },
      {
        type: "transaction",
        user: { user_id },
        transaction,
      },
    ];
  });

  const response = await client.bulk({ operations });

  return response.items.map((e) => e.index);
};

/**
 * Updates transaction document with given object.
 * @param transaction
 * @returns A promise to be an Elasticsearch response object
 */
export const updateTransaction = async (
  user: MaskedUser,
  transaction: Partial<Transaction> & {
    transaction_id: string;
  }
) => {
  const { user_id } = user;
  const { transaction_id } = transaction;

  const source = `
  if (ctx._source.user.user_id == "${user_id}") {
    if (ctx._source.type == "transaction") {
      ${Object.entries(transaction).reduce((acc, [key, value]) => {
        if (key === "transaction_id") return acc;
        if (key === "category") key = "plaid_category";
        if (key === "category_id") key = "plaid_category_id";
        return acc + `ctx._source.transaction.${key} = ${JSON.stringify(value)};\n`;
      }, "")}
    } else {
      throw new Exception("Found document is not transaction type.");
    }
  } else {
    throw new Exception("Request user doesn't have permission for this document.");
  }
  `;

  const response = await client.update({
    index,
    id: transaction_id,
    script: { source, lang: "painless" },
  });

  return response;
};

/**
 * Searches for transactions associated with given user.
 * @param user
 * @returns A promise to be an array of Transaction objects
 */
export const searchTransactions = async (user: MaskedUser) => {
  const response = await client.search<{ transaction: Transaction }>({
    index,
    from: 0,
    size: 10000,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user.user_id } },
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
 * Creates accounts documents associated with given user.
 * @param user
 * @param accounts
 * @returns A promise to be an array of Elasticsearch bulk response objects
 */
export const indexAccounts = async (user: MaskedUser, accounts: Account[]) => {
  if (!accounts.length) return [];

  const { user_id } = user;

  const operations = accounts.flatMap((account) => {
    return [
      {
        index: {
          _index: index,
          _id: account.account_id,
        },
      },
      {
        type: "account",
        user: { user_id },
        account,
      },
    ];
  });

  const response = await client.bulk({ operations });

  return response.items.map((e) => e.index);
};

/**
 * Updates account document with given object.
 * @param account
 * @returns A promise to be an Elasticsearch response object
 */
export const updateAccount = async (
  user: MaskedUser,
  account: Partial<Account> & {
    account_id: string;
  }
) => {
  const { user_id } = user;
  const { account_id } = account;

  const source = `
  if (ctx._source.user.user_id == "${user_id}") {
    if (ctx._source.type == "account") {
      ${Object.entries(flattenAllAddresses(account)).reduce((acc, [key, value]) => {
        if (key === "account_id") return acc;
        return acc + `ctx._source.account.${key} = ${JSON.stringify(value)};\n`;
      }, "")}
    } else {
      throw new Exception("Found document is not account type.");
    }
  } else {
    throw new Exception("Request user doesn't have permission for this document.");
  }
  `;

  const response = await client.update({
    index,
    id: account_id,
    script: { source, lang: "painless" },
  });

  return response;
};

/**
 * Searches for accounts associated with given user.
 * @param user
 * @returns A promise to be an array of Account objects
 */
export const searchAccounts = async (user: MaskedUser) => {
  const response = await client.search<{ account: Account }>({
    index,
    from: 0,
    size: 10000,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user.user_id } },
          { term: { type: "account" } },
        ],
      },
    },
  });

  return response.hits.hits
    .map((e) => {
      const source = e._source;
      if (!source) return;
      return { ...source.account, account_id: e._id };
    })
    .filter((e) => e) as Account[];
};
