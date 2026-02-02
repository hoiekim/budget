import { getRandomId, assign, getDateTimeString, JSONSplitTransaction } from "common";
import { Transaction, TransactionLabel } from "./Transaction";
import { globalData } from "./Data";

export class SplitTransaction implements JSONSplitTransaction {
  get id() {
    return this.split_transaction_id;
  }
  set id(_: string) {}

  toTransaction = () => {
    const { id, transaction_id, amount, label } = this;
    const { transactions } = globalData;
    const parentTransaction = transactions.get(transaction_id);
    return new Transaction({ ...parentTransaction!, transaction_id: id, amount, label });
  };

  split_transaction_id: string = getRandomId();
  transaction_id: string = "";
  account_id: string = "";
  amount: number = 0;
  date: string = getDateTimeString();
  custom_name: string = "Unknown";
  /**
   * Represents relations by pair of budget_id and category_id
   */
  label: TransactionLabel = new TransactionLabel();

  constructor(
    init: Partial<SplitTransaction | JSONSplitTransaction> & {
      transaction_id: string;
      account_id: string;
    },
  ) {
    assign(this, init);
    if (init.label) this.label = new TransactionLabel(init.label);
  }
}
