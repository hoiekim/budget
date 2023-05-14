import { getRandomId, assign } from "common";
import { PlaidError } from "plaid";

export class Item {
  get id() {
    return this.item_id;
  }
  set id(_: string) {}

  item_id: string = getRandomId();
  access_token: string = getRandomId();
  institution_id: string = "";
  cursor?: string;
  plaidError?: PlaidError;
  /**
   * Timestamp in YYYY-MM-DD format.
   */
  updated?: string;

  constructor(init?: Partial<Item> & { institution_id: string }) {
    assign(this, init);
  }
}
