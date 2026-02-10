import {
  Location,
  PaymentMeta,
  Transaction as PlaidTransaction,
  PersonalFinanceCategory,
  TransactionCode,
  TransactionPaymentChannelEnum,
  TransactionTransactionTypeEnum,
  InvestmentTransaction as PlaidInvestmentTransaction,
} from "plaid";

export interface JSONTransactionLabel {
  budget_id?: string | null;
  category_id?: string | null;
  memo?: string | null;
}

export interface JSONTransaction extends PlaidTransaction {
  transaction_type?: TransactionTransactionTypeEnum;
  pending_transaction_id: string | null;
  category_id: string | null;
  category: string[] | null;
  location: Location;
  payment_meta: PaymentMeta;
  account_owner: string | null;
  name: string;
  original_description?: string | null;
  account_id: string;
  amount: number;
  iso_currency_code: string | null;
  unofficial_currency_code: string | null;
  date: string;
  pending: boolean;
  transaction_id: string;
  merchant_name?: string | null;
  check_number?: string | null;
  payment_channel: TransactionPaymentChannelEnum;
  authorized_date: string | null;
  authorized_datetime: string | null;
  datetime: string | null;
  transaction_code: TransactionCode | null;
  personal_finance_category?: PersonalFinanceCategory | null;
  /**
   * Represents relations by pair of budget_id and category_id
   */
  label: JSONTransactionLabel;
}

export interface JSONInvestmentTransaction extends PlaidInvestmentTransaction {
  /**
   * Represents relations by pair of budget_id and category_id
   */
  label: JSONTransactionLabel;
}

export interface RemovedTransaction {
  transaction_id: string;
}

export interface RemovedInvestmentTransaction {
  investment_transaction_id: string;
}

export interface JSONSplitTransaction {
  split_transaction_id: string;
  transaction_id: string;
  account_id: string;
  amount: number;
  date?: string;
  custom_name: string;
  /**
   * Represents relations by pair of budget_id and category_id
   */
  label: JSONTransactionLabel;
}

export interface RemovedSplitTransaction {
  split_transaction_id: string;
}
