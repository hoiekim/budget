import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  LinkTokenCreateRequest,
  Products,
  CountryCode,
  Transaction,
  RemovedTransaction,
  AccountBase,
  TransactionsSyncRequest,
} from "plaid";

const { CLIENT_ID, SECRET_SANDBOX } = process.env;
const SECRET = SECRET_SANDBOX;

if (!CLIENT_ID || !SECRET) {
  console.warn("Plaid is not cofigured. Check env vars.");
}

const configuration = new Configuration({
  basePath: PlaidEnvironments.sandbox,
  baseOptions: {
    headers: {
      "PLAID-CLIENT-ID": CLIENT_ID,
      "PLAID-SECRET": SECRET,
    },
  },
});

export const client = new PlaidApi(configuration);

export const getLinkToken = async () => {
  const request: LinkTokenCreateRequest = {
    user: { client_user_id: "admin" },
    client_name: "Budget App",
    products: [Products.Auth, Products.Transactions],
    country_codes: [CountryCode.Us],
    language: "en",
  };
  try {
    const response = await client.linkTokenCreate(request);
    return response.data;
  } catch (error) {
    console.error(error);
    console.error("Failed create link token.");
  }
};

export class Item {
  token: string;
  id: string;
  transactions: Transaction[];
  accounts: AccountBase[];
  constructor(token: string, id: string) {
    this.token = token;
    this.id = id;
    this.transactions = [];
    this.accounts = [];
  }
}

const db: Item[] = [];

export const exchangePublicToken = async (public_token: string) => {
  try {
    const response = await client.itemPublicTokenExchange({ public_token });
    const token = response.data.access_token;
    const id = response.data.item_id;
    db.push(new Item(token, id));
    return response.data;
  } catch (error) {
    console.error(error);
    console.error("Failed exchange public token.");
  }
};

export const getTransactions = () => {
  try {
    const fetchJobs = db.map(async (item) => {
      try {
        let cursor: string | undefined;
        let added: Transaction[] = [];
        // let modified: Transaction[] = [];
        // let removed: RemovedTransaction[] = [];
        let hasMore = true;

        while (hasMore) {
          const request: TransactionsSyncRequest = {
            access_token: item.token,
            cursor: cursor,
          };
          const response = await client.transactionsSync(request);
          const data = response.data;
          added = added.concat(data.added);
          // modified = modified.concat(data.modified);
          // removed = removed.concat(data.removed);
          hasMore = data.has_more;
          cursor = data.next_cursor;
        }

        item.transactions = added;
        return item.transactions;
      } catch (error) {
        console.error(error);
        console.error("Failed to get transactions data for item:", item.id);
        return [];
      }
    });

    return Promise.all(fetchJobs);
  } catch (error) {
    console.error(error);
    console.error("Failed to get transactions data.");
  }
};

export const getAccounts = () => {
  try {
    const fetchJobs = db.map(async (item) => {
      try {
        const accounts_response = await client.accountsGet({
          access_token: item.token,
        });
        item.accounts = accounts_response.data.accounts;
        return item.accounts;
      } catch (error) {
        console.error(error);
        console.error("Failed to get accounts data for item:", item.id);
      }
      return [];
    });

    return Promise.all(fetchJobs);
  } catch (error) {
    console.error(error);
    console.error("Failed to get accounts data.");
  }
};
