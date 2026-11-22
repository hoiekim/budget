//! Column name constants, as in `src/server/lib/postgres/models/common.ts`.
//! All column names are snake_case to match PostgreSQL convention.

pub const USER_ID: &str = "user_id";
pub const UPDATED: &str = "updated";
pub const IS_DELETED: &str = "is_deleted";
pub const RAW: &str = "raw";
pub const SOURCE: &str = "source";

pub const USERNAME: &str = "username";
pub const PASSWORD: &str = "password";
pub const EMAIL: &str = "email";
pub const EXPIRY: &str = "expiry";
pub const TOKEN: &str = "token";
pub const AUTH_SUB: &str = "auth_sub";

pub const SESSION_ID: &str = "session_id";
pub const USER_USER_ID: &str = "user_user_id";
pub const USER_USERNAME: &str = "user_username";
pub const COOKIE_ORIGINAL_MAX_AGE: &str = "cookie_original_max_age";
pub const COOKIE_MAX_AGE: &str = "cookie_max_age";
pub const COOKIE_SIGNED: &str = "cookie_signed";
pub const COOKIE_EXPIRES: &str = "cookie_expires";
pub const COOKIE_HTTP_ONLY: &str = "cookie_http_only";
pub const COOKIE_PATH: &str = "cookie_path";
pub const COOKIE_DOMAIN: &str = "cookie_domain";
pub const COOKIE_SECURE: &str = "cookie_secure";
pub const COOKIE_SAME_SITE: &str = "cookie_same_site";
pub const CREATED_AT: &str = "created_at";
pub const AUTH_SID: &str = "auth_sid";
pub const AUTH_REFRESH_TOKEN: &str = "auth_refresh_token";
pub const AUTH_RECHECK_AT: &str = "auth_recheck_at";

pub const ITEM_ID: &str = "item_id";
pub const ACCESS_TOKEN: &str = "access_token";
pub const INSTITUTION_ID: &str = "institution_id";
pub const AVAILABLE_PRODUCTS: &str = "available_products";
pub const CURSOR: &str = "cursor";
pub const STATUS: &str = "status";
pub const STATUS_REASON: &str = "status_reason";
pub const PROVIDER: &str = "provider";
pub const LAST_SYNC_STATUS: &str = "last_sync_status";
pub const LAST_SYNC_AT: &str = "last_sync_at";
pub const LAST_SYNC_ERROR: &str = "last_sync_error";

pub const NAME: &str = "name";

pub const ACCOUNT_ID: &str = "account_id";
pub const TYPE: &str = "type";
pub const SUBTYPE: &str = "subtype";
pub const BALANCES_AVAILABLE: &str = "balances_available";
pub const BALANCES_CURRENT: &str = "balances_current";
pub const BALANCES_LIMIT: &str = "balances_limit";
pub const BALANCES_ISO_CURRENCY_CODE: &str = "balances_iso_currency_code";
pub const CUSTOM_NAME: &str = "custom_name";
pub const HIDE: &str = "hide";
pub const ARCHIVED: &str = "archived";
pub const LABEL_BUDGET_ID: &str = "label_budget_id";
pub const GRAPH_OPTIONS_USE_SNAPSHOTS: &str = "graph_options_use_snapshots";
pub const GRAPH_OPTIONS_USE_HOLDING_SNAPSHOTS: &str = "graph_options_use_holding_snapshots";
pub const GRAPH_OPTIONS_USE_TRANSACTIONS: &str = "graph_options_use_transactions";

pub const HOLDING_ID: &str = "holding_id";
pub const SECURITY_ID: &str = "security_id";
pub const INSTITUTION_PRICE: &str = "institution_price";
pub const INSTITUTION_PRICE_AS_OF: &str = "institution_price_as_of";
pub const INSTITUTION_VALUE: &str = "institution_value";
pub const COST_BASIS: &str = "cost_basis";
pub const QUANTITY: &str = "quantity";
pub const ISO_CURRENCY_CODE: &str = "iso_currency_code";

pub const TICKER_SYMBOL: &str = "ticker_symbol";
pub const CLOSE_PRICE: &str = "close_price";
pub const CLOSE_PRICE_AS_OF: &str = "close_price_as_of";
pub const ISIN: &str = "isin";
pub const CUSIP: &str = "cusip";

pub const TRANSACTION_ID: &str = "transaction_id";
pub const MERCHANT_NAME: &str = "merchant_name";
pub const AMOUNT: &str = "amount";
pub const DATE: &str = "date";
pub const PENDING: &str = "pending";
pub const PENDING_TRANSACTION_ID: &str = "pending_transaction_id";
pub const PAYMENT_CHANNEL: &str = "payment_channel";
pub const LOCATION_COUNTRY: &str = "location_country";
pub const LOCATION_REGION: &str = "location_region";
pub const LOCATION_CITY: &str = "location_city";
pub const LABEL_CATEGORY_ID: &str = "label_category_id";
pub const LABEL_MEMO: &str = "label_memo";
pub const LABEL_CATEGORY_CONFIDENCE: &str = "label_category_confidence";

pub const PAIR_ID: &str = "pair_id";
pub const TRANSACTION_ID_A: &str = "transaction_id_a";
pub const TRANSACTION_ID_B: &str = "transaction_id_b";

pub const RECURRING_ID: &str = "recurring_id";
pub const MERCHANT_KEY: &str = "merchant_key";
pub const CADENCE: &str = "cadence";
pub const IS_INCOME: &str = "is_income";
pub const TRANSACTION_IDS: &str = "transaction_ids";
pub const SPLITS: &str = "splits";
pub const SPLITS_SINCE: &str = "splits_since";

pub const INVESTMENT_TRANSACTION_ID: &str = "investment_transaction_id";
pub const PRICE: &str = "price";

pub const SPLIT_TRANSACTION_ID: &str = "split_transaction_id";

pub const BUDGET_ID: &str = "budget_id";
pub const SECTION_ID: &str = "section_id";
pub const CATEGORY_ID: &str = "category_id";
pub const ROLL_OVER: &str = "roll_over";
pub const ROLL_OVER_START_DATE: &str = "roll_over_start_date";
pub const CAPACITIES: &str = "capacities";

pub const SNAPSHOT_ID: &str = "snapshot_id";
pub const SNAPSHOT_DATE: &str = "snapshot_date";
pub const SNAPSHOT_TYPE: &str = "snapshot_type";
pub const HOLDING_ACCOUNT_ID: &str = "holding_account_id";
pub const HOLDING_SECURITY_ID: &str = "holding_security_id";

pub const CHART_ID: &str = "chart_id";
pub const CONFIGURATION: &str = "configuration";

pub const REJECTED_AT: &str = "rejected_at";

pub const CPI_SNAPSHOT_ID: &str = "cpi_snapshot_id";
pub const SERIES_ID: &str = "series_id";
pub const INDEX_VALUE: &str = "index_value";

pub const KEY_ID: &str = "key_id";
pub const KEY_HASH: &str = "key_hash";
pub const KEY_PREFIX: &str = "key_prefix";
pub const SCOPES: &str = "scopes";
pub const LAST_USED_AT: &str = "last_used_at";
pub const REVOKED_AT: &str = "revoked_at";
pub const EXPIRES_AT: &str = "expires_at";

pub const PLAN_FUND_MAPPINGS: &str = "plan_fund_mappings";

pub const GROUP_ID: &str = "group_id";
pub const INVITATION_ID: &str = "invitation_id";
pub const INVITER_USER_ID: &str = "inviter_user_id";
pub const INVITEE_USER_ID: &str = "invitee_user_id";

pub const NULL: &str = "NULL";
