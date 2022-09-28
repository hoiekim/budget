import {
  Account,
  Holding,
  Security,
  getUpdateAccountScript,
  getUpdateHoldingScript,
  getUpdateSecurityScript,
} from "server";
import { elasticsearchClient, index } from "./client";
import { MaskedUser } from "./users";

export type PartialAccount = { account_id: string } & Partial<Account>;

/**
 * Updates or inserts accounts documents associated with given user.
 * @param user
 * @param accounts
 * @param upsert
 * @returns A promise to be an array of Elasticsearch bulk response objects
 */
export const upsertAccounts = async (
  user: MaskedUser,
  accounts: PartialAccount[],
  upsert: boolean = true
) => {
  if (!accounts.length) return [];
  const { user_id } = user;

  const operations = accounts.flatMap((account) => {
    const { account_id } = account;

    const bulkHead = { update: { _index: index, _id: account_id } };

    const source = getUpdateAccountScript(user, account);
    const bulkBody: any = { script: { source, lang: "painless" } };

    if (upsert) {
      bulkBody.upsert = { type: "account", user: { user_id }, account };
    }

    return [bulkHead, bulkBody];
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

  const response = await elasticsearchClient.search<{
    account: Account;
    holding: Holding;
    security: Security;
  }>({
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
                { term: { type: "account" } },
                { term: { type: "holding" } },
                { term: { type: "security" } },
              ],
            },
          },
        ],
      },
    },
  });

  type Result = {
    accounts: Account[];
    holdings: Holding[];
    securities: Security[];
  };

  const result: Result = {
    accounts: [],
    holdings: [],
    securities: [],
  };

  response.hits.hits.forEach((e) => {
    const source = e._source;
    if (!source) return;
    const { account, holding, security } = source;
    if (account) result.accounts.push(account);
    if (holding) result.holdings.push(holding);
    if (security) result.securities.push(security);
  });

  return result;
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

export type PartialHolding = { holding_id: string } & Partial<Holding>;

export const upsertHoldings = async (
  user: MaskedUser,
  holdings: PartialHolding[],
  upsert: boolean = true
) => {
  if (!holdings.length) return [];
  const { user_id } = user;

  const operations = holdings.flatMap((holding) => {
    const { holding_id } = holding;

    const bulkHead = { update: { _index: index, _id: holding_id } };

    const source = getUpdateHoldingScript(user, holding);
    const bulkBody: any = { script: { source, lang: "painless" } };

    if (upsert) {
      bulkBody.upsert = { type: "holding", user: { user_id }, holding };
    }

    return [bulkHead, bulkBody];
  });

  const response = await elasticsearchClient.bulk({ operations });

  return response.items;
};

export type PartialSecurity = { security_id: string } & Partial<Security>;

export const upsertSecurities = async (
  user: MaskedUser,
  securities: PartialSecurity[],
  upsert: boolean = true
) => {
  if (!securities.length) return [];
  const { user_id } = user;

  const operations = securities.flatMap((security) => {
    const { security_id } = security;

    const bulkHead = { update: { _index: index, _id: security_id } };

    const source = getUpdateSecurityScript(user, security);
    const bulkBody: any = { script: { source, lang: "painless" } };

    if (upsert) {
      bulkBody.upsert = { type: "security", user: { user_id }, security };
    }

    return [bulkHead, bulkBody];
  });

  const response = await elasticsearchClient.bulk({ operations });

  return response.items;
};
