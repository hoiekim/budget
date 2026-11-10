import {
  AccountType,
  AccountSubtype,
  AccountBaseVerificationStatusEnum,
  AccountBalance,
} from "common/lib/plaid-enums";
import {
  getRandomId,
  assign,
  JSONAccount,
  AccountLabel,
  AccountGraphOptions,
  PlanFundMapping,
} from "common";

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
  // Explicit annotation: without it the field infers the literal type of
  // the default (`"other"`), and every comparison against another member
  // reads as a no-overlap error. The same applies to the other enum
  // defaults in this file's sibling models.
  type: AccountType = AccountType.Other;
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
   * User-set "archived" flag — hides the account from the Accounts page by
   * default while keeping its historical transactions in calc. Distinct
   * from `hide` (duplicate-data shadow). Calc layer ignores this flag.
   */
  archived: boolean = false;
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
  /** How each fund in this account's plan statements maps to a security. */
  plan_fund_mappings?: PlanFundMapping[];

  constructor(init?: Partial<Account>) {
    assign(this, init);
  }
}

/**
 * Whether the account answers to one of the selected account types. The
 * `type` column decides — except modern Plaid reports a brokerage as
 * `type: investment, subtype: brokerage`, so an account also answers to a
 * selected type its `subtype` names (issue 768). Without the subtype leg
 * the Brokerage option in the Accounts type filter matches nothing, even
 * though the detail page used to steer the user toward it.
 */
export const accountMatchesTypes = (
  { type, subtype }: Pick<Account, "type" | "subtype">,
  selectedTypes: AccountType[],
): boolean =>
  selectedTypes.includes(type) ||
  (subtype !== null && (selectedTypes as string[]).includes(subtype));
