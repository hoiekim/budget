import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { Account, Data, PATH, Transaction, TransactionLabel } from "client";
import { buildContext, buildRouter, renderWithContext, resetDom } from "test-render";
import TransferRow from "./TransferRow";

afterEach(() => {
  cleanup();
  resetDom();
});

const buildData = () => {
  const data = new Data();
  data.accounts.set("acc-out", new Account({ account_id: "acc-out", name: "Checking" }));
  data.accounts.set("acc-in", new Account({ account_id: "acc-in", name: "Savings" }));
  return data;
};

const leg = (overrides: Partial<Transaction>) =>
  new Transaction({
    account_id: "acc-out",
    date: "2026-01-15",
    authorized_date: "2026-01-15",
    iso_currency_code: "USD",
    merchant_name: null,
    label: new TransactionLabel(),
    ...overrides,
  });

const outgoingLeg = (overrides: Partial<Transaction> = {}) =>
  leg({ transaction_id: "tx-out", amount: 250, name: "ONLINE TRANSFER TO SAVINGS", ...overrides });

const incomingLeg = (overrides: Partial<Transaction> = {}) =>
  leg({
    transaction_id: "tx-in",
    account_id: "acc-in",
    amount: -250,
    name: "ONLINE TRANSFER FROM CHECKING",
    ...overrides,
  });

const render = (transactions: Transaction[]) => {
  const { router } = buildRouter(PATH.TRANSACTIONS);
  return renderWithContext(
    <TransferRow transactions={transactions} />,
    buildContext({ data: buildData(), router }),
  );
};

const title = (container: HTMLElement) =>
  container.querySelector(".merchant_name > .titleLine > .bigText")?.textContent;

describe("TransferRow", () => {
  it("shows the outgoing leg's name whichever order the pair arrives in", () => {
    for (const order of [
      [outgoingLeg(), incomingLeg()],
      [incomingLeg(), outgoingLeg()],
    ]) {
      const { container } = render(order);
      expect(title(container)).toBe("ONLINE TRANSFER TO SAVINGS");
      cleanup();
    }
  });

  it("names the outgoing leg the way its own row would, memo first", () => {
    const { container } = render([
      incomingLeg(),
      outgoingLeg({ merchant_name: "Bank", label: new TransactionLabel({ memo: "Rent savings" }) }),
    ]);
    expect(title(container)).toBe("Rent savings");
  });

  it("falls back to the incoming leg's name when the outgoing leg has none", () => {
    const { container } = render([outgoingLeg({ name: "" }), incomingLeg()]);
    expect(title(container)).toBe("ONLINE TRANSFER FROM CHECKING");
  });

  it("tags the name with a static Transfer chip in the title line", () => {
    const { container } = render([outgoingLeg(), incomingLeg()]);
    const chips = [...container.querySelectorAll(".merchant_name > .titleLine > .transferChip")];
    expect(chips.map((chip) => [chip.tagName, chip.textContent])).toEqual([["SPAN", "Transfer"]]);
    expect(screen.queryByRole("button", { name: "Transfer" })).toBeNull();
  });
});
