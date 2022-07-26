import { Transaction, Account, MaskedUser } from "server";
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
 * @returns A promise to be an Elasticsearch result object
 */
export const updateTransaction = async (
  transaction: Partial<Transaction> & {
    transaction_id: string;
  }
) => {
  const { transaction_id } = transaction;

  type UpdatedTransaction = Omit<Transaction, "transaction_id"> & {
    transaction_id?: string;
  };
  const updatedTransaction = { ...transaction } as UpdatedTransaction;
  delete updatedTransaction.transaction_id;

  const response = await client.update({
    index,
    id: transaction_id,
    doc: { transaction: updatedTransaction },
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
 * @returns A promise to be an Elasticsearch result object
 */
export const updateAccount = async (
  account: Partial<Account> & {
    account_id: string;
  }
) => {
  const { account_id } = account;

  type UpdatedAccount = Omit<Account, "account_id"> & { account_id?: string };
  const updatedAccount = { ...account } as UpdatedAccount;
  delete updatedAccount.account_id;

  const response = await client.update({
    index,
    id: account_id,
    doc: { account: updatedAccount },
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
