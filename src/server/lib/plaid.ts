import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  LinkTokenCreateRequest,
  Products,
  CountryCode,
  Transaction as PlaidTransaction,
  TransactionsSyncRequest,
  AccountBase,
  Institution as PlaidInstitution,
} from "plaid";
import { MaskedUser } from "server";

export interface Transaction extends PlaidTransaction {}
export interface Institution extends PlaidInstitution {}

const { PLAID_CLIENT_ID, PLAID_SECRET_DEVELOPMENT, PLAID_SECRET_SANDBOX } = process.env;

if (!PLAID_CLIENT_ID || !PLAID_SECRET_DEVELOPMENT || !PLAID_SECRET_SANDBOX) {
  console.warn("Plaid is not cofigured. Check env vars.");
}

const getClient = (user: MaskedUser) => {
  if (user.username === "demo") {
    const sandboxConfig = new Configuration({
      basePath: PlaidEnvironments.sandbox,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
          "PLAID-SECRET": PLAID_SECRET_SANDBOX,
        },
      },
    });

    return new PlaidApi(sandboxConfig);
  } else {
    const devConfig = new Configuration({
      basePath: PlaidEnvironments.development,
      baseOptions: {
        headers: {
          "PLAID-CLIENT-ID": PLAID_CLIENT_ID,
          "PLAID-SECRET": PLAID_SECRET_DEVELOPMENT,
        },
      },
    });

    return new PlaidApi(devConfig);
  }
};

export const getLinkToken = async (user: MaskedUser) => {
  const client = getClient(user);

  const request: LinkTokenCreateRequest = {
    user: { client_user_id: user.id },
    client_name: "Budget App",
    products: [Products.Auth, Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
  };

  const response = await client.linkTokenCreate(request);

  return response.data;
};

export class Item {
  access_token: string;
  item_id: string;
  institution_id?: string;
  cursor?: string;

  constructor(access_token: string, item_id: string) {
    this.access_token = access_token;
    this.item_id = item_id;
  }
}

export const exchangePublicToken = async (user: MaskedUser, public_token: string) => {
  const client = getClient(user);

  const response = await client.itemPublicTokenExchange({ public_token });

  return response.data;
};

export const getItem = async (user: MaskedUser, access_token: string) => {
  const client = getClient(user);

  const response = await client.itemGet({ access_token });

  const { item } = response.data;

  return item;
};

export const getTransactions = async (user: MaskedUser) => {
  const client = getClient(user);

  const fetchJobs = user.items.map(async (item) => {
    try {
      const added: Transaction[][] = [];
      let hasMore = true;

      while (hasMore) {
        const request: TransactionsSyncRequest = {
          access_token: item.access_token,
          cursor: item.cursor,
        };
        const response = await client.transactionsSync(request);
        const data = response.data;
        added.push(data.added);
        hasMore = data.has_more;
        item.cursor = data.next_cursor;
      }

      return added.flat();
    } catch (error) {
      console.error(error);
      console.error("Failed to get transactions data for item:", item.item_id);
    }
    return [];
  });

  return (await Promise.all(fetchJobs)).flat();
};

export interface Account extends AccountBase {
  institution_id?: string;
}

export const getAccounts = async (user: MaskedUser): Promise<Account[]> => {
  const client = getClient(user);

  const fetchJobs = user.items.map(async (item) => {
    const { item_id, access_token, institution_id } = item;
    try {
      const response = await client.accountsGet({ access_token });
      const { accounts } = response.data;
      const filledAccounts: Account[] = accounts.map((e) => {
        return { ...e, institution_id };
      });
      return filledAccounts;
    } catch (error) {
      console.error(error);
      console.error("Failed to get accounts data for item:", item_id);
    }
    return [];
  });

  return (await Promise.all(fetchJobs)).flat();
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
