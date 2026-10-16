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

const buildTransaction = (
  transaction_id: string,
  date: string,
  overrides: Partial<Transaction> = {},
) =>
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
    ...overrides,
  });

const buildRecurring = (
  recurring_id: string,
  merchant_name: string,
  status: Recurring["status"],
  members: Transaction[],
  is_income = false,
): Recurring => ({
  recurring_id,
  merchant_key: merchant_name.toLowerCase(),
  merchant_name,
  cadence: "monthly",
  is_income,
  status,
  transactions: members as unknown as JSONTransaction[],
});

interface SetupOptions {
  /** Status of the recurring the viewed transaction (tx-0) belongs to; omit
   *  for a transaction in no recurring. */
  status?: "suggested" | "confirmed";
  /** Other recurrings already in `data`. */
  others?: Recurring[];
  /** Body the stubbed `/api/recurrings` answers with. */
  responseBody?: unknown;
}

const setup = ({ status, others = [], responseBody }: SetupOptions = {}) => {
  const data = new Data();
  data.accounts.set(ACCOUNT_ID, new Account({ account_id: ACCOUNT_ID, name: "Checking" }));
  const members = MEMBER_DATES.map((date, i) => buildTransaction(`tx-${i}`, date));
  members.forEach((t) => data.transactions.set(t.transaction_id, t));
  const recurrings = others.map((r): [string, Recurring] => [r.recurring_id, r]);
  if (status) {
    recurrings.push([RECURRING_ID, buildRecurring(RECURRING_ID, "Nvidia", status, members)]);
  }
  data.recurrings = new RecurringDictionary(recurrings);

  // `setData` is a `useState` setter in the app; keep what the page stores
  // so a test can re-render with it.
  const store = { data };
  const setData: ContextType["setData"] = (action) => {
    store.data = typeof action === "function" ? action(store.data) : action;
  };
  fetchStub = stubFetch([
    { path: "/api/recurrings", response: { status: "success", body: responseBody } },
  ]);
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

/** Key/value row named `name` inside the Recurring section. */
const rowOf = (name: string) => {
  const rows = Array.from(recurringSection()?.querySelectorAll(".row.keyValue") ?? []);
  return rows.find(
    (r) => r.querySelector(".propertyName")?.textContent?.replace(/ /g, " ") === name,
  );
};

/** Value cell text of the key/value row named `name`. */
const valueOf = (name: string) =>
  rowOf(name)?.lastElementChild?.textContent?.replace(/ /g, " ") ?? null;

const nameInput = () => rowOf("Name")?.querySelector("input") as HTMLInputElement | undefined;

const rowNames = () =>
  Array.from(recurringSection()?.querySelectorAll(".row.keyValue .propertyName") ?? []).map(
    (e) => e.textContent?.replace(/ /g, " "),
  );

const button = (name: RegExp) => screen.getByRole("button", { name });

describe("TransactionProperties — recurring section", () => {
  it("shows the name, first month, total, and next due date", () => {
    setup({ status: "suggested" });

    expect(rowNames()).toEqual(["Name", "From", "Total Amount", "Next Due"]);
    expect(nameInput()?.value).toBe("Nvidia");
    expect(valueOf("From")).toBe("February 2026");
    expect(valueOf("Total Amount")).toBe("$ 90.00");
    const expectedNext = getNextRecurringDate(new LocalDate("2026-04-02"), "monthly")!;
    expect(valueOf("Next Due")).toBe(
      expectedNext.toLocaleString("en-US", { month: "long", day: "numeric", year: "numeric" }),
    );
  });

  it("suggested: Confirm posts and the section turns into the confirmed state", async () => {
    const { store, calls, rerender } = setup({ status: "suggested" });

    await act(async () => {
      fireEvent.click(button(/^Confirm.Recurring$/));
    });

    expect(calls.requests).toEqual([{ url: "/api/recurrings", method: "POST" }]);
    expect(store.data.recurrings.get(RECURRING_ID)?.status).toBe("confirmed");
    rerender();
    expect(screen.queryByRole("button", { name: /^Confirm.Recurring$/ })).toBeNull();
    expect(button(/^Mark.as.Non-Recurring$/)).not.toBeNull();
  });

  it("suggested: Dismiss issues a DELETE and brings back Mark as Recurring", async () => {
    const { store, calls, rerender } = setup({ status: "suggested" });

    await act(async () => {
      fireEvent.click(button(/^Dismiss.Suggestion$/));
    });

    expect(calls.requests).toEqual([
      { url: `/api/recurrings?id=${RECURRING_ID}`, method: "DELETE" },
    ]);
    expect(store.data.recurrings.has(RECURRING_ID)).toBe(false);
    rerender();
    expect(nameInput()).toBeUndefined();
    expect(button(/^Mark.as.Recurring$/)).not.toBeNull();
  });

  it("confirmed: Mark as Non-Recurring cancels it with a DELETE", async () => {
    const { calls } = setup({ status: "confirmed" });

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
    setup({ status: "suggested" });
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

describe("TransactionProperties — recurring name", () => {
  it("renames the recurring when the name field loses focus", async () => {
    const { store, calls } = setup({ status: "confirmed" });

    fireEvent.change(nameInput()!, { target: { value: "  Nvidia ESPP " } });
    await act(async () => {
      fireEvent.blur(nameInput()!);
    });

    expect(calls.requests).toEqual([{ url: "/api/recurrings", method: "POST" }]);
    expect(store.data.recurrings.get(RECURRING_ID)?.merchant_name).toBe("Nvidia ESPP");
  });

  it("restores the current name instead of saving a blank one", async () => {
    const { store, calls } = setup({ status: "confirmed" });

    fireEvent.change(nameInput()!, { target: { value: "   " } });
    await act(async () => {
      fireEvent.blur(nameInput()!);
    });

    expect(calls.requests).toEqual([]);
    expect(nameInput()?.value).toBe("Nvidia");
    expect(store.data.recurrings.get(RECURRING_ID)?.merchant_name).toBe("Nvidia");
  });

  it("does not write when the name is unchanged", async () => {
    const { calls } = setup({ status: "confirmed" });

    await act(async () => {
      fireEvent.blur(nameInput()!);
    });

    expect(calls.requests).toEqual([]);
  });
});

describe("TransactionProperties — marking as recurring", () => {
  const spotifyMember = buildTransaction("tx-spotify", "2026-03-20", {
    merchant_name: "Spotify",
    amount: 11.99,
  });
  const spotify = buildRecurring("r-spotify", "Spotify", "confirmed", [
    buildTransaction("tx-spotify-old", "2026-02-20", { merchant_name: "Spotify", amount: 10.99 }),
    spotifyMember,
  ]);
  const hulu = buildRecurring("r-hulu", "Hulu", "suggested", [
    buildTransaction("tx-hulu", "2026-03-05", { merchant_name: "Hulu", amount: 17.99 }),
  ]);
  const payroll = buildRecurring(
    "r-payroll",
    "Payroll",
    "confirmed",
    [buildTransaction("tx-payroll", "2026-03-15", { merchant_name: "Payroll", amount: -2000 })],
    true,
  );

  const openPicker = () => act(() => void fireEvent.click(button(/^Mark.as.Recurring$/)));

  const candidates = () =>
    Array.from(recurringSection()?.querySelectorAll(".recurringCandidateInfo") ?? []).map((e) => [
      e.querySelector(".recurringCandidateName")?.textContent,
      e.querySelector(".recurringCandidateAmount")?.textContent?.replace(/ /g, " "),
    ]);

  it("offers only confirmed recurrings of the same direction, each with its latest amount", () => {
    setup({ others: [spotify, hulu, payroll] });
    openPicker();

    expect(candidates()).toEqual([["Spotify", "$ 11.99"]]);
  });

  it("shows the new recurring right away after Create new recurring", async () => {
    const created = buildRecurring("r-new", "Nvidia", "confirmed", [
      buildTransaction("tx-0", MEMBER_DATES[0]),
    ]);
    const { store, calls, rerender } = setup({
      responseBody: { recurring_id: "r-new", recurring: created },
    });
    openPicker();

    await act(async () => {
      fireEvent.click(button(/^Create new recurring$/));
    });

    expect(calls.requests).toEqual([{ url: "/api/recurrings", method: "POST" }]);
    expect(store.data.recurrings.byTransactionId.get("tx-0")?.recurring_id).toBe("r-new");
    rerender();
    expect(nameInput()?.value).toBe("Nvidia");
    expect(button(/^Mark.as.Non-Recurring$/)).not.toBeNull();
  });

  it("shows the joined recurring right away after picking an existing one", async () => {
    const joined: Recurring = {
      ...spotify,
      transactions: [...spotify.transactions, buildTransaction("tx-0", MEMBER_DATES[0])] as never,
    };
    const { store, calls, rerender } = setup({
      others: [spotify],
      responseBody: { recurring_id: spotify.recurring_id, recurring: joined },
    });
    openPicker();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Spotify/ }));
    });

    expect(calls.requests).toEqual([{ url: "/api/recurrings", method: "POST" }]);
    expect(store.data.recurrings.byTransactionId.get("tx-0")?.recurring_id).toBe("r-spotify");
    rerender();
    expect(nameInput()?.value).toBe("Spotify");
  });
});
