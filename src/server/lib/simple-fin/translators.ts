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
  JSONHolding,
  JSONInstitution,
  JSONInvestmentTransaction,
  JSONItem,
  JSONSecurity,
  JSONTransaction,
  SimpleFinAccountBase,
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

export const translateAccount = (simpleFinAccount: SimpleFinAccount, _item: JSONItem) => {
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

  const account: SimpleFinAccountBase = {
    account_id: accountId,
    name,
    balances,
    type: isInvestment ? AccountType.Investment : AccountType.Other,
    mask: null,
    official_name: null,
    subtype: null,
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

/**
 * What a SimpleFin description says about a cash movement, when it says
 * anything more specific than the direction of the money. Whole-word
 * matches only, so a payee name can't trip it. Anything else falls back
 * to the direction inference in `inferCashSubtype` below.
 */
const CASH_SUBTYPE_BY_KEYWORD: [RegExp, InvestmentTransactionSubtype][] = [
  [/\bdividend\b/i, InvestmentTransactionSubtype.Dividend],
  [/\binterest\b/i, InvestmentTransactionSubtype.Interest],
];

const inferCashSubtype = (
  description: string,
  rawAmount: number,
): InvestmentTransactionSubtype => {
  for (const [pattern, subtype] of CASH_SUBTYPE_BY_KEYWORD) {
    if (pattern.test(description)) return subtype;
  }
  // SimpleFin signs amounts positive when money arrives; the app signs
  // investment amounts positive when money leaves, so a positive raw
  // amount is a deposit and a negative one a withdrawal. Zero carries no
  // direction and defaults to deposit.
  return rawAmount >= 0 ? InvestmentTransactionSubtype.Deposit : InvestmentTransactionSubtype.Withdrawal;
};

export const translateInvestmentTransaction = (
  simpleFinTransaction: SimpleFinTransaction,
  simpleFinAccount: SimpleFinAccount,
): JSONInvestmentTransaction => {
  const { id: transactionId, posted, amount: amountString, description } = simpleFinTransaction;

  // A SimpleFin investment-account row carries no security and no share
  // movement, so it is a cash row, not a buy: quantity 0, no per-share
  // price, and the amount flipped to the app's sign convention (positive
  // when money leaves — Plaid's convention; see the cash fold in
  // client/lib/hooks/calculation/accounts.ts). SimpleFin signs the other
  // way round, positive when money arrives. As a cash row it renders with
  // a sign, lands in the Deposits/Expenses filters, and folds into the
  // balance tier's cash instead of its cost basis.
  const rawAmount = +amountString;
  const amount = rawAmount === 0 ? 0 : -rawAmount;
  return {
    investment_transaction_id: transactionId,
    date: getDateTimeString(new Date(posted * 1000)),
    amount,
    quantity: 0,
    price: 0,
    name: description,
    account_id: simpleFinAccount.id,
    security_id: null,
    cancel_transaction_id: null,
    type: InvestmentTransactionType.Cash,
    subtype: inferCashSubtype(description, rawAmount),
    fees: null,
    iso_currency_code: null,
    unofficial_currency_code: null,
    label: {},
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
