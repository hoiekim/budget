import mappings from "./mappings.json";
import { client, index } from "./client";
import { Item, getLocalItems, searchUser, indexUser } from "server";

const { properties }: any = mappings;

/**
 * Makes sure an index exists with specified mappings.
 * Then creates or updates admin user with configured password.
 * If this operations fail, budget app might not work in many situations.
 * Check server logs and try resolve the issues in this case.
 */
export const initializeIndex = async (): Promise<void> => {
  console.info("Initialization started.");
  try {
    const { status } = await client.cluster.health({
      wait_for_status: "yellow",
      timeout: "5s",
    });
    if (!status || status === "red") {
      throw new Error("Elasticsearch is not available");
    }
    console.info(`Elasticsearch is ready (status: ${status})`);
  } catch (error: any) {
    console.info(error.message);
    console.info("Restarting initialization in 10 seconds.");
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
        dynamic: "strict",
      })
      .catch((error) => {
        console.error(error);
      });

    if (!response) {
      throw new Error("Failed to setup mappings for Elasticsearch index.");
    }
  } else {
    const response = await client.indices
      .create({
        index,
        mappings: { properties, dynamic: "strict" },
      })
      .catch((error) => {
        console.error(error);
      });

    if (!response) {
      throw new Error("Failed to create Elasticsearch index.");
    }
  }

  const { ADMIN_PASSWORD, DEMO_PASSWORD } = process.env;

  const itemsMap = new Map<string, Item>();

  const localItems = getLocalItems();
  localItems.forEach((e) => itemsMap.set(e.item_id, e));

  const existingAdminUser = await searchUser({ username: "admin" });
  existingAdminUser?.items.forEach((e) => {
    const duplicatedItem = itemsMap.get(e.item_id);
    const mergedItem = duplicatedItem ? { ...e, ...duplicatedItem } : e;
    itemsMap.set(e.item_id, mergedItem);
  });

  const adminItems = Array.from(itemsMap.values());

  indexUser({
    user_id: existingAdminUser?.user_id,
    username: "admin",
    password: ADMIN_PASSWORD || "budget",
    items: adminItems,
  });

  const existingDemoUser = await searchUser({ username: "demo" });

  indexUser({
    user_id: existingDemoUser?.user_id,
    username: "demo",
    password: DEMO_PASSWORD || "budget",
    items: existingDemoUser?.items || [],
  });

  console.info("Successfully initialized Elasticsearch index and setup default users.");
};
