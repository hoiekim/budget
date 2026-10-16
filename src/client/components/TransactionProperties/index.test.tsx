import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import {
  Account,
  Budget,
  Category,
  Context,
  ContextType,
  Data,
  PATH,
  RecurringDictionary,
  Section,
  Transaction,
  TransactionLabel,
  TransferDictionary,
} from "client";
import { getNextRecurringDate, LocalDate, type JSONTransaction } from "common";
import type { Recurring, TransferPair } from "server";
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
const SAVINGS_ID = "account-2";
const RECURRING_ID = "recurring-1";
const PAIR_ID = "pair-1";
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
  /** That recurring's default label. */
  label?: Recurring["label"];
  /** Other recurrings already in `data`. */
  others?: Recurring[];
  /** Body the stubbed `/api/recurrings` answers with. */
  responseBody?: unknown;
  /** Make tx-0 ($30 out of Checking) half of a suggested transfer pair with a
   *  Savings deposit the next day. */
  suggestedTransfer?: boolean;
}

// One budget with two categories, for the default-label selects.
const budget = new Budget({ name: "Living" });
const section = new Section({ budget_id: budget.id, name: "Bills" });
const subscriptions = new Category({ section_id: section.id, name: "Subscriptions" });
const streaming = new Category({ section_id: section.id, name: "Streaming" });

