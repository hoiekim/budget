// Run with: bun test --preload ./scripts/test-preload.ts index.test.tsx
import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { Account, Data, Item, PATH } from "client";
import { AccountSubtype, AccountType } from "common/lib/plaid-enums";
import { ItemProvider } from "common";
import { buildContext, buildRouter, renderWithContext, resetDom } from "test-render";
import { AccountsPage } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

/** The issue's account set: a Plaid brokerage and a Plaid checking account. */
const buildData = () => {
  const data = new Data();
  const item = new Item({ item_id: "item-768", provider: ItemProvider.PLAID });
  data.items.set(item.item_id, item);
  data.accounts.set(
    "acc-brokerage",
    new Account({
      account_id: "acc-brokerage",
      name: "My Brokerage",
      type: AccountType.Investment,
      subtype: AccountSubtype.Brokerage,
      item_id: item.item_id,
    } as never),
  );
  data.accounts.set(
    "acc-checking",
    new Account({
      account_id: "acc-checking",
      name: "My Checking",
      type: AccountType.Depository,
      subtype: AccountSubtype.Checking,
      item_id: item.item_id,
    } as never),
  );
  return data;
};

const renderPage = (accountType: string | null) => {
  const params = new URLSearchParams();
  if (accountType) params.set("account_type", accountType);
  const { router } = buildRouter(PATH.ACCOUNTS, params);
  renderWithContext(<AccountsPage />, buildContext({ data: buildData(), router }));
};

describe("AccountsPage — type filter (#768)", () => {
  it("finds a Plaid brokerage under Brokerage", () => {
    renderPage("brokerage");

    expect(screen.getByText("My Brokerage")).toBeTruthy();
    expect(screen.queryByText("My Checking")).toBeNull();
  });

  it("finds both accounts under Investment and Depository respectively", () => {
    renderPage("investment");
    expect(screen.getByText("My Brokerage")).toBeTruthy();
    expect(screen.queryByText("My Checking")).toBeNull();

    cleanup();
    resetDom();
    renderPage("depository");
    expect(screen.getByText("My Checking")).toBeTruthy();
    expect(screen.queryByText("My Brokerage")).toBeNull();
  });

  it("shows both accounts with no filter", () => {
    renderPage(null);

    expect(screen.getByText("My Brokerage")).toBeTruthy();
    expect(screen.getByText("My Checking")).toBeTruthy();
  });
});
