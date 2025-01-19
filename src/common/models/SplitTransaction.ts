import { getRandomId, assign, getDateTimeString, globalData } from "common";
import { Transaction, TransactionLabel } from "./Transaction";

export class SplitTransaction {
  get id() {
    return this.split_transaction_id;
  }
  set id(_: string) {}

  get hypotheticalTransaction() {
    const { id, transaction_id, amount, label } = this;
    const { transactions } = globalData;
    const parentTransaction = transactions.get(transaction_id);
    return new Transaction({ ...parentTransaction!, transaction_id: id, amount, label });
  }

  split_transaction_id: string = getRandomId();
  transaction_id: string = "";
  amount: number = 0;
  date: string = getDateTimeString();
  custom_name: string = "Unknown";
  /**
   * Represents relations by pair of budget_id and category_id
   */
  label: TransactionLabel = new TransactionLabel();

  constructor(init: Partial<SplitTransaction> & { transaction_id: string }) {
    assign(this, init);
    if (init.label) this.label = new TransactionLabel(init.label);
  }
}

export interface RemovedSplitTransaction {
  split_transaction_id: string;
}
