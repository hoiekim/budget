//! `src/server/lib/postgres/repositories/institutions.ts`.

use serde_json::json;

use crate::js::{to_js_string, Json, Obj};
use crate::server::logger;
use crate::server::postgres::client::Executor;
use crate::server::postgres::database::{error_result, success_result, QueryData, UpsertResult};
use crate::server::postgres::models::institution;

/// Writes the institutions in one statement per set of fields given, and
/// reports one result per institution: 404 for one that was not written. A
/// failed write is logged and answers 500 for every institution.
pub async fn upsert_institutions(institutions: &[Obj], client: Option<&dyn Executor>) -> Vec<UpsertResult> {
    if institutions.is_empty() {
        return Vec::new();
    }
    let id_of = |institution: &Obj| institution.get("institution_id").map(to_js_string).unwrap_or_default();

    let rows: Vec<QueryData> = institutions.iter().map(institution::from_json).collect();

    match institution::TABLE.upsert_many(&rows, None, client).await {
        Ok(upserted) => {
            let written: Vec<&Json> = upserted.iter().filter_map(|row| row.get("institution_id")).collect();
            institutions
                .iter()
                .map(|institution| {
                    let was_written = institution.get("institution_id").is_some_and(|id| written.contains(&id));
                    success_result(&id_of(institution), Some(u64::from(was_written)))
                })
                .collect()
        }
        Err(error) => {
            let institution_ids: Vec<Option<&Json>> = institutions.iter().map(|institution| institution.get("institution_id")).collect();
            logger::error("Failed to upsert institutions", Some(&crate::ctx! { "institutionIds": institution_ids }), Some(&error));
            institutions.iter().map(|institution| error_result(&id_of(institution))).collect()
        }
    }
}

/// Batch lookup: one `IN`-based query for every id at once, not one per id.
/// Missing ids are simply absent from the result; callers that need a
/// fallback for unknown institutions handle it at the route layer.
pub async fn search_institutions_by_id(institution_ids: &[String]) -> anyhow::Result<Vec<Json>> {
    if institution_ids.is_empty() {
        return Ok(Vec::new());
    }
    // Dedupe defensively: the client dedupes, but the repository shouldn't
    // trust that.
    let mut unique: Vec<Json> = Vec::new();
    for institution_id in institution_ids {
        let id = json!(institution_id);
        if !unique.contains(&id) {
            unique.push(id);
        }
    }
    let models = institution::TABLE.query_by_ids(&unique, &[]).await?;
    Ok(models.iter().map(institution::to_json).collect())
}

#[cfg(test)]
mod tests {
    use super::super::items::testing::{obj, update_columns_of, FakeExecutor};
    use super::*;

    #[tokio::test]
    async fn no_institutions_and_no_ids_answer_without_a_query() {
        let client = FakeExecutor::default();
        assert!(upsert_institutions(&[], Some(&client)).await.is_empty());
        assert!(client.calls().is_empty());
        assert!(search_institutions_by_id(&[]).await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn institutions_are_written_in_one_statement_and_rewrite_what_they_carry() {
        let client = FakeExecutor::default();
        let institutions = [
            obj(json!({ "institution_id": "ins_1", "name": "Chase" })),
            obj(json!({ "institution_id": "ins_2", "name": "Fidelity" })),
        ];
        upsert_institutions(&institutions, Some(&client)).await;

        let calls = client.calls();
        assert_eq!(calls.len(), 1);
        let (sql, values) = &calls[0];
        assert!(sql.starts_with("INSERT INTO institutions (updated, institution_id, name, raw) VALUES "));
        assert_eq!(update_columns_of(sql), ["name", "raw", "updated"]);
        assert_eq!(values.len(), 6);
        assert_eq!(values[0], json!("ins_1"));
        assert_eq!(values[3], json!("ins_2"));
    }

    #[tokio::test]
    async fn an_institution_the_statement_did_not_return_reports_404() {
        // The stub returns no rows, so none of them counts as written.
        let client = FakeExecutor::default();
        let results = upsert_institutions(&[obj(json!({ "institution_id": "ins_1", "name": "Chase" }))], Some(&client)).await;
        assert_eq!((results[0].id.as_str(), results[0].status), ("ins_1", 404));
    }

    #[tokio::test]
    async fn a_failed_write_reports_500_for_every_institution() {
        let client = FakeExecutor::failing();
        let institutions = [obj(json!({ "institution_id": "ins_1" })), obj(json!({ "institution_id": "ins_2" }))];
        let results = upsert_institutions(&institutions, Some(&client)).await;
        let reported: Vec<(&str, u16)> = results.iter().map(|result| (result.id.as_str(), result.status)).collect();
        assert_eq!(reported, [("ins_1", 500), ("ins_2", 500)]);
    }
}
