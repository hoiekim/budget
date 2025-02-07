import {
  Account,
  Holding,
  Institution,
  InvestmentTransaction,
  Item,
  Security,
  Transaction,
} from "common";
import { decodeAccessUrl } from "./tokens";
import {
  translateAccount,
  translateHolding,
  translateInvestmentTransaction,
  translateTransaction,
  SimpleFinAccount,
} from "./translators";

export interface GetSimpleFinDataOptions {
  startDate: Date;
  endDate?: Date;
  accountId?: string;
}

export const getData = async (item: Item, options: GetSimpleFinDataOptions) => {
  const { access_token } = item;
  const { startDate, endDate = new Date(), accountId } = options;
  const { url, credentials } = decodeAccessUrl(access_token);

  const params = new URLSearchParams();
  params.append("start-date", Math.floor(startDate.valueOf() / 1000).toString());
  params.append("end-date", Math.floor(endDate.valueOf() / 1000).toString());
  params.append("pending", "1");
  if (accountId) params.append("account", accountId);

  const response = await fetch(`${url}/accounts?${params.toString()}`, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  type ResponseData = { errors: any[]; accounts: SimpleFinAccount[] };
  const data: ResponseData = await response.json();

  return modelize(item, data.accounts);
};

const modelize = async (item: Item, simpleFinAccounts: SimpleFinAccount[]) => {
  const accounts: Account[] = [];
  const institutions: Institution[] = [];
  const transactions: Transaction[] = [];
  const investmentTransactions: InvestmentTransaction[] = [];
  const holdings: Holding[] = [];
  const securities: Security[] = [];

  for (const simpleFinAccount of simpleFinAccounts) {
    const { transactions: simpleFinTransactions, holdings: simpleFinHoldings } = simpleFinAccount;

    const { account, institution } = translateAccount(simpleFinAccount, item);
    accounts.push(account);
    institutions.push(institution);

    if (simpleFinHoldings.length) {
      simpleFinTransactions.forEach((t) => {
        const investmentTransaction = translateInvestmentTransaction(t, simpleFinAccount);
        investmentTransactions.push(investmentTransaction);
      });
    } else {
      simpleFinTransactions.forEach((t) => {
        const transaction = translateTransaction(t, simpleFinAccount);
        transactions.push(transaction);
      });
    }

    simpleFinHoldings.forEach((h) => {
      const { holding, security } = translateHolding(h, simpleFinAccount);
      holdings.push(holding);
      securities.push(security);
    });
  }

  return { accounts, institutions, transactions, investmentTransactions, holdings, securities };
};
