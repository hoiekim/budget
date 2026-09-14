import { afterEach, describe, expect, it } from "bun:test";
import { cleanup } from "@testing-library/react";
import { Account, Data, PATH, Transaction, TransactionLabel } from "client";
import { buildContext, buildRouter, renderWithContext, resetDom } from "test-render";
import TransactionRow from "./TransactionRow";

afterEach(() => {
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
