// Run with: bun test --preload ./scripts/test-preload.ts sort.test.ts
import { describe, test, expect } from "bun:test";
import { AccountType, InvestmentTransactionType, InvestmentTransactionSubtype } from "plaid";

import {
  buildSortKey,
  formatSortValue,
  getSearchPool,
  orderRows,
  type OrderingContext,
  type TransactionRow,
} from "./sort";
import { applySortings } from "../../lib/hooks/sorter";
import { Account } from "../../lib/models/Account";
import { Budget } from "../../lib/models/Budget";
import { Category } from "../../lib/models/Category";
import { Section } from "../../lib/models/Section";
import { Institution } from "../../lib/models/miscellaneous";
import { Transaction } from "../../lib/models/Transaction";
import { SplitTransaction } from "../../lib/models/SplitTransaction";
import { InvestmentTransaction } from "../../lib/models/InvestmentTransaction";
import {
  AccountDictionary,
  BudgetDictionary,
  CategoryDictionary,
  InstitutionDictionary,
  SectionDictionary,
  TransactionDictionary,
} from "../../lib/models/Data";
import { TransactionFamilies } from "../../lib/models/Calculations";
import { VALID_TYPES } from "../../components/TransactionsPageTitle";
import { LocalDate } from "common";

const ACCOUNT_ID = "acc-brokerage";
const OTHER_ACCOUNT_ID = "acc-checking";

const makeCtx = (): OrderingContext => {
  const accounts = new AccountDictionary();
  accounts.set(
    ACCOUNT_ID,
    new Account({
      account_id: ACCOUNT_ID,
      name: "Brokerage",
      custom_name: "Retirement Brokerage",
      institution_id: "ins-1",
      type: AccountType.Investment,
    }),
  );
  accounts.set(
    OTHER_ACCOUNT_ID,
    new Account({
      account_id: OTHER_ACCOUNT_ID,
      name: "Everyday Checking",
      institution_id: "ins-2",
      type: AccountType.Depository,
      label: { budget_id: "bud-2" },
    }),
  );

  const institutions = new InstitutionDictionary();
  institutions.set("ins-1", new Institution({ institution_id: "ins-1", name: "Fidelity" }));
  institutions.set("ins-2", new Institution({ institution_id: "ins-2", name: "Ally" }));

  const budgets = new BudgetDictionary();
  budgets.set("bud-1", new Budget({ budget_id: "bud-1", name: "Household" }));
  budgets.set("bud-2", new Budget({ budget_id: "bud-2", name: "Account Default Budget" }));

  const sections = new SectionDictionary();
  sections.set("sec-1", new Section({ section_id: "sec-1", budget_id: "bud-1", name: "Utilities" }));

  const categories = new CategoryDictionary();
  categories.set(
    "cat-1",
    new Category({ category_id: "cat-1", section_id: "sec-1", name: "Electricity" }),
  );

  return {
    accounts,
    institutions,
    budgets,
    sections,
    categories,
    transactions: new TransactionDictionary(),
    transactionFamilies: new TransactionFamilies(),
  };
};

const makeInvestment = (
  id: string,
  date: string,
  amount: number,
  name = "Unknown",
): InvestmentTransaction =>
  new InvestmentTransaction({
    investment_transaction_id: id,
    account_id: ACCOUNT_ID,
    date,
    amount,
    name,
    type: InvestmentTransactionType.Buy,
    subtype: InvestmentTransactionSubtype.Buy,
  });

const idsOf = (rows: { id: string }[]) => rows.map((e) => e.id);
const format = (e: TransactionRow, key: string, ctx: OrderingContext) =>
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  formatSortValue(e, key as any, ctx);

describe("buildSortKey", () => {
  test("the investment slot is distinct from the cash slot", () => {
    expect(buildSortKey(false, [])).toBe("transactions");
    expect(buildSortKey(true, [])).toBe("transactions_investment");
    expect(buildSortKey(false, ["expenses"])).toBe("transactions_expenses");
    expect(buildSortKey(true, ["expenses"])).toBe("transactions_investment_expenses");
  });

  test("no cash/investment pair of type-filter subsets produces the same key", () => {
    // The full `VALID_TYPES` product, so the collision-freedom claim is
    // checked rather than argued from `"investment"` not being a type.
    // Derived from `VALID_TYPES` rather than hand-copied so a seventh
    // type widens the product instead of leaving this green at the old
    // one. The floor is what stops a degenerate import from shrinking
    // the product and leaving an "exhaustive" claim that covers two keys.
    expect(VALID_TYPES.length).toBeGreaterThanOrEqual(6);
    const subsets = 1 << VALID_TYPES.length;
    const keys = new Set<string>();
    for (let mask = 0; mask < subsets; mask++) {
      const types = VALID_TYPES.filter((_, i) => mask & (1 << i));
      for (const isInvestment of [false, true]) {
        keys.add(buildSortKey(isInvestment, types));
      }
    }
    expect(keys.size).toBe(2 * subsets);
  });
});

