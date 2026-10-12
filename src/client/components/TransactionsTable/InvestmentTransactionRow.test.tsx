import { afterEach, describe, expect, it } from "bun:test";
import { cleanup } from "@testing-library/react";
import { InvestmentTransactionSubtype, InvestmentTransactionType } from "plaid";
import { Account, Data, InvestmentTransaction, PATH, Security, TransactionLabel } from "client";
import { buildContext, buildRouter, renderWithContext, resetDom } from "test-render";
import InvestmentTransactionRow from "./InvestmentTransactionRow";

afterEach(() => {
  cleanup();
  resetDom();
});

const ACCOUNT_ID = "account-1";

const SECURITY_ID = "security-1";

const renderRow = (overrides: Partial<InvestmentTransaction>, security?: Partial<Security>) => {
  const data = new Data();
  data.accounts.set(ACCOUNT_ID, new Account({ account_id: ACCOUNT_ID, name: "Retirement", custom_name: "" }));
  if (security) data.securities.set(SECURITY_ID, new Security({ security_id: SECURITY_ID, ...security }));
  const row = new InvestmentTransaction({
    investment_transaction_id: "inv-1",
    account_id: ACCOUNT_ID,
    date: "2026-01-15",
    iso_currency_code: "USD",
    ...overrides,
  });
  const { router } = buildRouter(PATH.TRANSACTIONS);
  const { container } = renderWithContext(
    <InvestmentTransactionRow investmentTransaction={row} />,
    buildContext({ data, router }),
  );
  const text = (selector: string) =>
    container.querySelector(selector)?.textContent?.replace(/\s+/g, " ").trim() ?? "";
  return {
    amount: text(".amount"),
    title: text(".merchant_name .bigText"),
    detail: text(".merchant_name .smallText"),
    hasArrow: container.querySelector(".merchant_name .smallText svg") !== null,
  };
};

const render = (overrides: Partial<InvestmentTransaction>) => renderRow(overrides).amount;

describe("InvestmentTransactionRow — amount sign", () => {
  it("shows a sell without the incoming sign", () => {
    const amount = render({
      type: InvestmentTransactionType.Sell,
      subtype: InvestmentTransactionSubtype.Sell,
      quantity: -20,
      price: 512.5,
      amount: -10250,
    });
    expect(amount).toBe("$ 10,250.00");
  });

  it("shows a buy without a sign, whichever way its amount is signed", () => {
    const amount = render({
      type: InvestmentTransactionType.Buy,
      subtype: InvestmentTransactionSubtype.Contribution,
      quantity: 4,
      price: 250,
      amount: -1000,
    });
    expect(amount).toBe("$ 1,000.00");
  });

  it("keeps the incoming sign on a cancellation", () => {
    const amount = render({
      type: InvestmentTransactionType.Cancel,
      subtype: InvestmentTransactionSubtype.Cancel,
      amount: -1000,
    });
    expect(amount).toBe("+ $ 1,000.00");
  });

  it("keeps the incoming sign on cash arriving in the account", () => {
    const amount = render({
      type: InvestmentTransactionType.Cash,
      subtype: InvestmentTransactionSubtype.Contribution,
      amount: -1000,
    });
    expect(amount).toBe("+ $ 1,000.00");
  });

  it("shows cash leaving the account without a sign", () => {
    const amount = render({
      type: InvestmentTransactionType.Cash,
      subtype: InvestmentTransactionSubtype.ManagementFee,
      amount: 12.5,
    });
    expect(amount).toBe("$ 12.50");
  });
});

describe("InvestmentTransactionRow — trade layout", () => {
  const buy = {
    type: InvestmentTransactionType.Buy,
    subtype: InvestmentTransactionSubtype.Buy,
    security_id: SECURITY_ID,
    name: "Buy (contribution)",
    quantity: 4,
    price: 250,
    amount: 1000,
  };
  const sell = {
    type: InvestmentTransactionType.Sell,
    subtype: InvestmentTransactionSubtype.Sell,
    security_id: SECURITY_ID,
    name: "Sell (rollover)",
    quantity: -4,
    price: 250,
    amount: -1000,
  };

  it("names a buy and shows cash going into the holding", () => {
    const row = renderRow(buy, { ticker_symbol: "IDXF", name: "Index Fund" });
    expect([row.title, row.detail, row.hasArrow]).toEqual(["Buy", "Cash IDXF", true]);
  });

  it("names a sell and shows the holding going into cash", () => {
    const row = renderRow(sell, { ticker_symbol: "IDXF", name: "Index Fund" });
    expect([row.title, row.detail, row.hasArrow]).toEqual(["Sell", "IDXF Cash", true]);
  });

  it("falls back to the security's name when it has no ticker", () => {
    const row = renderRow(buy, { ticker_symbol: null, name: "Stable Value Fund" });
    expect(row.detail).toBe("Cash Stable Value Fund");
  });

  it("names the holding \"Shares\" when the security is unknown", () => {
    const row = renderRow(sell);
    expect([row.title, row.detail]).toEqual(["Sell", "Shares Cash"]);
  });

  it("titles a cash row with its name over the account, like a regular transaction", () => {
    const row = renderRow({
      type: InvestmentTransactionType.Cash,
      subtype: InvestmentTransactionSubtype.Contribution,
      name: "Contribution",
      amount: -1000,
    });
    expect([row.title, row.detail, row.hasArrow]).toEqual(["Contribution", "Retirement", false]);
  });

  it("titles a cash row with its memo when it has one", () => {
    const row = renderRow({
      type: InvestmentTransactionType.Cash,
      subtype: InvestmentTransactionSubtype.Contribution,
      name: "Contribution",
      amount: -1000,
      label: new TransactionLabel({ memo: "Employer match" }),
    });
    expect([row.title, row.detail]).toEqual(["Employer match", "Retirement"]);
  });
});
