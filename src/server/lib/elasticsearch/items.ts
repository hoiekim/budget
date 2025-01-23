import { Item, ItemStatus } from "common";
import { elasticsearchClient, index } from "./client";
import { MaskedUser, searchUser } from "./users";
import { getUpdateItemScript } from "./util";

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
    const script = getUpdateItemScript(user, omittedItem);
    const bulkBody: any = { script };

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
export const searchItems = async (user?: MaskedUser) => {
  const { user_id } = user || {};

  const filter: any[] = [{ term: { type: "item" } }];
  if (user_id) filter.push({ term: { "user.user_id": user_id } });

  const response = await elasticsearchClient.search<{ item: Item }>({
    index,
    from: 0,
    size: 10000,
    query: { bool: { filter } },
  });

  return response.hits.hits
    .map((e) => {
      const source = e._source;
      if (!source) return null;
      return { ...source.item, item_id: e._id };
    })
    .filter((e) => e) as Item[];
};

/**
 * Gets item associated with given item_id.
 * @param item_id
 * @returns A promise to be an Item object
 */
export const getItem = async (item_id: string) => {
  const response = await elasticsearchClient.get<{ item: Item }>({ index, id: item_id });
  return response._source?.item;
};

export const updateItemStatus = async (item_id: string, status: ItemStatus) => {
  type ItemDoc = { item: Item; user: { user_id: string } };
  const response = await elasticsearchClient.get<ItemDoc>({ index, id: item_id });
  const itemDoc = response._source;
  if (!itemDoc) return;
  const { user_id } = itemDoc.user;
  const foundUser = await searchUser({ user_id });
  if (!foundUser) return;
  return await upsertItems(foundUser, [{ item_id, status }]);
};

export const getUserItem = async (item_id: string) => {
  type ItemDoc = { item: Item; user: { user_id: string } };
  const response = await elasticsearchClient.get<ItemDoc>({ index, id: item_id });
  const itemDoc = response._source;
  if (!itemDoc) return;
  const { item, user } = itemDoc;
  const foundUser = await searchUser({ user_id: user.user_id });
  if (!foundUser) return;
  return { user: foundUser, item };
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
              { term: { "investment_transaction.account_id": account_id } },
            ]),
          },
        },
      });
    });

  return Promise.all([itemJob, otherJob]);
};
