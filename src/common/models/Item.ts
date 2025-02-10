import { getRandomId, assign } from "common";
import { PlaidError, Products } from "plaid";

export enum ItemStatus {
  OK = "ok",
  BAD = "bad",
  INACTIVE = "inactive",
}

export enum ItemProvider {
  PLAID = "plaid",
  SIMPLE_FIN = "simple_fin",
}

export class Item {
  get id() {
    return this.item_id;
  }
  set id(_: string) {}

  item_id: string = getRandomId();
  access_token: string = getRandomId();
  institution_id: string | null = null;
  available_products: Products[] = [];
  cursor?: string;
  status?: ItemStatus;
  plaidError?: PlaidError;
  provider = ItemProvider.PLAID;
  /**
   * Timestamp in YYYY-MM-DD format.
   */
  updated?: string;

  constructor(init?: Partial<Item> & { access_token: string }) {
    assign(this, init);
  }
}
