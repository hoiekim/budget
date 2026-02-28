/**
 * Column name constants and table names for type-safe database operations.
 * All column names are snake_case to match PostgreSQL convention.
 */

export const USERS = "users";
export const SESSIONS = "sessions";
export const ITEMS = "items";
export const INSTITUTIONS = "institutions";
export const ACCOUNTS = "accounts";
export const HOLDINGS = "holdings";
export const SECURITIES = "securities";
export const TRANSACTIONS = "transactions";
export const INVESTMENT_TRANSACTIONS = "investment_transactions";
export const SPLIT_TRANSACTIONS = "split_transactions";
export const BUDGETS = "budgets";
export const SECTIONS = "sections";
export const CATEGORIES = "categories";
export const SNAPSHOTS = "snapshots";
export const CHARTS = "charts";

export const USER_ID = "user_id";
export const UPDATED = "updated";
export const IS_DELETED = "is_deleted";
export const RAW = "raw";

export const USERNAME = "username";
export const PASSWORD = "password";
export const EMAIL = "email";
export const EXPIRY = "expiry";
export const TOKEN = "token";

export const SESSION_ID = "session_id";
export const USER_USER_ID = "user_user_id";
export const USER_USERNAME = "user_username";
export const COOKIE_ORIGINAL_MAX_AGE = "cookie_original_max_age";
export const COOKIE_MAX_AGE = "cookie_max_age";
export const COOKIE_SIGNED = "cookie_signed";
export const COOKIE_EXPIRES = "cookie_expires";
export const COOKIE_HTTP_ONLY = "cookie_http_only";
export const COOKIE_PATH = "cookie_path";
export const COOKIE_DOMAIN = "cookie_domain";
export const COOKIE_SECURE = "cookie_secure";
export const COOKIE_SAME_SITE = "cookie_same_site";
export const CREATED_AT = "created_at";

export const ITEM_ID = "item_id";
export const ACCESS_TOKEN = "access_token";
export const INSTITUTION_ID = "institution_id";
export const AVAILABLE_PRODUCTS = "available_products";
export const CURSOR = "cursor";
export const STATUS = "status";
export const PROVIDER = "provider";

export const NAME = "name";

export const ACCOUNT_ID = "account_id";
export const TYPE = "type";
export const SUBTYPE = "subtype";
export const BALANCES_AVAILABLE = "balances_available";
export const BALANCES_CURRENT = "balances_current";
export const BALANCES_LIMIT = "balances_limit";
export const BALANCES_ISO_CURRENCY_CODE = "balances_iso_currency_code";
export const CUSTOM_NAME = "custom_name";
export const HIDE = "hide";
export const LABEL_BUDGET_ID = "label_budget_id";
export const GRAPH_OPTIONS_USE_SNAPSHOTS = "graph_options_use_snapshots";
export const GRAPH_OPTIONS_USE_HOLDING_SNAPSHOTS = "graph_options_use_holding_snapshots";
export const GRAPH_OPTIONS_USE_TRANSACTIONS = "graph_options_use_transactions";

export const HOLDING_ID = "holding_id";
export const SECURITY_ID = "security_id";
export const INSTITUTION_PRICE = "institution_price";
export const INSTITUTION_PRICE_AS_OF = "institution_price_as_of";
export const INSTITUTION_VALUE = "institution_value";
export const COST_BASIS = "cost_basis";
export const QUANTITY = "quantity";
export const ISO_CURRENCY_CODE = "iso_currency_code";

export const TICKER_SYMBOL = "ticker_symbol";
export const CLOSE_PRICE = "close_price";
export const CLOSE_PRICE_AS_OF = "close_price_as_of";
export const ISIN = "isin";
export const CUSIP = "cusip";

export const TRANSACTION_ID = "transaction_id";
export const MERCHANT_NAME = "merchant_name";
export const AMOUNT = "amount";
export const DATE = "date";
export const PENDING = "pending";
export const PENDING_TRANSACTION_ID = "pending_transaction_id";
export const PAYMENT_CHANNEL = "payment_channel";
export const LOCATION_COUNTRY = "location_country";
export const LOCATION_REGION = "location_region";
export const LOCATION_CITY = "location_city";
export const LABEL_CATEGORY_ID = "label_category_id";
export const LABEL_MEMO = "label_memo";

export const INVESTMENT_TRANSACTION_ID = "investment_transaction_id";
export const PRICE = "price";

export const SPLIT_TRANSACTION_ID = "split_transaction_id";

export const BUDGET_ID = "budget_id";
export const SECTION_ID = "section_id";
export const CATEGORY_ID = "category_id";
export const ROLL_OVER = "roll_over";
export const ROLL_OVER_START_DATE = "roll_over_start_date";
export const CAPACITIES = "capacities";

export const SNAPSHOT_ID = "snapshot_id";
export const SNAPSHOT_DATE = "snapshot_date";
export const SNAPSHOT_TYPE = "snapshot_type";
export const HOLDING_ACCOUNT_ID = "holding_account_id";
export const HOLDING_SECURITY_ID = "holding_security_id";

export const CHART_ID = "chart_id";
export const CONFIGURATION = "configuration";

export const NULL = "NULL";
