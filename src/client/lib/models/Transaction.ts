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
  excludeEnumeration,
} from "common";
import { TransactionFamilies } from "client";
import { globalData } from "./Data";

export class TransactionLabel implements JSONTransactionLabel {
  budget_id?: string | null;
  category_id?: string | null;
  memo?: string | null;
  category_confidence?: number | null;

  get section_id(): string | null | undefined {
    if (environment === "server") return undefined;
    const { category_id } = this;
    if (!category_id) return undefined;
    const category = globalData.categories.get(category_id);
    if (!category) return undefined;
    return category.getParent()?.id;
  }

  /**
   * Suggestion-state predicates that centralize the `category_confidence`
   * check so the calc and the TransactionsPage filter read one method instead
   * of respelling it at each site. Methods on the label — not accessors keyed
   * by transaction_id on TransactionDictionary — because the budget calc runs
   * them on synthetic split transactions (`SplitTransaction.toTransaction()`)
   * whose ids are NOT keys in the dictionary, so a by-id lookup would miss the
   * split's own label. The label is always in hand, so read it directly.
   */
  isConfirmed(): boolean {
    return this.category_confidence === 1 && !!this.category_id;
  }

  isSuggested(): boolean {
    const confidence = this.category_confidence;
    return !!(this.category_id && confidence && confidence > 0 && confidence < 1);
  }

  constructor(init?: Partial<TransactionLabel>) {
    assign(this, init);
  }
}

export class Transaction implements JSONTransaction {
  static readonly apiPath = "/api/transaction";

  get id() {
    return this.transaction_id;
  }
  set id(_: string) {}

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
   * Origin marker — `"plaid"` for synced rows, `"manual"` for rows the
   * user created via `GET /api/new-transaction`. FE branches on this to
   * enable inline editing of the core fields (name/amount/date) on the
   * detail page — Plaid rows are read-only there because Plaid is the
   * source of truth. Defaults to `"plaid"` so pre-existing IDB rows
   * migrate cleanly.
   */
  source: string = "plaid";
  /**
   * Represents relations by pair of budget_id and category_id
   */
  label: TransactionLabel;

  constructor(init: Partial<Transaction | JSONTransaction> & { account_id: string }) {
    assign(this, init);
    if (init.label) this.label = new TransactionLabel(init.label);
    else this.label = new TransactionLabel();

    excludeEnumeration(this, ["toTransaction", "getRemainingAmount"]);
  }

  toTransaction = () => this;

  getRemainingAmount = (transactionFamilies: TransactionFamilies) => {
    return this.amount - transactionFamilies.getChildrenAmountTotal(this.id);
  };
}
