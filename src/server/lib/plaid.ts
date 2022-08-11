import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  LinkTokenCreateRequest,
  Products,
  CountryCode,
  Transaction as PlaidTransaction,
  RemovedTransaction,
  TransactionsSyncRequest,
  Institution as PlaidInstitution,
  PlaidError,
  AccountBalance,
  AccountType,
  AccountSubtype,
  AccountBaseVerificationStatusEnum,
} from "plaid";
import { MaskedUser } from "server";

export interface Label {
  budget_id: string;
  category_id: string;
}

export interface Transaction extends PlaidTransaction {
  /**
   * Represents relations by pair of budget_id and category_id
   */
  labels: Label[];
}

export interface Institution extends PlaidInstitution {}

const { PLAID_CLIENT_ID, PLAID_SECRET_DEVELOPMENT, PLAID_SECRET_SANDBOX } = process.env;

if (!PLAID_CLIENT_ID || !PLAID_SECRET_DEVELOPMENT || !PLAID_SECRET_SANDBOX) {
  console.warn("Plaid is not cofigured. Check env vars.");
}

const getClient = (user: MaskedUser) => {
  const isDemo = user.username === "demo";
  const config = new Configuration({
    basePath: isDemo ? PlaidEnvironments.sandbox : PlaidEnvironments.development,
    baseOptions: {
      headers: {
        "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
        "PLAID-SECRET": isDemo ? PLAID_SECRET_SANDBOX : PLAID_SECRET_DEVELOPMENT,
      },
    },
  });
  return new PlaidApi(config);
};

export const getLinkToken = async (user: MaskedUser, access_token?: string) => {
  const client = getClient(user);

  const request: LinkTokenCreateRequest = {
    user: { client_user_id: user.user_id },
    client_name: "Budget App",
    country_codes: [CountryCode.Us],
    language: "en",
  };

  if (access_token) request.access_token = access_token;
  else request.products = [Products.Auth, Products.Transactions];

  const response = await client.linkTokenCreate(request);

  return response.data;
};

export interface Item {
  item_id: string;
  access_token: string;
  institution_id?: string;
  cursor?: string;
  plaidError?: PlaidError;
}

export const exchangePublicToken = async (user: MaskedUser, public_token: string) => {
  const client = getClient(user);

  const response = await client.itemPublicTokenExchange({ public_token });

  return response.data;
};

export interface PbulicTokenResponse {
  item: Item;
}

export const getItem = async (user: MaskedUser, access_token: string): Promise<Item> => {
  const client = getClient(user);

  const response = await client.itemGet({ access_token });

  const { item: plaidItem } = response.data;
  const { institution_id, item_id } = plaidItem;

  return { item_id, access_token, institution_id: institution_id || undefined };
};

export type ItemError = PlaidError & { item_id: string };

export interface TransactionsResponse {
  errors: ItemError[];
  added: Transaction[];
  removed: RemovedTransaction[];
  modified: Transaction[];
}

export const getTransactions = async (
  user: MaskedUser
): Promise<TransactionsResponse> => {
  const client = getClient(user);

  const data: TransactionsResponse = {
    errors: [],
    added: [],
    removed: [],
    modified: [],
  };

  const allAdded: Transaction[][] = [];
  const allRemoved: RemovedTransaction[][] = [];
  const allModified: Transaction[][] = [];

  const fetchJobs = user.items.map(async (item) => {
    const thisItemAdded: Transaction[][] = [];
    const thisItemRemoved: RemovedTransaction[][] = [];
    const thisItemModified: Transaction[][] = [];
    let hasMore = true;

    while (hasMore) {
      const { item_id, access_token, cursor } = item;

      try {
        const request: TransactionsSyncRequest = {
          access_token: access_token,
          cursor: cursor,
        };
        const response = await client.transactionsSync(request);
        const { added, removed, modified, has_more, next_cursor } = response.data;

        const fill = (e: PlaidTransaction) => {
          return { ...e, labels: [] };
        };

        thisItemAdded.push(added.map(fill));
        thisItemRemoved.push(removed);
        thisItemModified.push(modified.map(fill));

        hasMore = has_more;
        item.cursor = next_cursor;
      } catch (error: any) {
        const plaidError = error?.response?.data as PlaidError;
        console.error(plaidError);
        console.error("Failed to get transactions data for item:", item_id);
        if (plaidError) data.errors.push({ ...plaidError, item_id });
        hasMore = false;
      }
    }

    allAdded.push(thisItemAdded.flat());
    allRemoved.push(thisItemRemoved.flat());
    allModified.push(thisItemModified.flat());

    return;
  });

  await Promise.all(fetchJobs);

  data.added = allAdded.flat();
  data.removed = allRemoved.flat();
  data.modified = allModified.flat();

  return data;
};

