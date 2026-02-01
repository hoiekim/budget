import { PlaidError, Products } from "plaid";

export enum ItemStatus {
  OK = "ok",
  BAD = "bad",
  INACTIVE = "inactive",
}

export enum ItemProvider {
  PLAID = "plaid",
  SIMPLE_FIN = "simple_fin",
  MANUAL = "manual",
}

export interface JSONItem {
  item_id: string;
  access_token: string;
  institution_id: string | null;
  available_products: Products[];
  cursor?: string;
  status?: ItemStatus;
  plaidError?: PlaidError;
  provider: ItemProvider;
  /**
   * Timestamp in YYYY-MM-DD format.
   */
  updated?: string;
}
