import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import {
  Account,
  Data,
  PATH,
  Transaction,
  TransactionLabel,
  TransferDictionary,
} from "client";
import type { TransferPair } from "server";
import type { FetchStubRoute } from "test-render";
import { buildContext, buildRouter, renderWithContext, resetDom, stubFetch } from "test-render";
import TransactionRow from "./TransactionRow";

let restoreFetch: (() => void) | undefined;

afterEach(() => {
  restoreFetch?.();
  restoreFetch = undefined;
  cleanup();
  resetDom();
});

const ACCOUNT_ID = "account-1";

const buildData = () => {
  const data = new Data();
  const account = new Account({
    account_id: ACCOUNT_ID,
    name: "Checking",
    custom_name: "",
  });
  data.accounts.set(ACCOUNT_ID, account);
  return data;
};

const buildTransaction = (overrides: Partial<Transaction> = {}) =>
  new Transaction({
    transaction_id: "tx-1",
    account_id: ACCOUNT_ID,
    amount: 12.34,
    date: "2026-01-15",
    authorized_date: "2026-01-15",
    iso_currency_code: "USD",
    merchant_name: "Amazon",
    name: "AMAZON.COM PURCHASE",
    label: new TransactionLabel(),
    ...overrides,
  });

/** Read the row's title cell (the first `.bigText` inside `.merchant_name`). */
const rowTitle = (container: HTMLElement) => {
  const merchantCell = container.querySelector(".merchant_name");
  const bigText = merchantCell?.querySelector(".bigText");
  return bigText?.textContent ?? "";
};

const render = (transaction: Transaction, data: Data) => {
  const { router } = buildRouter(PATH.TRANSACTIONS);
  return renderWithContext(<TransactionRow transaction={transaction} />, buildContext({ data, router }));
};

describe("TransactionRow — label.memo title override", () => {
  it("renders label.memo as the row title when set, overriding merchant_name", () => {
    const data = buildData();
    const tx = buildTransaction({
      merchant_name: "Amazon",
      name: "AMAZON.COM PURCHASE",
      label: new TransactionLabel({ memo: "Whole Foods" }),
    });
    data.transactions.set(tx.transaction_id, tx);

    const { container } = render(tx, data);

    expect(rowTitle(container)).toBe("Whole Foods");
  });

  it("falls back to merchant_name when label.memo is null", () => {
    const data = buildData();
    const tx = buildTransaction({
      merchant_name: "Amazon",
      name: "AMAZON.COM PURCHASE",
      label: new TransactionLabel({ memo: null }),
    });
    data.transactions.set(tx.transaction_id, tx);

    const { container } = render(tx, data);

    expect(rowTitle(container)).toBe("Amazon");
  });

  it("treats an empty-string memo as absent and falls back to merchant_name", () => {
    const data = buildData();
    const tx = buildTransaction({
      merchant_name: "Amazon",
      name: "AMAZON.COM PURCHASE",
      label: new TransactionLabel({ memo: "" }),
    });
    data.transactions.set(tx.transaction_id, tx);

    const { container } = render(tx, data);

    expect(rowTitle(container)).toBe("Amazon");
  });

  it("falls back to `name` when both memo and merchant_name are absent", () => {
    const data = buildData();
    const tx = buildTransaction({
      merchant_name: null,
      name: "AMAZON.COM PURCHASE",
      label: new TransactionLabel({ memo: null }),
    });
    data.transactions.set(tx.transaction_id, tx);

    const { container } = render(tx, data);

    expect(rowTitle(container)).toBe("AMAZON.COM PURCHASE");
  });
});

const PAIR_ID = "pair-1";
const SIBLING_ID = "tx-2";

/**
 * A row whose parent transaction is one half of a still-suggested pair —
 * the state in which the row shows the `Transfer` chip instead of the
 * budget/category controls.
 */
const buildSuggestedPair = () => {
  const data = buildData();
  const transaction = buildTransaction();
  const sibling = buildTransaction({
    transaction_id: SIBLING_ID,
    amount: -12.34,
    name: "TRANSFER TO SAVINGS",
    merchant_name: null,
  });
  data.transactions.set(transaction.transaction_id, transaction);
  data.transactions.set(sibling.transaction_id, sibling);
  const pair: TransferPair = {
    pair_id: PAIR_ID,
    status: "suggested",
    transactions: [transaction, sibling],
  };
  data.transfers = new TransferDictionary([[PAIR_ID, pair]]);
  return { data, transaction };
};

const renderSuggestedRow = (route: Partial<FetchStubRoute> = {}) => {
  const { data, transaction } = buildSuggestedPair();
  const stub = stubFetch([
    { path: "/api/transfers", response: { status: "success" }, ...route },
  ]);
  restoreFetch = stub.restore;
  const rendered = render(transaction, data);
  return { ...rendered, calls: stub.calls };
};

const chip = () => screen.getByRole("button", { name: "Transfer" });
const openDialog = () => act(() => void fireEvent.click(chip()));
const dialog = () => document.querySelector("div.TransferPairModal");
const actionButton = (name: "Confirm" | "Reject") =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
const closeButton = () =>
  screen.getByRole("button", { name: "Close transfer suggestion" }) as HTMLButtonElement;
