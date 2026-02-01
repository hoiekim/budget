import { getRandomId, assign, JSONItem, ItemStatus, ItemProvider } from "common";
import { PlaidError, Products } from "plaid";

export class Item implements JSONItem {
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

  constructor(init: Partial<Item> & { access_token: string }) {
    assign(this, init);
  }
}
