import {
  Account,
  getDateString,
  getDateTimeString,
  Holding,
  Institution,
  InvestmentTransaction,
  Item,
  Security,
  Transaction,
  TransactionLabel,
} from "common";
import { randomUUID } from "crypto";
import { AccountType } from "plaid";

export interface SimpleFinAccount {
  id: string;
  org: SimpleFinOrganization;
  name: string;
  currency: string;
  balance: string;
  "available-balance": string;
  "balance-date": number;
  transactions: SimpleFinTransaction[];
  holdings: SimpleFinHolding[];
}

export interface SimpleFinOrganization {
  id: string;
  domain: string;
  name: string;
  "sfin-url": string;
  url: string;
}

export interface SimpleFinTransaction {
  id: string;
  posted: number;
  amount: string;
  description: string;
  payee: string;
  memo: string;
  transacted_at: number;
}

export interface SimpleFinHolding {
  id: string;
  created: number;
  currency: string;
  cost_basis: string;
  description: string;
  market_value: string;
  purchase_price: string;
  shares: string;
  symbol: string;
}

export const translateAccount = (simpleFinAccount: SimpleFinAccount, item: Item) => {
  const { item_id } = item;
  const {
    id: accountId,
    org,
    name,
    currency: currencyString,
    balance: balanceString,
    "available-balance": availableBalance,
    holdings,
  } = simpleFinAccount;

  const balances = {
    available: +availableBalance,
    current: +balanceString,
    limit: null,
    iso_currency_code: currencyString,
    unofficial_currency_code: currencyString,
  };

  const institution = new Institution({
    institution_id: org.id,
    name: org.name,
    url: org.url,
  });

  const isInvestment =
    holdings.length > 0 ||
    name.toLowerCase().includes("investment") ||
    org.name.toLowerCase().includes("investment");

  const account = new Account({
    account_id: accountId,
    name,
    balances,
    institution_id: org.id,
    item_id,
    type: isInvestment ? AccountType.Investment : AccountType.Other,
  });

  return { institution, account };
};

export const translateTransaction = (
  simpleFinTransaction: SimpleFinTransaction,
  simpleFinAccount: SimpleFinAccount
) => {
  const {
    id: transactionId,
    posted,
    amount: amountString,
    description,
    payee,
    memo,
    transacted_at: transactedAt,
  } = simpleFinTransaction;

  return new Transaction({
    transaction_id: transactionId,
    date: getDateTimeString(new Date(posted * 1000)),
    amount: +amountString,
    name: description,
    account_id: simpleFinAccount.id,
    merchant_name: payee,
    authorized_date: getDateTimeString(new Date(transactedAt * 1000)),
    label: new TransactionLabel({ memo }),
  });
};

export const translateInvestmentTransaction = (
  simpleFinTransaction: SimpleFinTransaction,
  simpleFinAccount: SimpleFinAccount
) => {
  const { id: transactionId, posted, amount: amountString, description } = simpleFinTransaction;

  return new InvestmentTransaction({
    investment_transaction_id: transactionId,
    date: getDateTimeString(new Date(posted * 1000)),
    amount: +amountString,
    quantity: +amountString,
    price: 1,
    name: description,
    account_id: simpleFinAccount.id,
  });
};

export const translateHolding = (
  simpleFinHolding: SimpleFinHolding,
  simpleFinAccount: SimpleFinAccount
) => {
  const {
    id: holdingId,
    created,
    currency: currencyString,
    cost_basis: costBasisString,
    market_value: marketValueString,
    shares,
    description,
    symbol,
  } = simpleFinHolding;

  const date = new Date(created * 1000);
  const close_price_as_of = getDateString(date);
  const close_price = +marketValueString / +shares;
  const iso_currency_code = currencyString || simpleFinAccount.currency;

  const security = new Security({
    security_id: randomUUID(),
    ticker_symbol: symbol,
    name: description,
    iso_currency_code,
    close_price,
    close_price_as_of,
  });

  const holding = new Holding({
    account_id: simpleFinAccount.id,
    security_id: security.security_id,
    holding_id: holdingId,
    institution_price: close_price,
    institution_price_as_of: close_price_as_of,
    institution_value: +marketValueString,
    cost_basis: +costBasisString,
    quantity: +shares,
    iso_currency_code,
  });

  return { security, holding };
};
