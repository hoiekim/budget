import { Account, getUpdateAccountScript } from "server";
import { elasticsearchClient, index } from "./client";
import { MaskedUser } from "./users";

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
      { index: { _index: index, _id: account.account_id } },
      { type: "account", user: { user_id }, account },
    ];
  });

  const response = await elasticsearchClient.bulk({ operations });

  return response.items.map((e) => e.index);
};

export type PartialAccount = { account_id: string } & Partial<Account>;

/**
 * Updates account document with given object.
 * @param user
 * @param accounts
 * @returns A promise to be an Elasticsearch response object
 */
export const updateAccounts = async (user: MaskedUser, accounts: PartialAccount[]) => {
  if (!accounts || !accounts.length) return [];

  const operations = accounts.flatMap((account) => {
    const { account_id } = account;

    const source = getUpdateAccountScript(user, account);

    return [
      { update: { _index: index, _id: account_id } },
      { script: { source, lang: "painless" } },
    ];
  });

  const response = await elasticsearchClient.bulk({ operations });

  return response.items;
};

/**
 * Searches for accounts associated with given user.
 * @param user_id
 * @returns A promise to be an array of Account objects
 */
export const searchAccounts = async (user: MaskedUser) => {
  const { user_id } = user;

  const response = await elasticsearchClient.search<{ account: Account }>({
    index,
    from: 0,
    size: 10000,
    query: {
      bool: {
        filter: [{ term: { "user.user_id": user_id } }, { term: { type: "account" } }],
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

interface RemovedAccount {
  account_id: string;
}

/**
 * Deletes accounts by account_id in given accounts data.
 * @param user
 * @param accounts
 * @returns A promise to be an array of Account objects
 */
export const deleteAccounts = async (
  user: MaskedUser,
  accounts: (Account | RemovedAccount)[]
) => {
  if (!Array.isArray(accounts) || !accounts.length) return;
  const { user_id } = user;

  const response = await elasticsearchClient.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          { term: { type: "account" } },
          {
            bool: {
              should: accounts.map((e) => ({ term: { _id: e.account_id } })),
            },
          },
        ],
      },
    },
  });

  return response;
};
