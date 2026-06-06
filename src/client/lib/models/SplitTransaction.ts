import {
  assign,
  getDateTimeString,
  JSONSplitTransaction,
  excludeEnumeration,
} from "common";
import { Transaction, TransactionLabel } from "./Transaction";
import { globalData } from "./Data";

export class SplitTransaction implements JSONSplitTransaction {
  get id() {
    return this.split_transaction_id;
  }
  set id(_: string) {}

  // No initializer — the constructor requires `split_transaction_id` so
  // every instance is built from a real server-issued UUID. The previous
  // `= getRandomId()` default silently produced 5-hex-char ids whenever
  // a caller passed an `init` object missing `split_transaction_id`
  // (e.g. `new SplitTransaction(parentTransaction)` in TransactionRow),
  // and those ids then got POSTed back to the server as
  // `split_transaction_id`, which PG rejected with
  // `invalid input syntax for type uuid: "d8fa6"`.
  declare split_transaction_id: string;
  transaction_id: string = "";
  account_id: string = "";
  amount: number = 0;
  date: string = getDateTimeString();
  custom_name: string = "Unknown";
  /**
   * Represents relations by pair of budget_id and category_id
   */
  label: TransactionLabel;

  constructor(
    init: Partial<SplitTransaction | JSONSplitTransaction> & {
      split_transaction_id: string;
      transaction_id: string;
      account_id: string;
    },
  ) {
    assign(this, init);
    if (init.label) this.label = new TransactionLabel(init.label);
    else this.label = new TransactionLabel();
    excludeEnumeration(this, ["toTransaction"]);
  }

  toTransaction = () => {
    const { id, transaction_id, amount, label } = this;
    const { transactions } = globalData;
    const parentTransaction = transactions.get(transaction_id);
    return new Transaction({ ...parentTransaction!, transaction_id: id, amount, label });
  };
}
