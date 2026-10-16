import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import {
  Account,
  Context,
  ContextType,
  Data,
  PATH,
  RecurringDictionary,
  Transaction,
  TransactionLabel,
} from "client";
import { getNextRecurringDate, LocalDate, type JSONTransaction } from "common";
import type { Recurring } from "server";
import { buildContext, buildRouter, renderWithContext, resetDom, stubFetch } from "test-render";
import { TransactionProperties } from ".";

let fetchStub: ReturnType<typeof stubFetch> | undefined;

afterEach(() => {
  cleanup();
  fetchStub?.restore();
  fetchStub = undefined;
  resetDom();
});

const ACCOUNT_ID = "account-1";
const RECURRING_ID = "recurring-1";
const MEMBER_DATES = ["2026-03-02", "2026-02-02", "2026-04-02"];

const buildTransaction = (transaction_id: string, date: string) =>
  new Transaction({
    transaction_id,
    account_id: ACCOUNT_ID,
    amount: 30,
    date,
    authorized_date: date,
    iso_currency_code: "USD",
    merchant_name: "Nvidia",
    name: "NVIDIA",
    label: new TransactionLabel(),
  });

const setup = (status: "suggested" | "confirmed") => {
  const data = new Data();
  data.accounts.set(ACCOUNT_ID, new Account({ account_id: ACCOUNT_ID, name: "Checking" }));
  const members = MEMBER_DATES.map((date, i) => buildTransaction(`tx-${i}`, date));
  members.forEach((t) => data.transactions.set(t.transaction_id, t));
  const recurring: Recurring = {
    recurring_id: RECURRING_ID,
    merchant_key: "nvidia",
    merchant_name: "Nvidia",
    cadence: "monthly",
    is_income: false,
    status,
    transactions: members as unknown as JSONTransaction[],
  };
  data.recurrings = new RecurringDictionary([[RECURRING_ID, recurring]]);

  // `setData` is a `useState` setter in the app; keep what the page stores
  // so a test can re-render with it.
  const store = { data };
  const setData: ContextType["setData"] = (action) => {
    store.data = typeof action === "function" ? action(store.data) : action;
  };
  fetchStub = stubFetch([{ path: "/api/recurrings", response: { status: "success" } }]);
  const { router } = buildRouter(PATH.TRANSACTION_DETAIL);
  const render = () => (
    <Context.Provider value={buildContext({ data: store.data, setData, router })}>
      <TransactionProperties transaction={store.data.transactions.get("tx-0")!} />
    </Context.Provider>
  );
  const { rerender } = renderWithContext(render(), buildContext());
  return { store, calls: fetchStub.calls, rerender: () => act(() => rerender(render())) };
};

/** The `.property` box under the "Recurring" section label. */
const recurringSection = () => {
  const labels = Array.from(document.querySelectorAll(".propertyLabel"));
  return labels.find((l) => l.textContent === "Recurring")?.nextElementSibling ?? null;
};

/** Value cell of the key/value row named `name` inside the Recurring section. */
const valueOf = (name: string) => {
  const rows = Array.from(recurringSection()?.querySelectorAll(".row.keyValue") ?? []);
  const row = rows.find(
    (r) => r.querySelector(".propertyName")?.textContent?.replace(/\u00a0/g, " ") === name,
  );
  return row?.lastElementChild?.textContent?.replace(/\u00a0/g, " ") ?? null;
};

const button = (name: RegExp) => screen.getByRole("button", { name });

describe("TransactionProperties — recurring section", () => {
  it("summarizes the recurring from its member transactions", () => {
    setup("suggested");

    expect(valueOf("Name")).toBe("Nvidia");
    expect(valueOf("Status")).toBe("Suggested");
    expect(valueOf("Interval")).toBe("Monthly");
    expect(valueOf("From")).toBe("February 2026");
    expect(valueOf("Latest")).toBe("April 2, 2026");
    expect(valueOf("Occurrences")).toBe("3");
    expect(valueOf("Total Amount")).toBe("$ 90.00");
    const expectedNext = getNextRecurringDate(new LocalDate("2026-04-02"), "monthly")!;
    expect(valueOf("Next Due")).toBe(
      expectedNext.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    );
  });

  it("suggested: Confirm posts and the section turns into the confirmed state", async () => {
    const { store, calls, rerender } = setup("suggested");

    await act(async () => {
      fireEvent.click(button(/^Confirm.Recurring$/));
    });

    expect(calls.requests).toEqual([{ url: "/api/recurrings", method: "POST" }]);
    expect(store.data.recurrings.get(RECURRING_ID)?.status).toBe("confirmed");
    rerender();
    expect(valueOf("Status")).toBe("Confirmed");
    expect(screen.queryByRole("button", { name: /^Confirm.Recurring$/ })).toBeNull();
    expect(button(/^Mark.as.Non-Recurring$/)).not.toBeNull();
  });

  it("suggested: Dismiss issues a DELETE and brings back Mark as Recurring", async () => {
    const { store, calls, rerender } = setup("suggested");

    await act(async () => {
      fireEvent.click(button(/^Dismiss.Suggestion$/));
    });

    expect(calls.requests).toEqual([
      { url: `/api/recurrings?id=${RECURRING_ID}`, method: "DELETE" },
    ]);
    expect(store.data.recurrings.has(RECURRING_ID)).toBe(false);
    rerender();
    expect(valueOf("Name")).toBeNull();
    expect(button(/^Mark.as.Recurring$/)).not.toBeNull();
  });

  it("confirmed: Mark as Non-Recurring cancels it with a DELETE", async () => {
    const { calls } = setup("confirmed");

    expect(valueOf("Status")).toBe("Confirmed");
    expect(screen.queryByRole("button", { name: /^Dismiss.Suggestion$/ })).toBeNull();

    await act(async () => {
      fireEvent.click(button(/^Mark.as.Non-Recurring$/));
    });

    expect(calls.requests).toEqual([
      { url: `/api/recurrings?id=${RECURRING_ID}`, method: "DELETE" },
    ]);
  });

  it("disables both actions while a write is in flight", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    setup("suggested");
    fetchStub!.restore();
    fetchStub = stubFetch([{ path: "/api/recurrings", response: { status: "success" }, hold }]);

    await act(async () => {
      fireEvent.click(button(/^Confirm.Recurring$/));
    });

    expect((button(/^Confirming…$/) as HTMLButtonElement).disabled).toBe(true);
    expect((button(/^Dismiss.Suggestion$/) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      release();
      await hold;
    });
  });
});