describe("formatSortValue — investment rows", () => {
  test("date resolves to a Date so the comparison is not discarded", () => {
    const ctx = makeCtx();
    const value = formatSortValue(makeInvestment("i-1", "2026-02-17", -100), "date", ctx);
    expect(value).toBeInstanceOf(Date);
    expect((value as Date).getFullYear()).toBe(2026);
    expect((value as Date).getMonth()).toBe(1);
    expect((value as Date).getDate()).toBe(17);
  });

  test("amount resolves to a number, including a zero-amount manual row", () => {
    const ctx = makeCtx();
    expect(formatSortValue(makeInvestment("i-1", "2026-02-17", -250.5), "amount", ctx)).toBe(-250.5);
    // Falling through to the generic `|| e.id` tail here would hand the
    // comparator a string and silently drop the row out of the ordering.
    expect(formatSortValue(makeInvestment("i-2", "2026-02-17", 0), "amount", ctx)).toBe(0);
  });

  test("account resolves to the rendered name, preferring custom_name", () => {
    const ctx = makeCtx();
    expect(formatSortValue(makeInvestment("i-1", "2026-02-17", -1), "account", ctx)).toBe(
      "Retirement Brokerage",
    );
  });

  test("institution resolves through the account", () => {
    const ctx = makeCtx();
    expect(formatSortValue(makeInvestment("i-1", "2026-02-17", -1), "institution", ctx)).toBe(
      "Fidelity",
    );
  });
});

describe("formatSortValue — cash rows", () => {
  // This formatter is shared with the investment view, so an edit aimed
  // at investment rows can silently re-order the cash list. These pin
  // the cash arms against that.
  const makeTxn = () =>
    new Transaction({
      transaction_id: "txn-1",
      account_id: OTHER_ACCOUNT_ID,
      name: "SQ *BLUE BOTTLE",
      merchant_name: "Blue Bottle Coffee",
      amount: 40,
      date: "2026-02-17",
      authorized_date: "2026-02-15",
      location: { city: "Oakland", region: "CA", country: "US" },
      label: { category_id: "cat-1" },
    });

  test("merchant_name prefers the merchant, falling back to the raw name", () => {
    const ctx = makeCtx();
    expect(format(makeTxn(), "merchant_name", ctx)).toBe("Blue Bottle Coffee");

    const noMerchant = new Transaction({ ...makeTxn(), merchant_name: null });
    expect(format(noMerchant, "merchant_name", ctx)).toBe("SQ *BLUE BOTTLE");
  });

  test("date prefers authorized_date over date", () => {
    const ctx = makeCtx();
    const value = format(makeTxn(), "date", ctx) as Date;
    expect(value.getDate()).toBe(15);
  });

  test("amount is the split-aware remaining amount, not the raw amount", () => {
    const ctx = makeCtx();
    const parent = makeTxn();
    const split = new SplitTransaction({
      split_transaction_id: "split-1",
      transaction_id: "txn-1",
      account_id: OTHER_ACCOUNT_ID,
      amount: 15,
    });
    ctx.transactionFamilies.set("txn-1", [split]);

    expect(parent.amount).toBe(40);
    expect(format(parent, "amount", ctx)).toBe(25);
  });

  test("budget falls back to the account's default budget", () => {
    const ctx = makeCtx();
    // Row carries no budget_id of its own; the account routes to bud-2.
    expect(format(makeTxn(), "budget", ctx)).toBe("Account Default Budget");

    const labeled = new Transaction({ ...makeTxn(), label: { budget_id: "bud-1" } });
    expect(format(labeled, "budget", ctx)).toBe("Household");
  });

  test("location joins city with region, falling back to country", () => {
    const ctx = makeCtx();
    expect(format(makeTxn(), "location", ctx)).toBe("Oakland, CA");

    const noRegion = new Transaction({
      ...makeTxn(),
      location: { city: "Berlin", region: null, country: "DE" },
    });
    expect(format(noRegion, "location", ctx)).toBe("Berlin, DE");
  });

  test("category resolves through the row's own label", () => {
    const ctx = makeCtx();
    expect(format(makeTxn(), "category", ctx)).toBe("Electricity");
  });
});

