//! Institutions by id: `src/server/lib/plaid/institutions.ts`.

use std::sync::LazyLock;

use serde_json::json;

use super::util::get_client;
use crate::common::queue::Queue;
use crate::js::{Json, Obj};
use crate::server::logger;
use crate::server::postgres::models::MaskedUser;

/// Process-wide rather than per request: Plaid meters these calls against one
/// app-level credential shared by every user of the deployment.
static INSTITUTION_QUEUE: LazyLock<Queue> = LazyLock::new(|| Queue::new(|| 0, 60_000.0).with_max_inflight(4));

/// The fields of Plaid's institution a `JSONInstitution` keeps, in order.
const INSTITUTION_FIELDS: [&str; 10] =
    ["institution_id", "name", "products", "country_codes", "url", "primary_color", "logo", "routing_numbers", "oauth", "status"];

/// The `JSONInstitution` of a `/institutions/get_by_id` answer: the fields it
/// keeps, each left out where Plaid sent none.
pub fn institution_of(data: &Json) -> anyhow::Result<Json> {
    let institution = match data {
        Json::Null => anyhow::bail!("null is not an object (evaluating 'response.data.institution')"),
        Json::Object(map) => map.get("institution"),
        _ => None,
    };
    let institution = match institution {
        None | Some(Json::Null) => anyhow::bail!("Right side of assignment cannot be destructured"),
        Some(Json::Object(map)) => map.clone(),
        Some(_) => Obj::new(),
    };
    let mut picked = Obj::new();
    for field in INSTITUTION_FIELDS {
        if let Some(value) = institution.get(field) {
            picked.insert(field.to_string(), value.clone());
        }
    }
    Ok(Json::Object(picked))
}

/// One institution from Plaid, or `None` when it could not be fetched (logged).
async fn get_institution(user: &MaskedUser, id: &str) -> anyhow::Result<Option<Json>> {
    let client = get_client(Some(user))?;

    let fetched = async {
        let data = client.call("/institutions/get_by_id", &json!({ "institution_id": id, "country_codes": ["US"] })).await?;
        institution_of(&data)
    };
    match fetched.await {
        Ok(institution) => Ok(Some(institution)),
        Err(error) => {
            logger::error("Failed to get institution data", Some(&crate::ctx! { "institutionId": id }), Some(&error));
            Ok(None)
        }
    }
}

/// Resolves a set of institution ids through the shared concurrency gate. Ids
/// Plaid cannot resolve are absent from the result rather than failing the
/// batch.
pub async fn get_institutions_by_ids(user: &MaskedUser, ids: &[String]) -> anyhow::Result<Vec<Json>> {
    let lookups = ids.iter().map(|id| async move {
        match INSTITUTION_QUEUE.add(|| get_institution(user, id), None).await {
            Ok(result) => result,
            Err(error) => Err(error.into()),
        }
    });
    let settled = futures::future::join_all(lookups).await;
    let mut institutions = Vec::new();
    for institution in settled {
        if let Some(institution) = institution? {
            institutions.push(institution);
        }
    }
    Ok(institutions)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keeps_the_fields_of_a_json_institution_and_drops_the_rest() {
        let data = json!({
            "institution": {
                "institution_id": "ins_1",
                "name": "Bank",
                "products": ["transactions"],
                "country_codes": ["US"],
                "url": null,
                "oauth": false,
                "routing_numbers": [],
                "dtc_numbers": ["1"],
            },
            "request_id": "r",
        });
        assert_eq!(
            institution_of(&data).unwrap(),
            json!({
                "institution_id": "ins_1",
                "name": "Bank",
                "products": ["transactions"],
                "country_codes": ["US"],
                "url": null,
                "routing_numbers": [],
                "oauth": false,
            })
        );
    }

    #[test]
    fn an_answer_without_an_institution_is_a_failure() {
        assert!(institution_of(&json!({ "request_id": "r" })).is_err());
        assert!(institution_of(&json!(null)).is_err());
        assert!(institution_of(&json!({ "institution": null })).is_err());
        assert_eq!(institution_of(&json!("text")).ok(), None);
    }
}
