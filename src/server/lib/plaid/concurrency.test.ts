import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Products } from "plaid";
import type { JSONItem } from "common";
import type { MaskedUser } from "server";
import { getAccounts, getHoldings } from "./accounts";
import { getTransactions, getInvestmentTransactions } from "./transactions";
import { getLinkToken, exchangePublicToken, getItem, deleteItem } from "./tokens";
import { getInstitutionsByIds } from "./institutions";
import { PLAID_FOREGROUND_WAIT_MS, PLAID_MAX_INFLIGHT, plaidQueue } from "./util";
import type { PlaidClientDeps } from "./util";

// No mock.module: every function takes its client through the injected
// `getClient` seam, so the fake below is visible only to this file.

const user = { user_id: "u-1", username: "test" } as MaskedUser;

let inflight = 0;
let peakInflight = 0;
let calls = 0;
let failEveryCall = false;

const track = async <T>(result: T): Promise<T> => {
  calls++;
  inflight++;
  peakInflight = Math.max(peakInflight, inflight);
  try {
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (failEveryCall) throw new Error("transport failure");
    return result;
  } finally {
    inflight--;
  }
};

const fakeClient = {
  accountsGet: () => track({ data: { accounts: [] } }),
  investmentsHoldingsGet: () => track({ data: { accounts: [], holdings: [], securities: [] } }),
  transactionsSync: () =>
    track({ data: { added: [], removed: [], modified: [], has_more: false, next_cursor: "c" } }),
  investmentsTransactionsGet: () =>
    track({ data: { investment_transactions: [], total_investment_transactions: 0 } }),
  linkTokenCreate: () => track({ data: { link_token: "lt" } }),
  itemPublicTokenExchange: () => track({ data: { access_token: "at", item_id: "it" } }),
  itemGet: () => track({ data: { item: { item_id: "it" } } }),
  itemRemove: () => track({ data: {} }),
  institutionsGetById: ({ institution_id }: { institution_id: string }) =>
    track({ data: { institution: { institution_id, name: institution_id } } }),
};

const deps: PlaidClientDeps = {
  getClient: (() => fakeClient) as unknown as PlaidClientDeps["getClient"],
};

const makeItem = (n: number) =>
  ({
    item_id: `item-${n}`,
    access_token: `access-${n}`,
    cursor: undefined,
    updated: undefined,
    available_products: [Products.Transactions, Products.Investments],
  }) as unknown as JSONItem;

const items = Array.from({ length: 20 }, (_, n) => makeItem(n));
const institutionIds = Array.from({ length: 20 }, (_, n) => `ins_${n}`);

/** One item's full fan-out, as linking a new item runs it: four endpoint families at once. */
const syncOneItem = (item: JSONItem) =>
  Promise.all([
    getAccounts(user, [item], deps),
    getHoldings(user, [item], deps),
    getTransactions(user, [item], deps),
    getInvestmentTransactions(user, [item], deps),
  ]);

beforeEach(() => {
  plaidQueue.reset();
  inflight = 0;
  peakInflight = 0;
  calls = 0;
  failEveryCall = false;
});

describe("shared Plaid concurrency gate", () => {
  it("caps a storm across every endpoint family at one shared budget", async () => {
    await Promise.all([
      ...items.map(syncOneItem),
      getLinkToken(user, undefined, deps),
      exchangePublicToken(user, "public", deps),
      getItem("access-0", deps),
      deleteItem(user, items[0]!, deps),
      getInstitutionsByIds(user, institutionIds, deps),
    ]);

    expect(calls).toBe(items.length * 4 + 4 + institutionIds.length);
    expect(peakInflight).toBe(PLAID_MAX_INFLIGHT);
  });

  it("caps a multi-item call to one endpoint family", async () => {
    await getTransactions(user, items, deps);

    expect(calls).toBe(items.length);
    expect(peakInflight).toBe(PLAID_MAX_INFLIGHT);
  });

  it("holds an institutions batch to its sub-cap inside the shared gate", async () => {
    const institutions = await getInstitutionsByIds(user, institutionIds, deps);

    expect(institutions.map((i) => i.institution_id)).toStrictEqual(institutionIds);
    expect(peakInflight).toBe(4);
  });

  it("keeps one item's full fan-out parallel", async () => {
    await syncOneItem(items[0]!);

    expect(calls).toBe(4);
    expect(peakInflight).toBe(4);
  });

  it("releases the slot of a failed call", async () => {
    failEveryCall = true;
    await Promise.all(items.map(syncOneItem));
    expect(calls).toBe(items.length * 4);

    failEveryCall = false;
    calls = 0;
    peakInflight = 0;
    await getAccounts(user, items, deps);

    expect(calls).toBe(items.length);
    expect(peakInflight).toBe(PLAID_MAX_INFLIGHT);
  });

  describe("wait bound", () => {
    const originalAdd = plaidQueue.add;
    let waits: (number | undefined)[] = [];

    beforeEach(() => {
      waits = [];
      plaidQueue.add = ((task, options) => {
        waits.push(options?.maxWaitMs);
        return originalAdd.call(plaidQueue, task, options);
      }) as typeof plaidQueue.add;
    });

    afterEach(() => {
      plaidQueue.add = originalAdd;
    });

    it("bounds the wait of calls made while a request is open", async () => {
      await getLinkToken(user, undefined, deps);
      await exchangePublicToken(user, "public", deps);
      await getItem("access-0", deps);
      await deleteItem(user, items[0]!, deps);
      await getInstitutionsByIds(user, ["ins_0"], deps);

      expect(waits).toStrictEqual(Array(5).fill(PLAID_FOREGROUND_WAIT_MS));
    });

    it("leaves background sync calls waiting for as long as it takes", async () => {
      await syncOneItem(items[0]!);

      expect(waits).toStrictEqual(Array(4).fill(undefined));
    });
  });
});
