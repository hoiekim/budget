import {
  AccountType,
  AccountSubtype,
  AccountBaseVerificationStatusEnum,
  AccountBalance,
} from "plaid";
import { PlaidAccount } from "server";
import { getRandomId, assign } from "common";

export class AccountLabel {
  budget_id?: string | null;
  constructor(init?: Partial<AccountLabel>) {
    assign(this, init);
  }
}

export class Account implements PlaidAccount {
  get id() {
    return this.account_id;
  }
  set id(_: string) {}

  account_id: string = getRandomId();
  balances: AccountBalance = {
    available: 0,
    current: 0,
    limit: 0,
    iso_currency_code: "USD",
    unofficial_currency_code: "USD",
  };
  mask: string | null = null;
  name: string = "Unknown";
  official_name: string | null = null;
  type = AccountType.Other;
  subtype: AccountSubtype | null = null;
  verification_status?: AccountBaseVerificationStatusEnum;
  institution_id: string = getRandomId();
  item_id: string = getRandomId();
  /**
   * User defined name. This name is dintinct from account.name or
   * account.official_name which are provided Plaid.
   */
  custom_name: string = "";
  /**
   * Determines if the account is hidden. If hidden, the account is not considered
   * when calculating remaining budget and so on.
   */
  hide: boolean = false;
  /**
   * Represents relations by budget_id.
   */
  label = new AccountLabel();

  constructor(init?: Partial<Account>) {
    assign(this, init);
  }
}
