import { randomUUID } from "crypto";
import {
  AccountType,
  InvestmentTransactionSubtype,
  InvestmentTransactionType,
  TransactionPaymentChannelEnum,
} from "plaid";
import {
  getDateString,
  getDateTimeString,
  JSONAccount,
  JSONHolding,
  JSONInstitution,
  JSONInvestmentTransaction,
  JSONItem,
  JSONSecurity,
  JSONTransaction,
} from "common";

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

export const translateAccount = (simpleFinAccount: SimpleFinAccount, item: JSONItem) => {
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

  const institution: JSONInstitution = {
    institution_id: org.id,
    name: org.name,
    url: org.url,
    products: [],
    country_codes: [],
    routing_numbers: [],
    oauth: false,
  };

  const isInvestment =
    holdings.length > 0 ||
    name.toLowerCase().includes("investment") ||
    org.name.toLowerCase().includes("investment");

  const account: JSONAccount = {
    account_id: accountId,
    name,
    balances,
    institution_id: org.id,
    item_id,
    type: isInvestment ? AccountType.Investment : AccountType.Other,
    mask: null,
    official_name: null,
    subtype: null,
    custom_name: "",
    hide: false,
    label: {},
    graphOptions: { useSnapshots: true, useTransactions: true },
  };

  return { institution, account };
};

export const translateTransaction = (
  simpleFinTransaction: SimpleFinTransaction,
  simpleFinAccount: SimpleFinAccount,
): JSONTransaction => {
  const {
    id: transactionId,
    posted,
    amount: amountString,
    description,
    payee,
    memo,
    transacted_at: transactedAt,
  } = simpleFinTransaction;

  return {
    transaction_id: transactionId,
    date: getDateTimeString(new Date(posted * 1000)),
    datetime: getDateTimeString(new Date(posted * 1000)),
    amount: +amountString,
    name: description,
    account_id: simpleFinAccount.id,
    merchant_name: payee,
    authorized_date: getDateTimeString(new Date(transactedAt * 1000)),
    authorized_datetime: getDateTimeString(new Date(transactedAt * 1000)),
    label: { memo },
    pending_transaction_id: null,
    category_id: null,
    category: null,
    location: {
      address: null,
      city: null,
      region: null,
      postal_code: null,
      country: null,
      lat: null,
      lon: null,
      store_number: null,
    },
    payment_meta: {
      ppd_id: null,
      by_order_of: null,
      payee: null,
      payer: null,
      payment_method: null,
      payment_processor: null,
      reason: null,
      reference_number: null,
    },
    account_owner: null,
    iso_currency_code: null,
    unofficial_currency_code: null,
    pending: false,
    payment_channel: TransactionPaymentChannelEnum.Other,
    transaction_code: null,
  };
};

export const translateInvestmentTransaction = (
  simpleFinTransaction: SimpleFinTransaction,
  simpleFinAccount: SimpleFinAccount,
): JSONInvestmentTransaction => {
  const { id: transactionId, posted, amount: amountString, description } = simpleFinTransaction;

  return {
    investment_transaction_id: transactionId,
    date: getDateTimeString(new Date(posted * 1000)),
    amount: +amountString,
    quantity: 1,
    price: +amountString,
    name: description,
    account_id: simpleFinAccount.id,
    security_id: null,
    cancel_transaction_id: null,
    type: InvestmentTransactionType.Buy,
    subtype: InvestmentTransactionSubtype.Buy,
    fees: null,
    iso_currency_code: null,
    unofficial_currency_code: null,
  };
};

export const translateHolding = (
  simpleFinHolding: SimpleFinHolding,
  simpleFinAccount: SimpleFinAccount,
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

  const security: JSONSecurity = {
    security_id: randomUUID(),
    ticker_symbol: symbol,
    name: description,
    iso_currency_code,
    close_price,
    close_price_as_of,
    isin: null,
    cusip: null,
    sedol: null,
    institution_security_id: null,
    institution_id: null,
    proxy_security_id: null,
    is_cash_equivalent: null,
    type: null,
    update_datetime: null,
    unofficial_currency_code: null,
    market_identifier_code: null,
    sector: null,
    industry: null,
    option_contract: null,
    fixed_income: null,
  };

  const holding: JSONHolding = {
    account_id: simpleFinAccount.id,
    security_id: security.security_id,
    holding_id: holdingId,
    institution_price: close_price,
    institution_price_as_of: close_price_as_of,
    institution_value: +marketValueString,
    cost_basis: +costBasisString,
    quantity: +shares,
    iso_currency_code,
    unofficial_currency_code: null,
  };

  return { security, holding };
};