export interface Account {
  /**
   * Plaid’s unique identifier for the account. This value will not change unless
   * Plaid can\'t reconcile the account with the data returned by the financial
   * institution. This may occur, for example, when the name of the account changes.
   * If this happens a new `account_id` will be assigned to the account.  The
   * `account_id` can also change if the `access_token` is deleted and the same
   * credentials that were used to generate that `access_token` are used to generate
   * a new `access_token` on a later date. In that case, the new `account_id` will
   * be different from the old `account_id`.  If an account with a specific
   * `account_id` disappears instead of changing, the account is likely closed.
   * Closed accounts are not returned by the Plaid API.  Like all Plaid identifiers,
   * the `account_id` is case sensitive.
   */
  account_id: string;
  balances: AccountBalance;
  /**
   * The last 2-4 alphanumeric characters of an account\'s official account number.
   * Note that the mask may be non-unique between an Item\'s accounts, and it may
   * also not match the mask that the bank displays to the user.
   */
  mask: string | null;
  /**
   * The name of the account, either assigned by the user or by the financial
   * institution itself
   */
  name: string;
  /**
   * The official name of the account as given by the financial institution
   */
  official_name: string | null;
  type: AccountType;
  subtype: AccountSubtype | null;
  /**
   * The current verification status of an Auth Item initiated through Automated or
   * Manual micro-deposits.  Returned for Auth Items only.
   * `pending_automatic_verification`: The Item is pending automatic verification
   * `pending_manual_verification`: The Item is pending manual micro-deposit
   * verification. Items remain in this state until the user successfully verifies
   * the two amounts.  `automatically_verified`: The Item has successfully been
   * automatically verified   `manually_verified`: The Item has successfully been
   * manually verified  `verification_expired`: Plaid was unable to automatically
   * verify the deposit within 7 calendar days and will no longer attempt to
   * validate the Item. Users may retry by submitting their information again
   * through Link.  `verification_failed`: The Item failed manual micro-deposit
   * verification because the user exhausted all 3 verification attempts. Users may
   * retry by submitting their information again through Link.
   */
  verification_status?: AccountBaseVerificationStatusEnum;
  /**
   * Association field linking to budget.budget_id
   */
  budget_ids: string[];
  /**
   * The ID of the institution that the account belongs to.
   */
  institution_id?: string;
  /**
   * The ID of the item that the account belongs to.
   */
  item_id: string;
  config?: AccountConfig;
}

export interface AccountConfig {
  /**
   * Determines if the account is set hidden by user. If this value is true,
   * Budget will not display or calcuate balances or transactions that belong
   * to this account.
   */
  hide?: boolean;
}

export interface AccountsResponse {
  errors: ItemError[];
  accounts: Account[];
}

export const getAccounts = async (user: MaskedUser) => {
  const client = getClient(user);

  const data: AccountsResponse = {
    errors: [],
    accounts: [],
  };

  const allAccounts: Account[][] = [];

  const fetchJobs = user.items.map(async (item) => {
    const { item_id, access_token, institution_id } = item;
    try {
      const response = await client.accountsGet({ access_token });
      const { accounts } = response.data;
      const filledAccounts: Account[] = accounts.map((e) => {
        return { ...e, budget_ids: [], institution_id, item_id };
      });
      allAccounts.push(filledAccounts);
    } catch (error: any) {
      const plaidError = error.response.data as PlaidError;
      console.error(plaidError);
      console.error("Failed to get accounts data for item:", item_id);
      data.errors.push({ ...plaidError, item_id });
    }

    return;
  });

  await Promise.all(fetchJobs);

  data.accounts = allAccounts.flat();

  return data;
};

const institutionsCache = new Map<string, Institution>();

export const getInstitution = async (user: MaskedUser, id: string) => {
  const client = getClient(user);

  const cachedData = institutionsCache.get(id);
  if (cachedData) return cachedData;

  try {
    const response = await client.institutionsGetById({
      institution_id: id,
      country_codes: [CountryCode.Us],
    });

    const { institution } = response.data;

    if (institution) institutionsCache.set(id, institution);

    return institution;
  } catch (error) {
    console.error(error);
    console.error("Failed to get institutions data.");
  }
};