const setup = ({
  status,
  label,
  others = [],
  responseBody,
  suggestedTransfer,
}: SetupOptions = {}) => {
  const data = new Data();
  data.accounts.set(ACCOUNT_ID, new Account({ account_id: ACCOUNT_ID, name: "Checking" }));
  data.budgets.set(budget.id, budget);
  data.sections.set(section.id, section);
  data.categories.set(subscriptions.id, subscriptions);
  data.categories.set(streaming.id, streaming);
  const members = MEMBER_DATES.map((date, i) => buildTransaction(`tx-${i}`, date));
  members.forEach((t) => data.transactions.set(t.transaction_id, t));
  const recurrings = others.map((r): [string, Recurring] => [r.recurring_id, r]);
  if (status) {
    recurrings.push([
      RECURRING_ID,
      { ...buildRecurring(RECURRING_ID, "Nvidia", status, members), label },
    ]);
  }
  data.recurrings = new RecurringDictionary(recurrings);
  if (suggestedTransfer) {
    data.accounts.set(SAVINGS_ID, new Account({ account_id: SAVINGS_ID, name: "Savings" }));
    const partner = buildTransaction("tx-partner", "2026-03-03", {
      account_id: SAVINGS_ID,
      amount: -30,
      merchant_name: "",
      name: "Transfer from Checking",
    });
    data.transactions.set(partner.transaction_id, partner);
    const pair: TransferPair = {
      pair_id: PAIR_ID,
      status: "suggested",
      transactions: [members[0], partner] as unknown as JSONTransaction[],
    };
    data.transfers = new TransferDictionary([[PAIR_ID, pair]]);
  }

  // `setData` is a `useState` setter in the app; keep what the page stores
  // so a test can re-render with it.
  const store = { data };
  const setData: ContextType["setData"] = (action) => {
    store.data = typeof action === "function" ? action(store.data) : action;
  };
  fetchStub = stubFetch([
    { path: "/api/recurrings", response: { status: "success", body: responseBody } },
    { path: "/api/transfers", response: { status: "success" } },
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

/** The `.property` box under the section label `label`. */
const sectionOf = (label: string) => {
  const labels = Array.from(document.querySelectorAll(".propertyLabel"));
  return labels.find((l) => l.textContent === label)?.nextElementSibling ?? null;
};

const recurringSection = () => sectionOf("Recurring");

/** Key/value row named `name` inside the `section` section. */
const rowOf = (name: string, section = "Recurring") => {
  const rows = Array.from(sectionOf(section)?.querySelectorAll(".row.keyValue") ?? []);
  return rows.find(
    (r) => r.querySelector(".propertyName")?.textContent?.replace(/ /g, " ") === name,
  );
};

/** Value cell text of the key/value row named `name`. */
const valueOf = (name: string, section = "Recurring") =>
  rowOf(name, section)?.lastElementChild?.textContent?.replace(/ /g, " ") ?? null;

const nameInput = () => rowOf("Name")?.querySelector("input") as HTMLInputElement | undefined;

const rowNames = () =>
  Array.from(recurringSection()?.querySelectorAll(".row.keyValue .propertyName") ?? []).map(
    (e) => e.textContent?.replace(/ /g, " "),
  );

const button = (name: RegExp) => screen.getByRole("button", { name });

describe("TransactionProperties — recurring section", () => {
  it("shows the name, first month, total, and next due date", () => {
    setup({ status: "suggested" });

    expect(rowNames()).toEqual([
      "Name",
      "Default Budget",
      "Default Category",
      "From",
      "Total Amount",
      "Next Due",
    ]);
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

describe("TransactionProperties — recurring default label", () => {
  const select = (name: string) => rowOf(name)?.querySelector("select") as HTMLSelectElement;

  /** The members as the server answers after relabeling them. */
  const relabeled = (budget_id: string, category_id: string) =>
    MEMBER_DATES.map((date, i) =>
      buildTransaction(`tx-${i}`, date, {
        label: new TransactionLabel({ budget_id, category_id, category_confidence: 1 }),
      }),
    ) as unknown as JSONTransaction[];

  it("shows the recurring's default budget and category", () => {
    setup({
      status: "confirmed",
      label: { budget_id: budget.id, category_id: subscriptions.id },
    });

    expect(select("Default Budget").value).toBe(budget.id);
    expect(select("Default Category").value).toBe(subscriptions.id);
  });

  it("saves a new default and applies the relabeled transactions the server returns", async () => {
    const answer: Recurring = {
      ...buildRecurring(RECURRING_ID, "Nvidia", "confirmed", []),
      transactions: relabeled(budget.id, streaming.id),
      label: { budget_id: budget.id, category_id: streaming.id },
    };
    const { store, calls } = setup({
      status: "confirmed",
      label: { budget_id: budget.id, category_id: subscriptions.id },
      responseBody: { recurring_id: RECURRING_ID, recurring: answer },
    });

    await act(async () => {
      fireEvent.change(select("Default Category"), { target: { value: streaming.id } });
    });

    expect(calls.requests).toEqual([{ url: "/api/recurrings", method: "POST" }]);
    expect(store.data.recurrings.get(RECURRING_ID)?.label?.category_id).toBe(streaming.id);
    expect(store.data.transactions.get("tx-2")?.label.category_id).toBe(streaming.id);
    expect(store.data.transactions.get("tx-2")?.label.category_confidence).toBe(1);
  });

  it("puts the select back when the server refuses the change", async () => {
    const { calls } = setup({
      status: "confirmed",
      label: { budget_id: budget.id, category_id: subscriptions.id },
    });
    fetchStub!.restore();
    fetchStub = stubFetch([
      { path: "/api/recurrings", response: { status: "failed", message: "nope" } },
    ]);
    const original = window.alert;
    window.alert = () => {};
    try {
      await act(async () => {
        fireEvent.change(select("Default Category"), { target: { value: streaming.id } });
      });
    } finally {
      window.alert = original;
    }

    expect(calls.requests).toEqual([]);
    expect(fetchStub.calls.requests).toHaveLength(1);
    expect(select("Default Category").value).toBe(subscriptions.id);
  });

  it("confirming applies the labels the server gave the transactions", async () => {
    const answer: Recurring = {
      ...buildRecurring(RECURRING_ID, "Nvidia", "confirmed", []),
      transactions: relabeled(budget.id, subscriptions.id),
      label: { budget_id: budget.id, category_id: subscriptions.id },
    };
    const { store } = setup({
      status: "suggested",
      responseBody: { recurring_id: RECURRING_ID, recurring: answer },
    });

    await act(async () => {
      fireEvent.click(button(/^Confirm.Recurring$/));
    });

    expect(store.data.recurrings.get(RECURRING_ID)?.status).toBe("confirmed");
    expect(store.data.recurrings.get(RECURRING_ID)?.label?.category_id).toBe(subscriptions.id);
    for (const id of ["tx-0", "tx-1", "tx-2"]) {
      expect(store.data.transactions.get(id)?.label.category_id).toBe(subscriptions.id);
    }
  });
});

describe("TransactionProperties — suggested transfer", () => {
  const transferValueOf = (name: string) => valueOf(name, "Transfer");

  it("shows the partner transaction instead of the Mark as Transfer picker", () => {
    setup({ suggestedTransfer: true });

    expect(transferValueOf("Status")).toBe("Suggested");
    expect(transferValueOf("Paired With")).toBe("Savings");
    expect(transferValueOf("Date")).toBe("March 3, 2026");
    expect(transferValueOf("Amount")).toBe("+ $ 30.00");
    expect(button(/^Confirm.Transfer$/)).not.toBeNull();
    expect(button(/^Reject.Suggestion$/)).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Mark.as.Transfer$/ })).toBeNull();
  });

  it("Confirm posts the pair and the suggestion actions go away", async () => {
    const { store, calls, rerender } = setup({ suggestedTransfer: true });

    await act(async () => {
      fireEvent.click(button(/^Confirm.Transfer$/));
    });

    expect(calls.requests).toEqual([{ url: "/api/transfers/pair", method: "POST" }]);
    expect(store.data.transfers.get(PAIR_ID)?.status).toBe("confirmed");
    rerender();
    expect(transferValueOf("Status")).toBeNull();
    expect(screen.queryByRole("button", { name: /^Confirm.Transfer$/ })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Reject.Suggestion$/ })).toBeNull();
  });

  it("Reject issues a DELETE and brings back Mark as Transfer", async () => {
    const { store, calls, rerender } = setup({ suggestedTransfer: true });

    await act(async () => {
      fireEvent.click(button(/^Reject.Suggestion$/));
    });

    expect(calls.requests).toEqual([{ url: `/api/transfers?id=${PAIR_ID}`, method: "DELETE" }]);
    expect(store.data.transfers.has(PAIR_ID)).toBe(false);
    rerender();
    expect(transferValueOf("Status")).toBeNull();
    expect(button(/Mark.as.Transfer$/)).not.toBeNull();
  });

  it("disables both actions while a write is in flight", async () => {
    let release: () => void = () => {};
    const hold = new Promise<void>((resolve) => (release = resolve));
    setup({ suggestedTransfer: true });
    fetchStub!.restore();
    fetchStub = stubFetch([{ path: "/api/transfers", response: { status: "success" }, hold }]);

    await act(async () => {
      fireEvent.click(button(/^Reject.Suggestion$/));
    });

    expect((button(/^Rejecting…$/) as HTMLButtonElement).disabled).toBe(true);
    expect((button(/^Confirm.Transfer$/) as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      release();
      await hold;
    });
  });
});
