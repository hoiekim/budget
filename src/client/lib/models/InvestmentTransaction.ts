import { InvestmentTransactionSubtype, InvestmentTransactionType } from "plaid";

import { getRandomId, getDateTimeString, assign, JSONInvestmentTransaction } from "common";
import { TransactionLabel } from "./Transaction";

export class InvestmentTransaction implements JSONInvestmentTransaction {
  get id() {
    return this.investment_transaction_id;
  }
  set id(_: string) {}

  investment_transaction_id: string = getRandomId();
  cancel_transaction_id?: string | null;
  account_id: string = "";
  security_id: string | null = null;
  date: string = getDateTimeString();
  name: string = "Unknown";
  quantity: number = 0;
  amount: number = 0;
  price: number = 0;
  fees: number | null = null;
  type = InvestmentTransactionType.Buy;
  subtype = InvestmentTransactionSubtype.Buy;
  iso_currency_code: string | null = null;
  unofficial_currency_code: string | null = null;
  /**
   * Represents relations by pair of budget_id and category_id
   */
  label: TransactionLabel;

  constructor(
    init: Partial<InvestmentTransaction | JSONInvestmentTransaction> & { account_id: string },
  ) {
    assign(this, init);
    if (init.label) this.label = new TransactionLabel(init.label);
    else this.label = new TransactionLabel();
  }
}

export interface RemovedInvestmentTransaction {
  investment_transaction_id: string;
}
