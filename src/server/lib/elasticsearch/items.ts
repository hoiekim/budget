import { PlaidError } from "plaid";
import { elasticsearchClient, index } from "./client";
import { MaskedUser } from "./users";
import { getUpdateItemScript } from "./util";

export interface Item {
  item_id: string;
  access_token: string;
  institution_id: string;
  cursor?: string;
  plaidError?: PlaidError;
  /**
   * Timestamp in ISO format.
   */
  updated?: string;
}

/**
 * Updates or inserts items documents associated with given user.
 * @param user
 * @param items
 * @param upsert
 * @returns A promise to be an array of Elasticsearch bulk response objects
 */
export const upsertItems = async (
  user: MaskedUser,
  items: PartialItem[],
  upsert: boolean = true
) => {
  if (!items.length) return [];
  const { user_id } = user;

  const operations = items.flatMap((item) => {
    const { item_id } = item;

    const bulkHead = { update: { _index: index, _id: item_id } };

    const omittedItem = { ...item };
    delete omittedItem.plaidError;
    const source = getUpdateItemScript(user, omittedItem);
    const bulkBody: any = { script: { source, lang: "painless" } };

    if (upsert) {
      bulkBody.upsert = { type: "item", user: { user_id }, item };
    }

    return [bulkHead, bulkBody];
  });

  const response = await elasticsearchClient.bulk({ operations });

  return response.items;
};

export type PartialItem = { item_id: string } & Partial<Item>;

/**
 * Searches for items associated with given user.
 * @param user
 * @returns A promise to be an array of Item objects
 */
export const searchItems = async (user: MaskedUser) => {
  const { user_id } = user;

  const response = await elasticsearchClient.search<{ item: Item }>({
    index,
    from: 0,
    size: 10000,
    query: {
      bool: {
        filter: [{ term: { "user.user_id": user_id } }, { term: { type: "item" } }],
      },
    },
  });

  return response.hits.hits
    .map((e) => {
      const source = e._source;
      if (!source) return;
      return { ...source.item, item_id: e._id };
    })
    .filter((e) => e) as Item[];
};

/**
 * Delete an item with given item_id.
 * @param user
 * @param item_id
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteItem = async (user: MaskedUser, item_id: string) => {
  const { user_id } = user;

  const itemJob = elasticsearchClient.deleteByQuery({
    index,
    query: {
      bool: {
        filter: [
          { term: { "user.user_id": user_id } },
          { term: { type: "item" } },
          { term: { _id: item_id } },
        ],
      },
    },
  });

  const otherJob = elasticsearchClient
    .search({
      index,
      query: {
        bool: {
          filter: [
            { term: { "user.user_id": user_id } },
            { term: { type: "account" } },
            { term: { "account.item_id": item_id } },
          ],
        },
      },
    })
    .then((r) => {
      const account_ids = r.hits.hits.map((e) => e._id);
      return elasticsearchClient.deleteByQuery({
        index,
        query: {
          bool: {
            should: account_ids.flatMap((account_id) => [
              { term: { _id: account_id } },
              { term: { "transaction.account_id": account_id } },
            ]),
          },
        },
      });
    });

  return Promise.all([itemJob, otherJob]);
};