const isInert = (button: HTMLButtonElement) => button.getAttribute("aria-disabled") === "true";

/** Capture `window.alert` for one test; restored by the returned undo. */
const captureAlerts = () => {
  const messages: string[] = [];
  const original = window.alert;
  window.alert = (message?: unknown) => void messages.push(String(message));
  return { messages, restore: () => { window.alert = original; } };
};

describe("TransactionRow — suggested transfer pair", () => {
  it("shows the chip, and the chip alone, until it is clicked", () => {
    const { container } = renderSuggestedRow();

    expect(container.querySelector(".transferChip")).not.toBeNull();
    expect(container.querySelector(".labelControls")).toBeNull();
    expect(dialog()).toBeNull();
  });

  it("opens the dialog on a chip click and writes nothing", () => {
    const { calls } = renderSuggestedRow();

    openDialog();

    expect(dialog()).not.toBeNull();
    expect(calls.requests).toEqual([]);
  });

  it("moves focus into the dialog when it opens", () => {
    renderSuggestedRow();

    openDialog();

    expect(dialog()?.contains(document.activeElement)).toBe(true);
  });

  it("issues exactly one DELETE for the pair when Reject is used", async () => {
    const { calls } = renderSuggestedRow();
    openDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    });

    expect(calls.requests).toHaveLength(1);
    expect(calls.requests[0].method).toBe("DELETE");
    expect(calls.requests[0].url).toBe(`/api/transfers?id=${PAIR_ID}`);
    expect(dialog()).toBeNull();
  });

  it("issues exactly one pair POST when Confirm is used", async () => {
    const { calls } = renderSuggestedRow();
    openDialog();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    });

    expect(calls.requests).toHaveLength(1);
    expect(calls.requests[0].method).toBe("POST");
    expect(calls.requests[0].url).toBe("/api/transfers/pair");
    expect(dialog()).toBeNull();
  });

  for (const action of ["Confirm", "Reject"] as const) {
    it(`keeps the dialog open and surfaces the message when a ${action.toLowerCase()} is refused`, async () => {
      const alerts = captureAlerts();
      try {
        renderSuggestedRow({ response: { status: "failed", message: "pair already rejected" } });
        openDialog();

        await act(async () => {
          fireEvent.click(actionButton(action));
        });

        expect(dialog()).not.toBeNull();
        expect(alerts.messages).toEqual(["pair already rejected"]);
      } finally {
        alerts.restore();
      }
    });
  }

  it("wraps Tab at the panel edges instead of walking into the page behind it", () => {
    renderSuggestedRow();
    openDialog();

    act(() => {
      actionButton("Reject").focus();
      fireEvent.keyDown(actionButton("Reject"), { key: "Tab" });
    });
    expect(document.activeElement).toBe(closeButton());

    act(() => {
      fireEvent.keyDown(closeButton(), { key: "Tab", shiftKey: true });
    });
    expect(document.activeElement).toBe(actionButton("Reject"));
  });

  it("marks both actions inert while the write is in flight, without unfocusing them", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { calls } = renderSuggestedRow({ hold });
    openDialog();

    await act(async () => {
      fireEvent.click(actionButton("Reject"));
    });

    expect(isInert(actionButton("Confirm"))).toBe(true);
    expect(isInert(actionButton("Reject"))).toBe(true);
    // Native `disabled` would blur the button the user just pressed out of the
    // dialog, so the retry target has to stay focusable and the click has to be
    // refused by the owner instead.
    expect(actionButton("Confirm").disabled).toBe(false);
    expect(actionButton("Reject").disabled).toBe(false);

    await act(async () => {
      fireEvent.click(actionButton("Confirm"));
    });
    expect(calls.requests).toHaveLength(1);
    expect(calls.requests[0].method).toBe("DELETE");

    await act(async () => {
      release();
      await hold;
    });
  });

  it("refuses a second click landing in the same flush as the first", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { calls } = renderSuggestedRow({ hold });
    openDialog();

    // `setBusy` lands on the next render, so two clicks dispatched before that
    // render both read `busy === false`. The buttons are only `aria-disabled`,
    // so nothing stops the second click from reaching a handler.
    await act(async () => {
      fireEvent.click(actionButton("Reject"));
      fireEvent.click(actionButton("Reject"));
    });

    expect(calls.requests).toHaveLength(1);

    await act(async () => {
      release();
      await hold;
    });
  });

  it("keeps the in-flight guard alive across a dismissal, so the reopened dialog cannot double-write", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    const { calls } = renderSuggestedRow({ hold });
    openDialog();

    await act(async () => {
      fireEvent.click(actionButton("Reject"));
    });
    // Dismiss mid-flight, then reopen: the chip is still on the row because
    // `data.transfers` has not changed.
    act(() => void fireEvent.keyDown(window, { key: "Escape" }));
    expect(dialog()).toBeNull();
    openDialog();

    expect(isInert(actionButton("Confirm"))).toBe(true);
    await act(async () => {
      fireEvent.click(actionButton("Confirm"));
    });
    expect(calls.requests).toHaveLength(1);
    expect(calls.requests[0].method).toBe("DELETE");

    await act(async () => {
      release();
      await hold;
    });
  });
});