describe("formatSortValue — split rows resolve their parent through the context", () => {
  const setup = () => {
    const ctx = makeCtx();
    ctx.transactions.set(
      "txn-1",
      new Transaction({
        transaction_id: "txn-1",
        account_id: OTHER_ACCOUNT_ID,
        name: "SQ *BLUE BOTTLE",
        merchant_name: "Blue Bottle Coffee",
        date: "2026-02-17",
        authorized_date: "2026-02-15",
        location: { city: "Oakland", region: "CA", country: "US" },
      }),
    );
    const split = new SplitTransaction({
      split_transaction_id: "split-1",
      transaction_id: "txn-1",
      account_id: OTHER_ACCOUNT_ID,
      amount: 15,
      label: { category_id: "cat-1" },
    });
    return { ctx, split };
  };

  test("merchant_name comes from the parent", () => {
    const { ctx, split } = setup();
    // Resolving through `SplitTransaction.toTransaction()` instead would
    // read the `globalData` singleton and return the model default here.
    expect(format(split, "merchant_name", ctx)).toBe("Blue Bottle Coffee");
  });

  test("date comes from the parent's authorized_date", () => {
    const { ctx, split } = setup();
    // The whole instant, not the day-of-month: a split resolved through
    // the model default carries today's date, which collides on the
    // 15th of every month and leaves the assertion inert that day.
    expect((format(split, "date", ctx) as Date).getTime()).toBe(
      new LocalDate("2026-02-15").getTime(),
    );
  });

  test("location comes from the parent", () => {
    const { ctx, split } = setup();
    expect(format(split, "location", ctx)).toBe("Oakland, CA");
  });

  test("amount and category stay the split's own", () => {
    const { ctx, split } = setup();
    expect(format(split, "amount", ctx)).toBe(15);
    expect(format(split, "category", ctx)).toBe("Electricity");
  });
});

describe("orderRows — the ordering tail both views share", () => {
  // Ids deliberately ordered so a plain `investment_transaction_id`
  // comparison disagrees with every column ordering asserted below.
  const rows = (): TransactionRow[] => [
    makeInvestment("o-1", "2026-02-03", -300),
    makeInvestment("a-1", "2026-02-17", -100),
    makeInvestment("D-1", "2026-02-04", -500),
    makeInvestment("1-1", "2026-02-13", -200),
  ];
  const noHit = () => 0;

  test("the header's date-descending default is applied to investment rows", () => {
    const sorted = orderRows(
      rows(),
      new Map([["date", "descending"]]),
      makeCtx(),
      noHit,
      "",
    );
    expect(idsOf(sorted)).toEqual(["a-1", "1-1", "D-1", "o-1"]);
  });

  test("date ascending", () => {
    const sorted = orderRows(rows(), new Map([["date", "ascending"]]), makeCtx(), noHit, "");
    expect(idsOf(sorted)).toEqual(["o-1", "D-1", "1-1", "a-1"]);
  });

  test("amount descending then ascending give opposite orders", () => {
    const desc = orderRows(rows(), new Map([["amount", "descending"]]), makeCtx(), noHit, "");
    expect(idsOf(desc)).toEqual(["a-1", "1-1", "o-1", "D-1"]);

    const asc = orderRows(rows(), new Map([["amount", "ascending"]]), makeCtx(), noHit, "");
    expect(idsOf(asc)).toEqual(["D-1", "o-1", "1-1", "a-1"]);
  });

  test("with no sortings at all the base order is ascending id, not input order", () => {
    const sorted = orderRows(rows(), new Map(), makeCtx(), noHit, "");
    expect(idsOf(sorted)).toEqual(["1-1", "D-1", "a-1", "o-1"]);
  });

  test("a search re-ranks on top of the column sort", () => {
    const ctx = makeCtx();
    const scored = (searchValue: string, row: TransactionRow) =>
      row.id === "o-1" && searchValue === "match" ? 1 : 0;

    const unsearched = orderRows(rows(), new Map([["date", "descending"]]), ctx, scored, "");
    expect(idsOf(unsearched)[3]).toBe("o-1");

    const searched = orderRows(rows(), new Map([["date", "descending"]]), ctx, scored, "match");
    expect(idsOf(searched)[0]).toBe("o-1");
  });

  test("a split keys its base order on its parent, so it stays with the parent", () => {
    const ctx = makeCtx();
    const parentA = new Transaction({ transaction_id: "txn-a", account_id: OTHER_ACCOUNT_ID });
    const parentB = new Transaction({ transaction_id: "txn-b", account_id: OTHER_ACCOUNT_ID });
    const splitOfA = new SplitTransaction({
      // An id that sorts AFTER txn-b, so keying on the split's own id
      // would strand it at the end instead of next to its parent.
      split_transaction_id: "zzz-split",
      transaction_id: "txn-a",
      account_id: OTHER_ACCOUNT_ID,
    });

    const sorted = orderRows([parentA, parentB, splitOfA], new Map(), ctx, noHit, "");
    expect(idsOf(sorted)).toEqual(["txn-a", "zzz-split", "txn-b"]);
  });

  test("the caller's array is not mutated", () => {
    const input = rows();
    const before = idsOf(input);
    orderRows(input, new Map([["date", "descending"]]), makeCtx(), noHit, "");
    expect(idsOf(input)).toEqual(before);
  });
});

