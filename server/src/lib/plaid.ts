import fs from "fs";
import {
  Configuration,
  PlaidApi,
  PlaidEnvironments,
  LinkTokenCreateRequest,
  Products,
  CountryCode,
  Transaction,
  // RemovedTransaction,
  TransactionsSyncRequest,
} from "plaid";

const { CLIENT_ID, SECRET_SANDBOX, SECRET_DEVELOPMENT } = process.env;
const SECRET = SECRET_DEVELOPMENT;

if (!CLIENT_ID || !SECRET) {
  console.warn("Plaid is not cofigured. Check env vars.");
}

const configuration = new Configuration({
  basePath: PlaidEnvironments.development,
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
  const response = await client.linkTokenCreate(request);
  return response.data;
};

export class Item {
  token: string;
  id: string;
  constructor(token: string, id: string) {
    this.token = token;
    this.id = id;
  }
}

let items: Item[] = [];

const itemsFilePath = "./.items";

if (fs.existsSync(itemsFilePath)) {
  fs.readFile(itemsFilePath, (error, data) => {
    if (error) {
      console.error("Failed to load initial items data from local disk.");
      return;
    }
    const itemsData = JSON.parse(data.toString());
    if (Array.isArray(itemsData)) items = itemsData;
  });
}

export const exchangePublicToken = async (public_token: string) => {
  const response = await client.itemPublicTokenExchange({ public_token });
  const { access_token, item_id } = response.data;
  items.push(new Item(access_token, item_id));
  fs.writeFile(itemsFilePath, JSON.stringify(items), (error) => {
    if (error) console.error("Failed to write items data to local disk.");
  });
  return response.data;
};

export const getTransactions = () => {
  try {
    const fetchJobs = items.map(async (item) => {
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

        return added;
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
    const fetchJobs = items.map(async (item) => {
      try {
        const response = await client.accountsGet({ access_token: item.token });
        return response.data.accounts;
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

export const getInstitutions = async (id: string) => {
  try {
    const response = await client.institutionsGetById({
      institution_id: id,
      country_codes: [CountryCode.Us],
    });
    return response.data;
  } catch (error) {
    console.error(error);
    console.error("Failed to get institutions data.");
  }
};
