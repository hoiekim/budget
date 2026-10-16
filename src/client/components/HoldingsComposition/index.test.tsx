import { afterEach, describe, expect, it } from "bun:test";
import { cleanup } from "@testing-library/react";
import {
  Account,
  Calculations,
  Data,
  HoldingSnapshot,
  HoldingValueSummary,
  PATH,
  Security,
  SecuritySnapshot,
} from "client";
import { buildContext, buildRouter, renderWithContext, resetDom } from "test-render";
import { HoldingProperties } from "../HoldingProperties";
import { HoldingsComposition } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

const ACCOUNT_ID = "acc-1";
const SECURITY_ID = "1e743f0a9c";

/** A held security whose own row is `ticker`, optionally with an older price snapshot. */
const buildWorld = ({ ticker = "abcd", snapshotTicker }: { ticker?: string; snapshotTicker?: string } = {}) => {
  const data = new Data();
  const account = new Account({ account_id: ACCOUNT_ID, name: "Plan", type: "investment" } as never);
  data.accounts.set(ACCOUNT_ID, account);
  data.securities.set(
    SECURITY_ID,
    new Security({ security_id: SECURITY_ID, ticker_symbol: ticker, name: "Example Total Market Fund" } as never),
  );
  if (snapshotTicker) {
    data.securitySnapshots.set(
      `ss_${SECURITY_ID}`,
      new SecuritySnapshot({
        snapshot: { snapshot_id: `ss_${SECURITY_ID}`, date: "2025-06-13" },
        security: {
          security_id: SECURITY_ID,
          ticker_symbol: snapshotTicker,
          name: "Former Fund Name",
          close_price: 90,
          close_price_as_of: "2025-06-13",
        },
      } as never),
    );
  }
  const calculations = new Calculations();
  calculations.holdingSnapshots.set(
    `holding_${SECURITY_ID}`,
    new HoldingSnapshot({
      snapshot: { snapshot_id: `holding_${SECURITY_ID}`, date: "2026-01-09" },
      holding: {
        account_id: ACCOUNT_ID,
        security_id: SECURITY_ID,
        quantity: 5,
        institution_price: 100,
        institution_value: 500,
        cost_basis: 450,
        holding_id: `${ACCOUNT_ID}_${SECURITY_ID}`,
      },
    } as never),
  );
  const context = buildContext({ data });
  calculations.holdingsValueData.set(
    `${ACCOUNT_ID}_${SECURITY_ID}`,
    context.viewDate.getEndDate(),
    new HoldingValueSummary({
      value: 500,
      quantity: 5,
      price: 100,
      costBasis: 450,
      security_id: SECURITY_ID,
      account_id: ACCOUNT_ID,
    }),
  );
  return { account, context: { ...context, calculations } };
};

const listedRow = (world: ReturnType<typeof buildWorld>) => {
  const { container } = renderWithContext(<HoldingsComposition accounts={[world.account]} />, world.context);
  return container;
};

const detailPage = (world: ReturnType<typeof buildWorld>, ticker: string) => {
  const params = new URLSearchParams({ account_id: ACCOUNT_ID, ticker });
  const { router } = buildRouter(PATH.HOLDING_DETAIL, params);
  const { container } = renderWithContext(<HoldingProperties />, { ...world.context, router });
  return container;
};

describe("holdings of a security with no price snapshot", () => {
  it("are listed under the security's own ticker and name", () => {
    const container = listedRow(buildWorld());
    const row = container.querySelector('[title="Example Total Market Fund"]');
    expect(row?.textContent).toMatch(/abcd/i);
    expect(container.textContent).not.toContain(SECURITY_ID.slice(0, 6));
  });

  it("open on the detail page from the ticker the list links to", () => {
    expect(detailPage(buildWorld(), "ABCD").textContent).toContain("Example Total Market Fund");
  });
});

describe("holdings whose price snapshot carries an older ticker", () => {
  it("are listed under the security's current ticker and name", () => {
    const container = listedRow(buildWorld({ ticker: "NEWT", snapshotTicker: "OLDT" }));
    const row = container.querySelector('[title="Example Total Market Fund"]');
    expect(row?.textContent).toContain("NEWT");
    expect(container.textContent).not.toContain("OLDT");
  });

  it("open on the detail page from the current ticker", () => {
    const world = buildWorld({ ticker: "NEWT", snapshotTicker: "OLDT" });
    expect(detailPage(world, "NEWT").textContent).toContain("Example Total Market Fund");
  });
});
