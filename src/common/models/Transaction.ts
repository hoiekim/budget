import {
  RemovedTransaction,
  Transaction as PlaidTransaction,
  PersonalFinanceCategory,
  TransactionCode,
  TransactionPaymentChannelEnum,
  TransactionTransactionTypeEnum,
} from "plaid";

import {
  Location,
  PaymentMeta,
  globalData,
  getRandomId,
  getDateTimeString,
  environment,
  assign,
} from "common";

export class TransactionLabel {
  budget_id?: string | null;
  category_id?: string | null;
  memo?: string | null;

  get section_id(): string | null | undefined {
    if (environment === "server") return undefined;
    const { category_id } = this;
    if (!category_id) return undefined;
    const category = globalData.categories.get(category_id);
    if (!category) return undefined;
    const section = globalData.sections.get(category.section_id);
    return section?.id;
  }

  constructor(init?: Partial<TransactionLabel>) {
    assign(this, init);
  }
}

export class Transaction implements PlaidTransaction {
  get id() {
    return this.transaction_id;
  }
  set id(_: string) {}

  transaction_type?: TransactionTransactionTypeEnum;
  pending_transaction_id: string | null = null;
  category_id: string | null = null;
  category: string[] | null = null;
  location: Location = new Location();
  payment_meta: PaymentMeta = new PaymentMeta();
  account_owner: string | null = null;
  name: string = "Unknown";
  original_description?: string | null;
  account_id: string = "";
  amount: number = 0;
  iso_currency_code: string | null = null;
  unofficial_currency_code: string | null = null;
  date: string = getDateTimeString();
  pending: boolean = false;
  transaction_id: string = getRandomId();
  merchant_name?: string | null;
  check_number?: string | null;
  payment_channel: TransactionPaymentChannelEnum = TransactionPaymentChannelEnum.Other;
  authorized_date: string | null = null;
  authorized_datetime: string | null = null;
  datetime: string | null = null;
  transaction_code: TransactionCode | null = null;
  personal_finance_category?: PersonalFinanceCategory | null;
  /**
   * Represents relations by pair of budget_id and category_id
   */
  label: TransactionLabel = new TransactionLabel();

  constructor(init: Partial<Transaction> & { account_id: string }) {
    assign(this, init);
    if (init.location) this.location = new Location(init.location);
    if (init.payment_meta) this.payment_meta = new PaymentMeta(init.payment_meta);
    if (init.label) this.label = new TransactionLabel(init.label);
  }
}

export type { RemovedTransaction };
