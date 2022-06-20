import { Client } from "@elastic/elasticsearch";
import bcrypt from "bcrypt";
import { Item, Transaction, Account, getLocalItems } from "server";
import mappings from "./mappings.json";

const client = new Client({ node: process.env.ELASTICSEARCH_HOST });

const { version, properties }: any = mappings;
const index = "budget" + (version ? `-${version}` : "");

export interface User {
  id: string;
  username: string;
  password: string;
  items: Item[];
}

export type MaskedUser = Omit<User, "password">;

/**
 * Makes sure an index exists with specified mappings.
 * Then creates or updates admin user with configured password.
 * If this operations fail, budget app might not work in many situations.
 * Check server logs and try resolve the issues in this case.
 */
export const initializeIndex = async (): Promise<void> => {
  console.info("Initialization started.");
  try {
    console.info("Checking Elasticsearch availability...");
    const { status } = await client.cluster.health({
      wait_for_status: "yellow",
      timeout: "5s",
    });
    if (!status || status === "red") {
      throw new Error("Elasticsearch is not available");
    }
    console.info(`Elasticsearch is ready (status: ${status})`);
  } catch (error) {
    console.info(
      "Elasticsearch is not available. Restarting initialization in 10 seconds."
    );
    return new Promise((res) => {
      setTimeout(() => res(initializeIndex()), 10000);
    });
  }
  const indexAlreadyExists = await client.indices.exists({ index });

  if (indexAlreadyExists) {
    console.info("Existing Elasticsearch index is found.");

    const response = await client.indices
      .putMapping({
        index,
        properties,
      })
      .catch((error) => {
        console.error(error);
      });

    if (!response) {
      throw new Error("Failed to setup mappings for Elasticsearch index.");
    }

    console.info("Successfully setup mappings for Elasticsearch index.");
  } else {
    const response = await client.indices
      .create({
        index,
        mappings: { properties },
      })
      .catch((error) => {
        console.error(error);
      });

    if (!response) {
      throw new Error("Failed to create Elasticsearch index.");
    }

    console.info("Successfully created Elasticsearch index.");
  }

  const { ADMIN_PASSWORD, DEMO_PASSWORD } = process.env;

  const itemsMap = new Map<string, Item>();

  const localItems = getLocalItems();
  localItems.forEach((e) => itemsMap.set(e.item_id, e));

  const existingAdminUser = await searchUser({ username: "admin" });
  existingAdminUser?.items.forEach((e) => itemsMap.set(e.item_id, e));

  const adminItems = Array.from(itemsMap.values());

  indexUser({
    id: existingAdminUser?.id,
    username: "admin",
    password: ADMIN_PASSWORD || "budget",
    items: adminItems,
  });

  const existingDemoUser = await searchUser({ username: "demo" });

  indexUser({
    id: existingDemoUser?.id,
    username: "demo",
    password: DEMO_PASSWORD || "budget",
    items: existingDemoUser?.items || [],
  });

  console.info("Successfully setup admin & demo user.");
};

/**
 * Creates or updates a document that represents a user.
 * If id is provided and already exists in the index, existing document will be updated.
 * Otherwise, new document is created in either provided id or auto-generated one.
 * This operation doesn't ensure created user's properties are unique.
 * Therefore an extra validation is recommended when creating a new user.
 * @param user
 * @returns A promise to be an Elasticsearch result object
 */
export const indexUser = async (user: Omit<User, "id"> & { id?: string }) => {
  const { id, password } = user;

  if (password) {
    user.password = await bcrypt.hash(password, 10);
  }

  if (id) delete user.id;

  const response = await client.index({
    index,
    id,
    body: { type: "user", user },
  });

  return response.result;
};

/**
 * Searches for a user. Prints out warning log if multiple users are found.
 * @param user
 * @returns A promise to be a User object
 */
export const searchUser = async (
  user: Omit<{ [k in keyof User]?: User[k] }, "password">
) => {
  if (user.id) {
    const response = await client.get<{ user: User }>({
      index,
      id: user.id,
    });

    const hitUser = response?._source?.user;

    return (hitUser && { ...hitUser, id: response._id }) as User;
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

  return (hitUser && { ...hitUser, id: hit._id }) as User;
};

/**
 * Adds an item to an indexed user object.
 * @param user
 * @param item
 * @returns A promise to be an Elasticsearch result object
 */
export const indexItem = async (user: MaskedUser, item: Item) => {
  const response = await client.update({
    index,
    id: user.id,
    script: {
      source: "ctx._source.user.items.add(params.val)",
      lang: "painless",
      params: { val: item },
    },
  });
  return response.result;
};

/**
 * Update items of given user, specifically each item's cursor.
 * Cursor is used to mark where last synced with Plaid API.
 * @param user
 * @returns A promise to be an Elasticsearch result object
 */
export const updateItems = async (user: MaskedUser) => {
  const response = await client.update({
    index,
    id: user.id,
    script: {
      source: `
for (int i=ctx._source.user.items.length-1; i>=0; i--) {
  for (int j=params.val.length-1; i>=0; i--) {
    if (ctx._source.user.items[i].id == params.val[j].id) {
        ctx._source.user.items[i].cursor = params.val[j].cursor;
    }
  }
}
`,
      lang: "painless",
      params: { val: user.items },
    },
  });
  return response.result;
};

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
        user: { user_id: user.id },
        transaction,
      },
    ];
  });

  const response = await client.bulk({ operations });

  return response.items.map((e) => e.index);
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
          { term: { "user.user_id": user.id } },
          { term: { type: "transaction" } },
        ],
      },
    },
  });

  return response.hits.hits
    .map((e) => e?._source?.transaction as Transaction)
    .filter((e) => e);
};

/**
 * Creates accounts documents associated with given user.
 * @param user
 * @param accounts
 * @returns A promise to be an array of Elasticsearch bulk response objects
 */
export const indexAccounts = async (user: MaskedUser, accounts: Account[]) => {
  if (!accounts.length) return [];

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
        user: { user_id: user.id },
        account,
      },
    ];
  });

  const response = await client.bulk({ operations });

  return response.items.map((e) => e.index);
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
        filter: [{ term: { "user.user_id": user.id } }, { term: { type: "account" } }],
      },
    },
  });

  return response.hits.hits.map((e) => e?._source?.account as Account).filter((e) => e);
};
