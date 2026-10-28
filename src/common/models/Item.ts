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
  status_reason?: string;
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

/**
 * The shape of an item as serialized to the browser. `access_token` is a
 * long-lived server-side credential (the Plaid production access token, or
 * the SimpleFin access URL with embedded HTTP Basic credentials) and is
 * never sent to the client.
 */
export type JSONClientItem = Omit<JSONItem, "access_token">;
