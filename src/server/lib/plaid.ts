import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  LinkTokenCreateRequest,
  Products,
  CountryCode,
  TransactionsSyncRequest,
  Transaction as PlaidTransaction,
  RemovedTransaction,
  Institution as PlaidInstitution,
  PlaidError,
  AccountBase,
} from "plaid";
import { MaskedUser } from "server";

export type { RemovedTransaction } from "plaid";

export interface TransactionLabel {
  budget_id: string;
  category_id: string;
}

export interface Transaction extends PlaidTransaction {
  /**
   * Represents relations by pair of budget_id and category_id
   */
  labels: TransactionLabel[];
}

export type Institution = PlaidInstitution;

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

export const getItem = async (user: MaskedUser, access_token: string): Promise<Item> => {
  const client = getClient(user);

  const response = await client.itemGet({ access_token });

  const { item: plaidItem } = response.data;
  const { institution_id, item_id } = plaidItem;

  return { item_id, access_token, institution_id: institution_id || undefined };
};

export type ItemError = PlaidError & { item_id: string };

export const getTransactions = async (user: MaskedUser) => {
  const client = getClient(user);

  type PlaidTransactionsResponse = {
    errors: ItemError[];
    added: PlaidTransaction[];
    removed: RemovedTransaction[];
    modified: PlaidTransaction[];
  };

  const data: PlaidTransactionsResponse = {
    errors: [],
    added: [],
    removed: [],
    modified: [],
  };

  const allAdded: PlaidTransaction[][] = [];
  const allRemoved: RemovedTransaction[][] = [];
  const allModified: PlaidTransaction[][] = [];

  const fetchJobs = user.items.map(async (item) => {
    const thisItemAdded: PlaidTransaction[][] = [];
    const thisItemRemoved: RemovedTransaction[][] = [];
    const thisItemModified: PlaidTransaction[][] = [];
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

        thisItemAdded.push(added);
        thisItemRemoved.push(removed);
        thisItemModified.push(modified);

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

export interface PlaidAccount extends AccountBase {
  /**
   * The ID of the institution that the account belongs to.
   */
  institution_id?: string;
  /**
   * The ID of the item that the account belongs to.
   */
  item_id: string;
}

export interface Account extends PlaidAccount {
  /**
   * User defined name. This name is dintinct from account.name or
   * account.official_name which are provided Plaid.
   */
  custom_name: string;
  /**
   * Determines if the account is hidden in the budget. If hidden, the account
   * is not considered when calculating remaining budget and so on.
   */
  labels: AccountLabel[];
}

export interface AccountLabel {
  budget_id: string;
  hide: boolean;
}

export const getAccounts = async (user: MaskedUser) => {
  const client = getClient(user);

  type PlaidAccountsResponse = {
    errors: ItemError[];
    accounts: PlaidAccount[];
  };

  const data: PlaidAccountsResponse = {
    errors: [],
    accounts: [],
  };

  const allAccounts: PlaidAccount[][] = [];

  const fetchJobs = user.items.map(async (item) => {
    const { item_id, access_token, institution_id } = item;
    try {
      const response = await client.accountsGet({ access_token });
      const { accounts } = response.data;
      const filledAccounts: PlaidAccount[] = accounts.map((e) => {
        return { ...e, institution_id, item_id };
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
