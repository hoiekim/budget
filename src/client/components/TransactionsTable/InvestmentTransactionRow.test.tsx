import { afterEach, describe, expect, it } from "bun:test";
import { cleanup } from "@testing-library/react";
import { InvestmentTransactionSubtype, InvestmentTransactionType } from "plaid";
import { Account, Data, InvestmentTransaction, PATH } from "client";
import { buildContext, buildRouter, renderWithContext, resetDom } from "test-render";
import InvestmentTransactionRow from "./InvestmentTransactionRow";

afterEach(() => {
  cleanup();
  resetDom();
});

const ACCOUNT_ID = "account-1";

const render = (overrides: Partial<InvestmentTransaction>) => {
  const data = new Data();
  data.accounts.set(ACCOUNT_ID, new Account({ account_id: ACCOUNT_ID, name: "Retirement", custom_name: "" }));
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
  return container.querySelector(".amount")?.textContent?.replace(/\u00a0/g, " ") ?? "";
};

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

  it("shows a buy without a sign", () => {
    const amount = render({
      type: InvestmentTransactionType.Buy,
      subtype: InvestmentTransactionSubtype.Contribution,
      quantity: 4,
      price: 250,
      amount: 1000,
    });
    expect(amount).toBe("$ 1,000.00");
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
