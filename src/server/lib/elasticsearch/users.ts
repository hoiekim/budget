import bcrypt from "bcrypt";
import { Item } from "server";
import { client, index } from "./client";

export interface User {
  user_id: string;
  username: string;
  password: string;
  items: Item[];
}

export type MaskedUser = Omit<User, "password">;

/**
 * Creates or updates a document that represents a user.
 * If id is provided and already exists in the index, existing document will be updated.
 * Otherwise, new document is created in either provided id or auto-generated one.
 * This operation doesn't ensure created user's properties are unique.
 * Therefore an extra validation is recommended when creating a new user.
 * @param user
 * @returns A promise to be an Elasticsearch response object
 */
export const indexUser = async (user: Omit<User, "user_id"> & { user_id?: string }) => {
  const { user_id, password } = user;

  if (password) {
    user.password = await bcrypt.hash(password, 10);
  }

  if (user_id) delete user.user_id;

  const response = await client.index({
    index,
    id: user_id,
    body: { type: "user", user },
  });

  return response;
};

/**
 * Searches for a user. Prints out warning log if multiple users are found.
 * @param user
 * @returns A promise to be a User object
 */
export const searchUser = async (user: Partial<MaskedUser>) => {
  if (user.user_id) {
    const response = await client.get<{ user: User }>({
      index,
      id: user.user_id,
    });

    const hitUser = response?._source?.user;

    return (hitUser && { ...hitUser, user_id: response._id }) as User;
  }

  const filter: { term: any }[] = [{ term: { type: "user" } }];

  for (const key in user) {
    filter.push({
      term: { [`user.${key}`]: (user as any)[key] },
    });
  }

  const response = await client.search<{ user: User }>({
    index,
    query: { bool: { filter } },
  });

  const { hits } = response.hits;

  if (hits.length > 1) {
    console.warn("Multiple users are found by user:", user);
  }

  const hit = hits[0];
  const hitUser = hit?._source?.user;

  return (hitUser && { ...hitUser, user_id: hit._id }) as User;
};

/**
 * Adds an item to an indexed user object.
 * @param user
 * @param item
 * @returns A promise to be an Elasticsearch response object
 */
export const createItem = async (user: MaskedUser, item: Item) => {
  const response = await client.update({
    index,
    id: user.user_id,
    script: {
      source: "ctx._source.user.items.add(params.item)",
      lang: "painless",
      params: { item },
    },
  });
  return response;
};

/**
 * Update items of given user, specifically each item's cursor.
 * Cursor is used to mark where last synced with Plaid API.
 * @param user
 * @returns A promise to be an Elasticsearch response object
 */
export const updateItems = async (user: MaskedUser) => {
  const { user_id, items } = user;

  const query = {
    index,
    id: user_id,
    script: {
      source: `
  for (int i=ctx._source.user.items.length-1; i>=0; i--) {
    for (int j=params.items.length-1; j>=0; j--) {
      if (ctx._source.user.items[i].item_id == params.items[j].item_id) {
          ctx._source.user.items[i].cursor = params.items[j].cursor
      }
    }
  }
  `,
      lang: "painless",
      params: { items },
    },
  };

  return client.update(query);
};

/**
 * Delete an item with given user and item_id.
 * @param user
 * @param item_id
 * @returns A promise to be an Elasticsearch response object
 */
export const deleteItem = async (user: MaskedUser, item_id: string) => {
  const itemJob = client.update({
    index,
    id: user.user_id,
    script: {
      source: `
  for (int i=ctx._source.user.items.length-1; i>=0; i--) {
    if (ctx._source.user.items[i].item_id == params.item_id) {
        ctx._source.user.items.remove(i);
    }
  }
  `,
      lang: "painless",
      params: { item_id },
    },
  });

  const otherJob = client
    .search({
      index,
      query: { term: { "account.item_id": item_id } },
    })
    .then((r) => {
      const account_ids = r.hits.hits.map((e) => e._id);
      return client.deleteByQuery({
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

  user.items.find((e, i) => {
    if (e.item_id === item_id) {
      user.items.splice(i, 1);
      return true;
    }
    return false;
  });

  return Promise.all([itemJob, otherJob]);
};
