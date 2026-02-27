import { PlaidError, Products } from "plaid";

export enum ItemStatus {
  OK = "ok",
  BAD = "bad",
  INACTIVE = "inactive",
}

export enum SyncStatus {
  SUCCESS = "success",
  FAILED = "failed",
  PENDING = "pending",
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
  /**
   * Status of the last sync attempt.
   */
  last_sync_status?: SyncStatus;
  /**
   * ISO timestamp of the last sync attempt.
   */
  last_sync_at?: string;
  /**
   * Error message from the last failed sync, if any.
   */
  last_sync_error?: string;
}
