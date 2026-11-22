/**
 * Plan-statement imports, `POST /plan-statement/import`: the people and
 * accounts they go into, the planned rows the import page sends, and the
 * rows an import stores, for asserting what it wrote. Import from tests
 * directly:
 *
 *   import { planPerson, shareLeg, cashLeg, importBody } from "../harness/seed/plan-statement";
 */
import type { ApiClient } from "../client";
import type { Stack } from "../stack";
import { createUserClient } from "./users";
import { rowOf, seedAccount, seedItem, seedSecurity, uniqueId, type StoredRow } from "./accounts";

export type Fields = Record<string, unknown>;

export interface PlanPerson {
  client: ApiClient;
  user_id: string;
  item_id: string;
  account_id: string;
}

/** An investment account of the item, as the import takes it, unless `row` says otherwise. */
export const planAccount = (stack: Stack, user_id: string, item_id: string, row: Fields = {}): Promise<string> =>
  seedAccount(stack, user_id, item_id, {
    name: "Plan 401(k)",
    type: "investment",
    subtype: "401k",
    balances_available: null,
    balances_current: null,
    ...row,
  });

let people = 0;
/** A user of their own, signed in, with a manual connection holding one investment account. */
export const planPerson = async (stack: Stack, name: string): Promise<PlanPerson> => {
  const { client, user } = await createUserClient(stack, `plan-${name}-${++people}`);
  const item_id = await seedItem(stack, user.user_id, "manual");
  const account_id = await planAccount(stack, user.user_id, item_id);
  return { client, user_id: user.user_id, item_id, account_id };
};

let tickers = 0;
/** A ticker no other test uses: the market-data clients keep what they learn for an hour. */
export const uniqueTicker = (stem: string): string => `${stem}${++tickers}`;

/** A security that is cash, which the price backfill skips without asking anyone. Returns its id. */
export const cashSecurity = async (stack: Stack): Promise<string> => {
  const security_id = uniqueId("sec-cash");
  await seedSecurity(stack, security_id, { ticker_symbol: uniqueTicker("PCASH"), name: `Cash ${security_id}`, type: "cash" });
  return security_id;
};

/** A fund the backfill prices at Polygon and Yahoo, under ticker `symbol`. Returns its id. */
export const fundSecurity = async (stack: Stack, symbol: string): Promise<string> => {
  const security_id = `sec-${symbol}`;
  await seedSecurity(stack, security_id, { ticker_symbol: symbol, name: `Fund ${symbol}`, type: "etf" });
  return security_id;
};

let rowIds = 0;
/** A plan statement row id, unique in the run and the same on every run; `plan-dividend-` for an inferred dividend. */
export const planId = (prefix = "plan-"): string => `${prefix}${(++rowIds).toString(16).padStart(32, "0")}`;

export interface PlannedRow {
  transaction: Fields;
  [key: string]: unknown;
}

/** A planned share movement: a contribution buying 20 shares at 50, unless `fields` say otherwise. `extra` sits beside the transaction. */
export const shareLeg = (account_id: string, security_id: string | null, fields: Fields = {}, extra: Fields = {}): PlannedRow => ({
  transaction: {
    investment_transaction_id: planId(),
    account_id,
    security_id,
    date: "2026-03-02",
    name: "Buy (contribution)",
    amount: 1000,
    quantity: 20,
    price: 50,
    iso_currency_code: "USD",
    type: "buy",
    subtype: "contribution",
    source: "manual",
    ...fields,
  },
  ...extra,
});

/** The cash leg of a planned share movement: the contribution's money arriving. */
export const cashLeg = (share: PlannedRow, fields: Fields = {}, extra: Fields = {}): PlannedRow => ({
  transaction: {
    investment_transaction_id: `${share.transaction.investment_transaction_id}-cash`,
    account_id: share.transaction.account_id,
    security_id: null,
    date: share.transaction.date,
    name: "Contribution",
    amount: -1000,
    quantity: 0,
    price: 0,
    iso_currency_code: "USD",
    type: "cash",
    subtype: "contribution",
    source: "manual",
    ...fields,
  },
  ...extra,
});

/** What the import page sends; anything in it may be replaced with something else to see it refused. */
export interface ImportBody {
  account_id: string;
  transactions: unknown[];
  mappings: unknown[];
  holdings: unknown[];
  [key: string]: unknown;
}

export const importBody = (account_id: string, transactions: unknown[], extra: Fields = {}): ImportBody => ({
  account_id,
  transactions,
  mappings: [],
  holdings: [],
  ...extra,
});

/** A holding's position after the import, as the request carries it. */
export interface PlannedHolding {
  security_id: string;
  date: string;
  quantity: number;
  cost_basis: number | null;
  price: number;
}

export const importPlanStatement = (client: ApiClient, body: unknown, options: Parameters<ApiClient["post"]>[2] = {}) =>
  client.post("/plan-statement/import", body, options);

/** Leaves out the column every write stamps, so rows compare by what was written. */
export const withoutStamps = (row: StoredRow | undefined): StoredRow | undefined => {
  if (!row) return row;
  const { updated: _updated, ...rest } = row;
  return rest;
};

/** The stored row of a planned transaction: only the checked fields, as a manual row of the account's owner. */
export const storedTransaction = (user_id: string, planned: PlannedRow, raw: unknown = null): StoredRow => {
  const t = planned.transaction;
  return {
    investment_transaction_id: t.investment_transaction_id,
    user_id,
    account_id: t.account_id,
    security_id: t.security_id,
    date: t.date,
    name: t.name,
    amount: t.amount,
    quantity: t.quantity,
    price: t.price,
    iso_currency_code: t.iso_currency_code ?? null,
    type: t.type,
    subtype: t.subtype,
    label_budget_id: null,
    label_category_id: null,
    label_memo: null,
    raw,
    is_deleted: false,
    source: "manual",
  };
};

/**
 * The stored holdings row of a holding's position after the import. `raw` is
 * the holding as written, its value the product as computed; the column holds
 * that value rounded to cents, which `stored` gives where it differs.
 */
export const storedHolding = (user_id: string, account_id: string, h: PlannedHolding, stored: { institution_value?: number } = {}): StoredRow => {
  const holding_id = `${account_id}-${h.security_id}`;
  return {
    holding_id,
    user_id,
    account_id,
    security_id: h.security_id,
    institution_price: h.price,
    institution_price_as_of: h.date,
    institution_value: stored.institution_value ?? h.quantity * h.price,
    cost_basis: h.cost_basis,
    quantity: h.quantity,
    iso_currency_code: null,
    raw: {
      holding_id,
      account_id,
      security_id: h.security_id,
      quantity: h.quantity,
      cost_basis: h.cost_basis,
      institution_price: h.price,
      institution_price_as_of: h.date,
      institution_value: h.quantity * h.price,
      iso_currency_code: null,
      unofficial_currency_code: null,
    },
    is_deleted: false,
  };
};

/** The fund mappings saved on an account, as the column holds them: an object keyed by fund. */
export const savedMappings = async (stack: Stack, account_id: string): Promise<unknown> => (await rowOf(stack, "accounts", account_id))?.plan_fund_mappings;
