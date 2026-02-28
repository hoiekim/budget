import {
  AccountType,
  AccountSubtype,
  AccountBaseVerificationStatusEnum,
  AccountBalance,
} from "plaid";
import { getRandomId, assign, JSONAccount, AccountLabel, AccountGraphOptions } from "common";

export class Account implements JSONAccount {
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
  institution_id: string = "Unknown";
  item_id: string = "Unknown";
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
  label: AccountLabel = {
    budget_id: null,
  };
  /**
   * Graph display preferences for the account.
   */
  graphOptions: AccountGraphOptions = {
    useSnapshots: true,
    useHoldingSnapshots: true,
    useTransactions: true,
  };

  constructor(init?: Partial<Account>) {
    assign(this, init);
  }
}
