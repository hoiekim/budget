//! An item's SimpleFin data, in the app's models: `src/server/lib/simple-fin/data.ts`.

use url::form_urlencoded;

use super::tokens::{decode_access_url, http_client, refuse_redirect, status_text};
use super::translators::{translate_account, translate_holding, translate_investment_transaction, translate_transaction};
use crate::js::{json_parse, json_stringify, number_to_string, truthy, Json, JsDate};

/// What to fetch: transactions from `start_date` to `end_date` (now when
/// absent), of every account or of `account_id` alone.
#[derive(Clone, Debug)]
pub struct GetSimpleFinDataOptions {
    pub start_date: JsDate,
    pub end_date: Option<JsDate>,
    pub account_id: Option<String>,
}

/// An item's SimpleFin data. An account that holds securities has its
/// transactions as investment transactions.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SimpleFinData {
    pub accounts: Vec<Json>,
    pub institutions: Vec<Json>,
    pub transactions: Vec<Json>,
    pub investment_transactions: Vec<Json>,
    pub holdings: Vec<Json>,
    pub securities: Vec<Json>,
}

/// The query of an `/accounts` request: the window in epoch seconds, pending
/// transactions included, and the account when one is named.
pub fn accounts_query(options: &GetSimpleFinDataOptions) -> String {
    let end_date = options.end_date.unwrap_or_else(JsDate::now);
    let seconds = |date: JsDate| number_to_string((date.get_time() / 1000.0).floor());
    let mut params = form_urlencoded::Serializer::new(String::new());
    params.append_pair("start-date", &seconds(options.start_date));
    params.append_pair("end-date", &seconds(end_date));
    params.append_pair("pending", "1");
    if let Some(account_id) = options.account_id.as_deref().filter(|id| !id.is_empty()) {
        params.append_pair("account", account_id);
    }
    params.finish()
}

/// Fetches the item's accounts with their transactions and holdings from its
/// SimpleFin bridge. A non-2xx answer, an answer without an accounts list, or
/// one that lists errors fails.
pub async fn get_data(item: &Json, options: &GetSimpleFinDataOptions) -> anyhow::Result<SimpleFinData> {
    let access_token = match item.get("access_token") {
        Some(Json::String(token)) => token.clone(),
        other => other.map(crate::js::to_js_string).unwrap_or_else(|| "undefined".to_string()),
    };
    let credentials = decode_access_url(&access_token)?;

    let url = format!("{}/accounts?{}", credentials.url, accounts_query(options));
    // A redirect would carry the credentials to a host the allowlist never checked.
    let response = http_client()?.get(&url).header("Authorization", format!("Basic {}", credentials.credentials)).send().await?;
    refuse_redirect(&response, &url)?;

    if !response.status().is_success() {
        anyhow::bail!("SimpleFin API error: {} {} ({})", response.status().as_u16(), status_text(&response), credentials.url);
    }

    let text = response.text().await?;
    let Some(data) = json_parse(&text) else {
        anyhow::bail!("JSON Parse error: Unable to parse JSON string");
    };
    if data.is_null() {
        anyhow::bail!("null is not an object (evaluating 'data.accounts')");
    }

    let Some(Json::Array(accounts)) = data.get("accounts") else {
        anyhow::bail!("SimpleFin API returned unexpected response shape: missing accounts array");
    };

    if let Some(errors) = data.get("errors").filter(|errors| truthy(errors)) {
        let listed = match errors {
            Json::Array(list) => !list.is_empty(),
            Json::String(text) => !text.is_empty(),
            _ => false,
        };
        if listed {
            anyhow::bail!("SimpleFin API returned errors: {}", json_stringify(errors));
        }
    }

    modelize(item, accounts)
}

/// The app's models of each SimpleFin account and what it holds.
fn modelize(item: &Json, simple_fin_accounts: &[Json]) -> anyhow::Result<SimpleFinData> {
    let mut data = SimpleFinData::default();

    for simple_fin_account in simple_fin_accounts {
        let Json::Object(fields) = simple_fin_account else {
            anyhow::bail!("Right side of assignment cannot be destructured");
        };

        let translated = translate_account(simple_fin_account, item)?;
        data.accounts.push(translated.account);
        data.institutions.push(translated.institution);

        let Some(Json::Array(holdings)) = fields.get("holdings") else {
            anyhow::bail!("simpleFinHoldings.forEach is not a function");
        };
        let Some(Json::Array(transactions)) = fields.get("transactions") else {
            anyhow::bail!("simpleFinTransactions.forEach is not a function");
        };

        if !holdings.is_empty() {
            for transaction in transactions {
                data.investment_transactions.push(translate_investment_transaction(transaction, simple_fin_account)?);
            }
        } else {
            for transaction in transactions {
                data.transactions.push(translate_transaction(transaction, simple_fin_account)?);
            }
        }

        for holding in holdings {
            let translated = translate_holding(holding, simple_fin_account)?;
            data.holdings.push(translated.holding);
            data.securities.push(translated.security);
        }
    }

    Ok(data)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn asks_for_the_window_in_seconds_with_pending_transactions() {
        let options = GetSimpleFinDataOptions {
            start_date: JsDate::parse("2026-10-01T00:00:00Z"),
            end_date: Some(JsDate::parse("2026-10-02T00:00:00.999Z")),
            account_id: None,
        };
        assert_eq!(accounts_query(&options), "start-date=1790812800&end-date=1790899200&pending=1");
        let one = GetSimpleFinDataOptions { account_id: Some("ACT a/b~".to_string()), ..options.clone() };
        assert_eq!(accounts_query(&one), "start-date=1790812800&end-date=1790899200&pending=1&account=ACT+a%2Fb%7E");
        let empty = GetSimpleFinDataOptions { account_id: Some(String::new()), ..options };
        assert!(!accounts_query(&empty).contains("account="));
    }

    #[tokio::test]
    async fn a_stored_access_url_outside_the_allowlist_is_never_fetched() {
        let item = json!({ "item_id": "i-1", "access_token": "http://user:secret@169.254.169.254" });
        let options = GetSimpleFinDataOptions { start_date: JsDate::now(), end_date: None, account_id: None };
        let error = get_data(&item, &options).await.unwrap_err().to_string();
        assert!(error.starts_with("Invalid SimpleFin access URL"), "{error}");
    }

    #[test]
    fn an_account_holding_securities_has_investment_transactions() {
        let account = |holdings: Json| {
            json!({
                "id": "acc",
                "org": { "id": "org", "name": "Bank", "url": "https://bank.example.com" },
                "name": "Brokerage",
                "currency": "USD",
                "balance": "10",
                "available-balance": "10",
                "transactions": [{ "id": "t1", "posted": 1704153600, "amount": "-5", "description": "Buy", "payee": "", "memo": "", "transacted_at": 1704153600 }],
                "holdings": holdings,
            })
        };
        let holding = json!({ "id": "h1", "created": 1704067200, "currency": "", "cost_basis": "1", "description": "Fund", "market_value": "10", "shares": "2", "symbol": "FND" });
        let data = modelize(&json!({}), &[account(json!([holding])), account(json!([]))]).unwrap();
        assert_eq!(data.accounts.len(), 2);
        assert_eq!(data.institutions.len(), 2);
        assert_eq!(data.investment_transactions.len(), 1);
        assert_eq!(data.transactions.len(), 1);
        assert_eq!(data.holdings.len(), 1);
        assert_eq!(data.securities[0]["iso_currency_code"], json!("USD"));
        assert!(modelize(&json!({}), &[account(json!(null))]).is_err());
    }
}
