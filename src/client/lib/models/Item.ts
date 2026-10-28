import { getRandomId, assign, JSONClientItem, ItemStatus, ItemProvider } from "common";
import { PlaidError, Products } from "plaid";

export class Item implements JSONClientItem {
  get id() {
    return this.item_id;
  }
  set id(_: string) {}

  item_id: string = getRandomId();
  institution_id: string | null = null;
  available_products: Products[] = [];
  cursor?: string;
  status?: ItemStatus;
  status_reason?: string | undefined;
  plaidError?: PlaidError;
  provider = ItemProvider.PLAID;
  /**
   * Timestamp in YYYY-MM-DD format.
   */
  updated?: string;

  constructor(init: Partial<Item>) {
    assign(this, init);
    // The server never sends item credentials to the browser, but rows
    // persisted by older clients may still carry one in IndexedDB — scrub it
    // on load so it can never be written back (hoiekim/budget#807).
    delete (this as unknown as Record<string, unknown>).access_token;
  }
}
