import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { Account, Data, Item } from "client";
import { AccountSubtype, AccountType } from "common/lib/plaid-enums";
import { ItemProvider } from "common";
import { buildContext, renderWithContext, resetDom } from "test-render";
import { AccountProperties } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

const renderProperties = (account: Account, item: Item) => {
  const data = new Data();
  data.accounts.set(account.account_id, account);
  data.items.set(item.item_id, item);
  renderWithContext(<AccountProperties account={account} />, buildContext({ data }));
};

/** The text of the `.row` whose key span reads `label`. */
const rowText = (label: string) => screen.getByText(label).closest(".row")?.textContent ?? "";

describe("AccountProperties — Type / Subtype (#768)", () => {
  it("shows the real type under Type and the subtype under Subtype for a Plaid brokerage", () => {
    const item = new Item({ item_id: "item-brokerage", provider: ItemProvider.PLAID });
    const account = new Account({
      account_id: "acc-brokerage",
      name: "Brokerage",
      type: AccountType.Investment,
      subtype: AccountSubtype.Brokerage,
      item_id: item.item_id,
    } as never);
    renderProperties(account, item);

    expect(rowText("Type")).toContain("Investment");
    expect(rowText("Type")).not.toContain("Brokerage");
    expect(rowText("Subtype")).toContain("Brokerage");
  });

  it("shows Depository / Checking for a Plaid checking account", () => {
    const item = new Item({ item_id: "item-checking", provider: ItemProvider.PLAID });
    const account = new Account({
      account_id: "acc-checking",
      name: "Checking",
      type: AccountType.Depository,
      subtype: AccountSubtype.Checking,
      item_id: item.item_id,
    } as never);
    renderProperties(account, item);

    expect(rowText("Type")).toContain("Depository");
    expect(rowText("Type")).not.toContain("Checking");
    expect(rowText("Subtype")).toContain("Checking");
  });

  it("keeps the editable type select and shows no Subtype row for a manual account", () => {
    const item = new Item({ item_id: "item-manual", provider: ItemProvider.MANUAL });
    const account = new Account({
      account_id: "acc-manual",
      name: "Manual investment",
      type: AccountType.Investment,
      subtype: null,
      item_id: item.item_id,
    } as never);
    renderProperties(account, item);

    const typeRow = screen.getByText("Type").closest(".row");
    expect(typeRow?.querySelector("select")?.value).toBe("investment");
    expect(screen.queryByText("Subtype")).toBeNull();
  });
});
