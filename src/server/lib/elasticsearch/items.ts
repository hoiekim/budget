import { Item, ItemStatus } from "common";
import { client } from "./client";
import { MaskedUser, searchUser, User } from "./users";
import { getUpdateItemScript } from "./scripts";
import { index } from ".";

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
      const updated = new Date().toISOString();
      bulkBody.upsert = { type: "item", updated, user: { user_id }, item };
    }

    return [bulkHead, bulkBody];
  });

  const response = await client.bulk({ operations });

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

  const response = await client.search<{ item: Item }>({
    index,
    from: 0,
    size: 10000,
    query: { bool: { filter } },
  });

  return response.hits.hits
    .map((e) => {
      const source = e._source;
      if (!source) return null;
      return new Item({ ...source.item, item_id: e._id });
    })
    .filter((e): e is Item => !!e);
};

/**
 * Gets item associated with given item_id.
 * @param item_id
 * @returns A promise to be an Item object
 */
export const getItem = async (item_id: string) => {
  const response = await client.get<{ item: Item }>({ index, id: item_id });
  const item = response._source?.item;
  if (!item) return;
  return new Item(item);
};

export const updateItemStatus = async (item_id: string, status: ItemStatus) => {
  type ItemDoc = { item: Item; user: { user_id: string } };
  const response = await client.get<ItemDoc>({ index, id: item_id });
  const itemDoc = response._source;
  if (!itemDoc) return;
  const { user_id } = itemDoc.user;
  const foundUser = await searchUser({ user_id });
  if (!foundUser) return;
  return await upsertItems(foundUser, [{ item_id, status }]);
};

export const getUserItem = async (
  item_id: string
): Promise<{ user: User; item: Item } | undefined> => {
  type ItemDoc = { item: Item; user: { user_id: string } };
  const response = await client.get<ItemDoc>({ index, id: item_id });
  const itemDoc = response._source;
  if (!itemDoc) return;
  const { item, user } = itemDoc;
  const foundUser = await searchUser({ user_id: user.user_id });
  if (!foundUser) return;
  return { user: foundUser, item: new Item(item) };
};

/**
 * Delete an item with given item_id.
 * @param user
 * @param item_id
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteItem = async (user: MaskedUser, item_id: string) => {
  const { user_id } = user;

  const itemJob = client.deleteByQuery({
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

  const otherJob = client
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
      const accountIds = r.hits.hits.map((e) => e._id);
      if (!accountIds.length) return;
      return client.deleteByQuery({
        index,
        query: {
          bool: {
            should: accountIds.flatMap((account_id) => [
              { term: { _id: account_id } },
              { term: { "account.account_id": account_id } },
              { term: { "holding.account_id": account_id } },
              { term: { "transaction.account_id": account_id } },
              { term: { "split_transaction.account_id": account_id } },
              { term: { "investment_transaction.account_id": account_id } },
            ]),
          },
        },
      });
    });

  return Promise.all([itemJob, otherJob]);
};
