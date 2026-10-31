import { afterEach, describe, expect, it } from "bun:test";
import { cleanup } from "@testing-library/react";
import { AccountType } from "plaid";
import { ViewDate } from "common";
import {
  Account,
  Calculations,
  Data,
  HoldingValueSummary,
  Item,
} from "client";
import { buildContext, renderWithContext, resetDom } from "test-render";
import { AccountProperties } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

const ACCOUNT_ID = "acc-1";
const ITEM_ID = "item-1";
const SECURITY_ID = "sec-cash";

/** Live figures: current 1000, available 300 — distinct from every period figure. */
const LIVE = { available: 300, current: 1000 };

const buildWorld = ({
  type,
  periodBalance,
  periodCash,
  viewDate,
}: {
  type: AccountType;
  periodBalance?: number;
  periodCash?: number;
  viewDate?: ViewDate;
}) => {
  const data = new Data();
  data.items.set(ITEM_ID, new Item({ item_id: ITEM_ID }));
  const account = new Account({
    account_id: ACCOUNT_ID,
    name: "Test Account",
    type,
    item_id: ITEM_ID,
    balances: {
      available: LIVE.available,
      current: LIVE.current,
      limit: 0,
      iso_currency_code: "USD",
      unofficial_currency_code: "USD",
    },
  } as never);
  data.accounts.set(ACCOUNT_ID, account);

  const context = buildContext({ data, ...(viewDate ? { viewDate } : {}) });
  const calculations = context.calculations as Calculations;
  const endDate = context.viewDate.getEndDate();
  if (periodBalance !== undefined) {
    // A run of months ending at the view date, so the graph cursor (which
    // seeds the snapshot input below the Balance block) also resolves to
    // the period figure and never leaks the live balance into the page.
    for (let m = 5; m >= 0; m--) {
      const d = new Date(endDate);
      d.setMonth(d.getMonth() - m);
      calculations.balanceData.set(ACCOUNT_ID, d, periodBalance);
    }
  }
  if (periodCash !== undefined) {
    calculations.holdingsValueData.set(
      `${ACCOUNT_ID}_${SECURITY_ID}`,
      endDate,
      new HoldingValueSummary({
        value: periodCash,
        quantity: periodCash,
        price: 1,
        costBasis: periodCash,
        security_id: SECURITY_ID,
        account_id: ACCOUNT_ID,
        isCash: true,
      }),
    );
  }
  return { account, context: { ...context, calculations } };
};

/** The `.property` box under the "Balance" section label — only this block. */
const balanceBlock = (world: ReturnType<typeof buildWorld>) => {
  const { container } = renderWithContext(
    <AccountProperties account={world.account} />,
    world.context,
  );
  const labels = Array.from(container.querySelectorAll(".propertyLabel"));
  const balanceLabel = labels.find((l) => l.textContent?.startsWith("Balance"));
  expect(balanceLabel).toBeDefined();
  const block = balanceLabel!.nextElementSibling;
  expect(block?.classList.contains("property")).toBe(true);
  return { label: balanceLabel!.textContent ?? "", text: block!.textContent ?? "" };
};

describe("Balance block on a past period", () => {
  it("renders the period balance for a depository account, not the live balance", () => {
    const { label, text } = balanceBlock(
      buildWorld({ type: AccountType.Depository, periodBalance: 700 }),
    );
    expect(label).toContain("Jan 2026");
    expect(text).toContain("Current");
    expect(text).toContain("700");
    expect(text).not.toContain("1,000");
    // Pending is a live-derived split with no historical series: hidden.
    expect(text).not.toContain("Pending");
  });

  it("renders the period Spent for a credit account and hides live Available", () => {
    const { text } = balanceBlock(
      buildWorld({ type: AccountType.Credit, periodBalance: 450 }),
    );
    expect(text).toContain("Spent");
    expect(text).toContain("450");
    expect(text).not.toContain("1,000");
    expect(text).not.toContain("300");
    expect(text).not.toContain("Available");
  });

  it("partitions an investment account off the view-date cash holding", () => {
    const { text } = balanceBlock(
      buildWorld({ type: AccountType.Investment, periodBalance: 700, periodCash: 200 }),
    );
    expect(text).toContain("Invested");
    expect(text).toContain("500");
    expect(text).toContain("In Cash");
    expect(text).toContain("200");
    // Neither the live partition (700 invested / 300 cash) nor the
    // unpartitioned period total may appear in the block.
    expect(text).not.toContain("300");
  });

  it("falls back to the live partition when no holding summary exists for the period", () => {
    const { text } = balanceBlock(
      buildWorld({ type: AccountType.Investment, periodBalance: 700 }),
    );
    expect(text).toContain("700");
    expect(text).toContain("300");
  });

  it("falls back to the live balance when no balance is recorded for the period", () => {
    const { text } = balanceBlock(buildWorld({ type: AccountType.Depository }));
    expect(text).toContain("Current");
    expect(text).toContain("1,000");
    expect(text).toContain("Pending");
    expect(text).toContain("700");
  });
});

describe("Balance block on the current period", () => {
  it("renders the live balance unchanged", () => {
    const { label, text } = balanceBlock(
      buildWorld({
        type: AccountType.Depository,
        periodBalance: 700,
        viewDate: new ViewDate("month", new Date()),
      }),
    );
    expect(label).toBe("Balance");
    expect(text).toContain("1,000");
    expect(text).toContain("Pending");
    expect(text).toContain("700");
  });
});