describe("applySortings — the comparator orderRows is built on", () => {
  test("ascending and descending are exact inverses for the same key", () => {
    const rows = () => [
      makeInvestment("o-1", "2026-02-03", -300),
      makeInvestment("a-1", "2026-02-17", -100),
      makeInvestment("D-1", "2026-02-04", -500),
    ];
    const ctx = makeCtx();
    const asc = applySortings(rows(), new Map([["date", "ascending"]]), (e, key) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatSortValue(e, key as any, ctx),
    );
    const desc = applySortings(rows(), new Map([["date", "descending"]]), (e, key) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      formatSortValue(e, key as any, ctx),
    );
    expect(idsOf(asc)).toEqual([...idsOf(desc)].reverse());
  });

  test("an earlier entry's tiebreak survives both directions of the primary key", () => {
    const rows = () => [
      makeInvestment("i-A", "2026-06-30", -100),
      makeInvestment("i-B", "2026-06-30", -900),
      makeInvestment("i-C", "2026-06-30", -500),
      makeInvestment("i-D", "2026-06-01", -700),
    ];
    const ctx = makeCtx();
    const byDate = (direction: "ascending" | "descending") =>
      idsOf(
        applySortings(
          rows(),
          new Map([
            ["amount", "descending"],
            ["date", direction],
          ]),
          (e, key) => format(e, key as string, ctx),
        ),
      );

    expect(byDate("descending")).toEqual(["i-A", "i-C", "i-B", "i-D"]);
    expect(byDate("ascending")).toEqual(["i-D", "i-A", "i-C", "i-B"]);
  });
});

describe("getSearchPool", () => {
  test("an InvestmentTransaction contributes its name and its account context", () => {
    const ctx = makeCtx();
    const row = makeInvestment("i-1", "2026-02-17", -100, "VANGUARD 500 IDX");
    row.label.budget_id = "bud-1";
    row.label.category_id = "cat-1";

    const pool = getSearchPool(row, ctx);
    expect(pool).toContain("VANGUARD 500 IDX");
    expect(pool).toContain("Retirement Brokerage");
    expect(pool).toContain("Fidelity");
    expect(pool).toContain("Household");
    expect(pool).toContain("Utilities");
    expect(pool).toContain("Electricity");
  });

  test("a SplitTransaction contributes its parent's name and merchant name", () => {
    const ctx = makeCtx();
    ctx.transactions.set(
      "txn-1",
      new Transaction({
        transaction_id: "txn-1",
        account_id: ACCOUNT_ID,
        name: "SQ *BLUE BOTTLE",
        merchant_name: "Blue Bottle Coffee",
      }),
    );

    const split = new SplitTransaction({
      split_transaction_id: "split-1",
      transaction_id: "txn-1",
      account_id: ACCOUNT_ID,
      amount: -4,
      label: { category_id: "cat-1" },
    });

    const pool = getSearchPool(split, ctx);
    expect(pool).toContain("SQ *BLUE BOTTLE");
    expect(pool).toContain("Blue Bottle Coffee");
    expect(pool).toContain("Electricity");
  });

  test("a whole Transaction keeps the pool it always had", () => {
    const ctx = makeCtx();
    const txn = new Transaction({
      transaction_id: "txn-1",
      account_id: ACCOUNT_ID,
      name: "SQ *BLUE BOTTLE",
      merchant_name: "Blue Bottle Coffee",
      label: { budget_id: "bud-1", category_id: "cat-1" },
    });

    expect(getSearchPool(txn, ctx)).toEqual([
      "SQ *BLUE BOTTLE",
      "Blue Bottle Coffee",
      "Retirement Brokerage",
      "Fidelity",
      "Household",
      "Utilities",
      "Electricity",
    ]);
  });
});
