import {
  PlaidError,
  AccountType,
  AccountSubtype,
  AccountBaseVerificationStatusEnum,
  AccountBalance,
} from "plaid";
import { MaskedUser, getPlaidClient, ignorable_error_codes } from "server";
import { Item, Holding, Security } from "common";

export type ItemError = PlaidError & { item_id: string };

/**
 * Properties of `PlaidAccount` type are mostly just simple copies of `AccountBase`.
 * Except that `AccountBase` has mapped properties as `{ [key: string]: any }`.
 * We intend to avoid usage of this explicit `any` for strict type checking.
 */
export interface PlaidAccount {
  /**
   * Plaid’s unique identifier for the account. This value will not change unless
   * Plaid can\'t reconcile the account with the data returned by the financial
   * institution. This may occur, for example, when the name of the account changes.
   * If this happens a new `account_id` will be assigned to the account.  The
   * `account_id` can also change if the `access_token` is deleted and the same
   * credentials that were used to generate that `access_token` are used to generate
   * a new `access_token` on a later date. In that case, the new `account_id` will be
   * different from the old `account_id`.  If an account with a specific `account_id`
   * disappears instead of changing, the account is likely closed. Closed accounts are
   * not returned by the Plaid API.  Like all Plaid identifiers, the `account_id` is
   * case sensitive.
   * @type {string}
   * @memberof AccountBase
   */
  account_id: string;
  /**
   *
   * @type {AccountBalance}
   * @memberof AccountBase
   */
  balances: AccountBalance;
  /**
   * The last 2-4 alphanumeric characters of an account\'s official account number.
   * Note that the mask may be non-unique between an Item\'s accounts, and it may also
   * not match the mask that the bank displays to the user.
   * @type {string}
   * @memberof AccountBase
   */
  mask: string | null;
  /**
   * The name of the account, either assigned by the user or by the financial
   * institution itself
   * @type {string}
   * @memberof AccountBase
   */
  name: string;
  /**
   * The official name of the account as given by the financial institution
   * @type {string}
   * @memberof AccountBase
   */
  official_name: string | null;
  /**
   *
   * @type {AccountType}
   * @memberof AccountBase
   */
  type: AccountType;
  /**
   *
   * @type {AccountSubtype}
   * @memberof AccountBase
   */
  subtype: AccountSubtype | null;
  /**
   * The current verification status of an Auth Item initiated through Automated
   * or Manual micro-deposits.  Returned for Auth Items only.
   * `pending_automatic_verification`: The Item is pending automatic verification
   * `pending_manual_verification`: The Item is pending manual micro-deposit
   * verification. Items remain in this state until the user successfully verifies
   * the two amounts. `automatically_verified`: The Item has successfully been
   * automatically verified `manually_verified`: The Item has successfully been
   * manually verified  `verification_expired`: Plaid was unable to automatically
   * verify the deposit within 7 calendar days and will no longer attempt to validate
   * the Item. Users may retry by submitting their information again through Link.
   * `verification_failed`: The Item failed manual micro-deposit verification because
   * the user exhausted all 3 verification attempts. Users may retry by submitting
   * their information again through Link.
   * @type {string}
   * @memberof AccountBase
   */
  verification_status?: AccountBaseVerificationStatusEnum;
  /**
   * The ID of the institution that the account belongs to.
   */
  institution_id: string;
  /**
   * The ID of the item that the account belongs to.
   */
  item_id: string;
}

export const getAccounts = async (user: MaskedUser, items: Item[]) => {
  const client = getPlaidClient(user);

  type PlaidAccountsResponse = {
    items: Item[];
    accounts: PlaidAccount[];
  };

  const data: PlaidAccountsResponse = {
    items: [],
    accounts: [],
  };

  const allAccounts: PlaidAccount[][] = [];

  const fetchJobs = items.map(async (item) => {
    const { item_id, access_token, institution_id } = item;
    try {
      const response = await client.accountsGet({ access_token });
      const { accounts } = response.data;
      const filledAccounts: PlaidAccount[] = accounts.map((e) => {
        return { ...e, institution_id, item_id };
      });
      allAccounts.push(filledAccounts);
      data.items.push(new Item(item));
    } catch (error: any) {
      const plaidError = error?.response?.data as PlaidError;
      console.error(plaidError);
      console.error("Failed to get accounts data for item:", item_id);
      data.items.push(new Item({ ...item, plaidError }));
    }

    return;
  });

  await Promise.all(fetchJobs);

  data.accounts = allAccounts.flat();

  return data;
};

export const getHoldings = async (user: MaskedUser, items: Item[]) => {
  const client = getPlaidClient(user);

  type PlaidHoldingsResponse = {
    items: Item[];
    accounts: PlaidAccount[];
    holdings: Holding[];
    securities: Security[];
  };

  const data: PlaidHoldingsResponse = {
    items: [],
    accounts: [],
    holdings: [],
    securities: [],
  };

  const allAccounts: PlaidAccount[][] = [];
  const allHoldings: Holding[][] = [];
  const allSecurities: Security[][] = [];

  const fetchJobs = items.map(async (item) => {
    const { item_id, access_token, institution_id } = item;
    try {
      const response = await client.investmentsHoldingsGet({ access_token });
      const { accounts, holdings, securities } = response.data;

      const filledAccounts: PlaidAccount[] = accounts.map((e) => {
        return { ...e, institution_id, item_id };
      });
      allAccounts.push(filledAccounts);

      const filledHoldings = holdings.map((e) => {
        const { account_id, security_id } = e;
        return new Holding({ ...e, holding_id: `${account_id}_${security_id}` });
      });
      allHoldings.push(filledHoldings);

      allSecurities.push(securities.map((e) => new Security(e)));

      data.items.push(new Item(item));
    } catch (error: any) {
      const plaidError = error?.response?.data as PlaidError;
      if (!ignorable_error_codes.has(plaidError?.error_code)) {
        console.error(plaidError);
        console.error("Failed to get holdings data for item:", item_id);
        data.items.push(new Item({ ...item, plaidError }));
      }
    }

    return;
  });

  await Promise.all(fetchJobs);

  data.accounts = allAccounts.flat();
  data.holdings = allHoldings.flat();
  data.securities = allSecurities.flat();

  return data;
};
