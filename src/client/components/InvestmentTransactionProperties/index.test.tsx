import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent } from "@testing-library/react";
import { InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";
import { Account, Data, InvestmentTransaction, PATH } from "client";
import { buildContext, buildRouter, renderWithContext, resetDom, stubFetch } from "test-render";
import { InvestmentTransactionProperties } from ".";

let stub: ReturnType<typeof stubFetch> | undefined;
let unwrapFetch: (() => void) | undefined;

afterEach(() => {
  // The body recorder wraps whatever the stub installed, so it comes off
  // first — otherwise the wrapper outlives the stub holding a dead inner
  // fetch, for every file that runs after this one.
  unwrapFetch?.();
  unwrapFetch = undefined;
  stub?.restore();
  stub = undefined;
  cleanup();
  resetDom();
});

const ACCOUNT_ID = "acc-1";
const TX_ID = "manual-1";

const buildData = () => {
  const data = new Data();
  data.accounts.set(
    ACCOUNT_ID,
    new Account({ account_id: ACCOUNT_ID, name: "Brokerage", type: "investment" } as never),
  );
  const tx = new InvestmentTransaction({
    investment_transaction_id: TX_ID,
    account_id: ACCOUNT_ID,
    security_id: null,
    date: "2026-01-15",
    name: "Manual",
    quantity: 5,
    price: 30,
    amount: 150,
    iso_currency_code: "USD",
    type: InvestmentTransactionType.Buy,
    subtype: InvestmentTransactionSubtype.Buy,
    source: "manual",
  } as never);
  data.investmentTransactions.set(TX_ID, tx);
  return { data, tx };
};

const numberInputs = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLInputElement>('input[type="number"]')];

/** The bodies of every investment-transaction POST, in call order. */
const postedBodies = (calls: { requests: { url: string; method: string }[] }) =>
  calls.requests.filter((r) => r.url.includes("investment-transaction") && r.method === "POST");

describe("InvestmentTransactionProperties — a second shape edit begun mid-save", () => {
  // The editor reconciles type/quantity/price/amount together, and it can only
  // do that against what the previous edit stored. Props cannot supply that
  // inside a burst: the effect that refreshes them is flushed on a macrotask
  // while the write queue advances on a microtask, so a queued write
  // deterministically sees values from before the edit ahead of it.
  it("reconciles the second edit against what the first one stored", async () => {
    const { data, tx } = buildData();

    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const sent: Record<string, unknown>[] = [];
    stub = stubFetch([
      {
        path: "investment-transaction",
        response: { status: "success", body: { investment_transaction_id: TX_ID } },
        hold: firstHeld,
      },
    ]);

    // `stub.calls` records url and method only, and the assertion below needs
    // the bodies.
    const stubbed = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (init?.body) sent.push(JSON.parse(String(init.body)));
      return stubbed(input, init);
    }) as typeof globalThis.fetch;
    unwrapFetch = () => {
      globalThis.fetch = stubbed;
    };

    const { router } = buildRouter(PATH.TRANSACTIONS);
    const { container } = renderWithContext(
      <InvestmentTransactionProperties investmentTransaction={tx} />,
      buildContext({ data, router }),
    );

    const [quantity, price] = numberInputs(container);

    // Edit one: price 30 -> 40, held open.
    await act(async () => {
      fireEvent.change(price, { target: { value: "40" } });
      fireEvent.blur(price);
    });

    // Edit two, begun before the first has returned.
    await act(async () => {
      fireEvent.change(quantity, { target: { value: "8" } });
      fireEvent.blur(quantity);
    });

    await act(async () => {
      releaseFirst?.();
      await firstHeld;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    const posts = postedBodies(stub!.calls);
    expect(posts.length).toBeGreaterThanOrEqual(2);

    // The merged row every write has produced so far. Reconciling against a
    // stale row omits the field that would repair it, so the inconsistency is
    // visible only once the writes are replayed in order.
    const merged: Record<string, number> = { quantity: 5, price: 30, amount: 150 };
    for (const body of sent) {
      for (const field of ["quantity", "price", "amount"]) {
        if (typeof body[field] === "number") merged[field] = body[field] as number;
      }
    }

    expect(merged.amount).toBeCloseTo(merged.price * merged.quantity, 2);
  });

  // Where the stale row happens to agree with the new value, the patch comes
  // out empty and the edit is dropped with no request and no error.
  it("does not silently discard a second edit that reverses the first", async () => {
    const { data, tx } = buildData();

    let releaseFirst: (() => void) | undefined;
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    stub = stubFetch([
      {
        path: "investment-transaction",
        response: { status: "success", body: { investment_transaction_id: TX_ID } },
        hold: firstHeld,
      },
    ]);

    const { router } = buildRouter(PATH.TRANSACTIONS);
    const { container } = renderWithContext(
      <InvestmentTransactionProperties investmentTransaction={tx} />,
      buildContext({ data, router }),
    );

    const typeSelect = container.querySelector<HTMLSelectElement>("select");
    expect(typeSelect).toBeTruthy();

    await act(async () => {
      fireEvent.change(typeSelect!, { target: { value: InvestmentTransactionType.Sell } });
    });
    await act(async () => {
      fireEvent.change(typeSelect!, { target: { value: InvestmentTransactionType.Buy } });
    });

    await act(async () => {
      releaseFirst?.();
      await firstHeld;
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // Two picks, two writes. Reconciling the second against the pre-first row
    // makes its patch empty, so nothing is sent and the row keeps the type the
    // user moved away from.
    expect(postedBodies(stub!.calls)).toHaveLength(2);
  });
});
