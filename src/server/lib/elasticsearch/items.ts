import { PlaidError } from "plaid";
import { elasticsearchClient, index } from "./client";
import { MaskedUser } from "./users";

export interface Item {
  item_id: string;
  access_token: string;
  institution_id: string;
  cursor?: string;
  plaidError?: PlaidError;
}

/**
 * Adds an item to an indexed user object.
 * @param user
 * @param item
 * @returns A promise to be an Elasticsearch response object
 */
export const indexItem = (user: MaskedUser, item: Item) => {
  const { user_id } = user;

  return elasticsearchClient.index({
    index,
    id: item.item_id,
    document: {
      type: "item",
      user: { user_id },
      item,
    },
  });
};

/**
 * Update items of given user, specifically each item's cursor.
 * Cursor is used to mark where last synced with Plaid API.
 * @param user
 * @param items
 * @returns A promise to be an Elasticsearch response object
 */
export const updateItems = async (user: MaskedUser, items: Item[]) => {
  if (!items || !items.length) return [];
  const { user_id } = user;

  const operations = items.flatMap((item) => {
    const { item_id, cursor } = item;
    const source = `
  if (ctx._source.user.user_id == "${user_id}") {
    if (ctx._source.type == "item") {
      ctx._source.item.cursor = "${cursor}";
    } else {
      throw new Exception("Found document is not transaction type.");
    }
  } else {
    throw new Exception("Request user doesn't have permission for this document.");
  }
  `;
    return [
      { update: { _index: index, _id: item_id } },
      { script: { source, lang: "painless" } },
    ];
  });

  const response = await elasticsearchClient.bulk({ operations });

  return response.items.map((e) => e.update);
};
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
