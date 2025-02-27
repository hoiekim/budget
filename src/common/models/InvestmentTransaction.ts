import {
  InvestmentTransaction as PlaidInvestmentTransaction,
  InvestmentTransactionSubtype,
  InvestmentTransactionType,
} from "plaid";

import { getRandomId, getDateTimeString, assign } from "common";

export class InvestmentTransaction implements PlaidInvestmentTransaction {
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

  constructor(init: Partial<InvestmentTransaction> & { account_id: string }) {
    assign(this, init);
  }
}

export interface RemovedInvestmentTransaction {
  investment_transaction_id: string;
}
