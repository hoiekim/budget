import { getRandomId, assign, getDateTimeString } from "common";
import { TransactionLabel } from "./Transaction";

export class SplitTransaction {
  get id() {
    return this.split_transaction_id;
  }
  set id(_: string) {}

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
