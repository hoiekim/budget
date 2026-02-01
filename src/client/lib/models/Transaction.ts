import {
  Location,
  PersonalFinanceCategory,
  TransactionCode,
  TransactionPaymentChannelEnum,
  TransactionTransactionTypeEnum,
  PaymentMeta,
} from "plaid";

import {
  getRandomId,
  getDateTimeString,
  environment,
  assign,
  JSONTransactionLabel,
  JSONTransaction,
} from "common";

import { SplitTransaction } from "./SplitTransaction";
import { globalData, SplitTransactionDictionary } from "./Data";

export class TransactionLabel implements JSONTransactionLabel {
  budget_id?: string | null;
  category_id?: string | null;
  memo?: string | null;

  get section_id(): string | null | undefined {
    if (environment === "server") return undefined;
    const { category_id } = this;
    if (!category_id) return undefined;
    const category = globalData.categories.get(category_id);
    if (!category) return undefined;
    return category.getParent()?.id;
  }

  constructor(init?: Partial<TransactionLabel>) {
    assign(this, init);
  }
}

class TransactionSplitMap extends Map<string, SplitTransactionDictionary> {
  getOrNew = (id: string) => {
    const existing = this.get(id);
    if (existing) return existing;
    const newData = new SplitTransactionDictionary();
    this.set(id, newData);
    return newData;
  };
}

const transactionSplitMap = new TransactionSplitMap();

export class Transaction implements JSONTransaction {
  get id() {
    return this.transaction_id;
  }
  set id(_: string) {}

  get hypotheticalTransaction(): Transaction {
    return new Transaction({ ...this, amount: this.getRemainingAmount() });
  }

  transaction_type?: TransactionTransactionTypeEnum;
  pending_transaction_id: string | null = null;
  category_id: string | null = null;
  category: string[] | null = null;
  location: Location = {
    address: null,
    city: null,
    region: null,
    postal_code: null,
    country: null,
    lat: null,
    lon: null,
    store_number: null,
  };
  payment_meta: PaymentMeta = {
    ppd_id: null,
    by_order_of: null,
    payee: null,
    payer: null,
    payment_method: null,
    payment_processor: null,
    reason: null,
    reference_number: null,
  };
  account_owner: string | null = null;
  name: string = "Unknown";
  original_description?: string | null;
  account_id: string = "Unknown";
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

  constructor(init: Partial<Transaction | JSONTransaction> & { account_id: string }) {
    assign(this, init);
  }

  getChildren = () => transactionSplitMap.getOrNew(this.id);

  addChild = (child: SplitTransaction) => this.getChildren().set(child.id, child);

  removeChild = (id: string) => this.getChildren().delete(id);

  removeAllChildren = () => transactionSplitMap.delete(this.id);

  getRemainingAmount = () => {
    let remaining = this.amount;
    this.getChildren().forEach(({ amount }) => {
      remaining -= amount;
    });
    return remaining;
  };
}
