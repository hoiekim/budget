//! Generic query builders, statement for statement the ones in
//! `src/server/lib/postgres/database.ts`. A column's value is a JSON value;
//! a key absent from the data is `undefined` and is skipped, `null` is
//! written (or matched with `IS NULL`).

use crate::js::{Json, Obj};

pub const SOFT_DELETE_CONDITION: &str = "(is_deleted IS NULL OR is_deleted = FALSE)";

/// Column values keyed by column name, in insertion order.
pub type QueryData = Obj;

pub struct PreparedQuery {
    pub sql: String,
    pub values: Vec<Json>,
}

/// A filter value: `Value(null)` matches `IS NULL`, `IsNotNull` matches `IS NOT NULL`.
#[derive(Clone, Debug)]
pub enum Filter {
    Value(Json),
    IsNotNull,
    /// On an owner column: the rows of this user (by id) and of everyone
    /// they share data with, `<column> = ANY(sharing_user_ids($N))`.
    SharedWith(String),
}

impl<T: Into<Json>> From<T> for Filter {
    fn from(value: T) -> Self {
        Filter::Value(value.into())
    }
}

/// The SQL function listing a user and everyone in their sharing group (see `models/sharing.rs`).
pub const SHARING_USER_IDS: &str = "sharing_user_ids";

/// The filter that matches the rows of `user` and of everyone they share data with:
/// `table.query(filters! { "user_id" => shared_with(user) }, …)`.
pub fn shared_with(user: &crate::server::postgres::models::MaskedUser) -> Filter {
    Filter::SharedWith(user.user_id.clone())
}

/// The predicate a [`Filter::SharedWith`] becomes, for SQL written by hand.
pub fn shared_with_sql(column: &str, placeholder: &str) -> String {
    format!("{column} = ANY({SHARING_USER_IDS}({placeholder}))")
}

/// The advisory-lock key a user's sharing group serializes on: the same for
/// every member, and the user's own id while they share with nobody.
pub fn sharing_lock_key_sql(placeholder: &str) -> String {
    format!("(SELECT min(member::text) FROM unnest({SHARING_USER_IDS}({placeholder})) member)")
}

/// The advisory-lock key of sharing membership as a whole. Joining or leaving
/// a group holds it exclusively; work that reads a group and must not see it
/// change midway holds it shared, and takes it before any lock keyed on the
/// group (`sharing_lock_key_sql`), so the two never wait on each other in turn.
pub const SHARING_MEMBERSHIP_LOCK_KEY: &str = "hashtext('sharing')";

/// `<column> = $N` for a value, or the sharing-group predicate for
/// [`Filter::SharedWith`], with the value to bind at `$N`. `None` for
/// `IS NOT NULL`, which binds nothing.
pub fn equality_condition(column: &str, filter: &Filter, index: usize) -> Option<(String, Json)> {
    match filter {
        Filter::SharedWith(user_id) => Some((shared_with_sql(column, &format!("${index}")), Json::String(user_id.clone()))),
        Filter::Value(value) => Some((format!("{column} = ${index}"), value.clone())),
        Filter::IsNotNull => None,
    }
}

/// Equality filters in order: `(column, filter)`.
pub type Filters = Vec<(String, Filter)>;

/// Builds [`Filters`] from `"column" => value` pairs; a value is anything
/// `Into<Json>`, or `Filter::IsNotNull`.
///
/// ```ignore
/// let filters = filters! { "user_id" => user_id, "merchant_name" => Filter::IsNotNull };
/// ```
#[macro_export]
macro_rules! filters {
    ($($column:expr => $value:expr),* $(,)?) => {{
        let list: $crate::server::postgres::database::Filters =
            vec![$( ($column.to_string(), $crate::server::postgres::database::Filter::from($value)) ),*];
        list
    }};
}

/// Filters from an object: every present key is an equality (or `IS NULL`) filter.
pub fn filters_from(data: &Obj) -> Filters {
    data.iter().map(|(key, value)| (key.clone(), Filter::Value(value.clone()))).collect()
}

/// Extra condition ANDed into an UPDATE's WHERE.
#[derive(Clone, Debug)]
pub struct AdditionalWhere {
    pub column: String,
    pub value: Filter,
}

impl AdditionalWhere {
    pub fn new(column: &str, value: impl Into<Filter>) -> Self {
        AdditionalWhere { column: column.to_string(), value: value.into() }
    }
}

pub fn build_create_table(table: &str, schema: &[(&str, &str)], constraints: &[&str]) -> String {
    let mut definitions: Vec<String> = schema.iter().map(|(column, definition)| format!("{column} {definition}")).collect();
    definitions.extend(constraints.iter().map(|c| c.to_string()));
    format!("CREATE TABLE IF NOT EXISTS {table} (\n      {}\n    )", definitions.join(",\n      "))
}

pub fn build_create_index(table: &str, columns: &[String], index_name: Option<&str>, unique: bool, predicate: Option<&str>) -> String {
    let name = index_name.map(|n| n.to_string()).unwrap_or_else(|| format!("idx_{table}_{}", columns.join("_")));
    let kind = if unique { "UNIQUE INDEX" } else { "INDEX" };
    let predicate = predicate.map(|p| format!(" WHERE {p}")).unwrap_or_default();
    format!("CREATE {kind} IF NOT EXISTS {name} ON {table}({}){predicate}", columns.join(", "))
}

/// The keys more than one row shares among the rows a unique index would cover.
pub fn build_select_duplicate_keys(table: &str, keys: &[String], predicate: Option<&str>) -> String {
    let list = keys.join(", ");
    let mut conditions: Vec<String> = keys.iter().map(|k| format!("{k} IS NOT NULL")).collect();
    if let Some(predicate) = predicate {
        conditions.push(format!("({predicate})"));
    }
    format!(
        "SELECT {list} FROM {table} WHERE {} GROUP BY {list} HAVING COUNT(*) > 1 ORDER BY {list}",
        conditions.join(" AND ")
    )
}

pub fn build_insert(table: &str, data: &QueryData, returning: &[&str], on_conflict_do_nothing: bool) -> PreparedQuery {
    let mut columns = vec!["updated".to_string()];
    let mut placeholders = vec!["CURRENT_TIMESTAMP".to_string()];
    let mut values = Vec::new();
    for (key, value) in data {
        columns.push(key.clone());
        values.push(value.clone());
        placeholders.push(format!("${}", values.len()));
    }
    let mut sql = format!("INSERT INTO {table} ({}) VALUES ({})", columns.join(", "), placeholders.join(", "));
    if on_conflict_do_nothing {
        sql.push_str(" ON CONFLICT DO NOTHING");
    }
    if !returning.is_empty() {
        sql.push_str(&format!(" RETURNING {}", returning.join(", ")));
    }
    PreparedQuery { sql, values }
}

pub struct UpdateOptions<'a> {
    pub additional_where: &'a [AdditionalWhere],
    pub returning: &'a [&'a str],
    /// Restrict the UPDATE to live rows.
    pub exclude_deleted: bool,
}

/// `None` when `data` sets nothing (the `raw` column is never updated).
pub fn build_update(
    table: &str,
    primary_key: &str,
    primary_key_value: &Json,
    data: &QueryData,
    options: &UpdateOptions,
) -> Option<PreparedQuery> {
    let mut set_clauses = vec!["updated = CURRENT_TIMESTAMP".to_string()];
    let mut values = Vec::new();
    for (key, value) in data {
        if key == "raw" {
            continue;
        }
        values.push(value.clone());
        set_clauses.push(format!("{key} = ${}", values.len()));
    }
    if set_clauses.len() == 1 {
        return None;
    }
    values.push(primary_key_value.clone());
    let mut sql = format!("UPDATE {table} SET {} WHERE {primary_key} = ${}", set_clauses.join(", "), values.len());
    for extra in options.additional_where {
        match &extra.value {
            Filter::IsNotNull => sql.push_str(&format!(" AND {} IS NOT NULL", extra.column)),
            Filter::Value(Json::Null) => sql.push_str(&format!(" AND {} IS NULL", extra.column)),
            other => {
                if let Some((condition, value)) = equality_condition(&extra.column, other, values.len() + 1) {
                    values.push(value);
                    sql.push_str(&format!(" AND {condition}"));
                }
            }
        }
    }
    if options.exclude_deleted {
        sql.push_str(&format!(" AND {SOFT_DELETE_CONDITION}"));
    }
    if !options.returning.is_empty() {
        sql.push_str(&format!(" RETURNING {}", options.returning.join(", ")));
    }
    Some(PreparedQuery { sql, values })
}

fn conflict_clause(primary_key: &str, update_columns: &[String]) -> String {
    if update_columns.is_empty() {
        return format!(" ON CONFLICT ({primary_key}) DO NOTHING");
    }
    let mut clauses: Vec<String> = update_columns
        .iter()
        .filter(|column| column.as_str() != primary_key)
        .map(|column| format!("{column} = EXCLUDED.{column}"))
        .collect();
    clauses.push("updated = CURRENT_TIMESTAMP".to_string());
    format!(" ON CONFLICT ({primary_key}) DO UPDATE SET {}", clauses.join(", "))
}

pub fn build_upsert(table: &str, primary_key: &str, data: &QueryData, update_columns: &[String], returning: &[&str]) -> PreparedQuery {
    let mut columns = vec!["updated".to_string()];
    let mut placeholders = vec!["CURRENT_TIMESTAMP".to_string()];
    let mut values = Vec::new();
    for (key, value) in data {
        columns.push(key.clone());
        values.push(value.clone());
        placeholders.push(format!("${}", values.len()));
    }
    let mut sql = format!("INSERT INTO {table} ({}) VALUES ({})", columns.join(", "), placeholders.join(", "));
    sql.push_str(&conflict_clause(primary_key, update_columns));
    if !returning.is_empty() {
        sql.push_str(&format!(" RETURNING {}", returning.join(", ")));
    }
    PreparedQuery { sql, values }
}

/// A multi-row upsert. Every row must define the same columns as the first.
pub fn build_upsert_many(
    table: &str,
    primary_key: &str,
    rows: &[QueryData],
    update_columns: &[String],
    returning: &[&str],
) -> Option<PreparedQuery> {
    let first = rows.first()?;
    let columns: Vec<&String> = first.keys().collect();
    let mut values = Vec::new();
    let mut tuples = Vec::new();
    for row in rows {
        let mut placeholders = vec!["CURRENT_TIMESTAMP".to_string()];
        for column in &columns {
            values.push(row.get(*column).cloned().unwrap_or(Json::Null));
            placeholders.push(format!("${}", values.len()));
        }
        tuples.push(format!("({})", placeholders.join(", ")));
    }
    let mut all_columns = vec!["updated".to_string()];
    all_columns.extend(columns.iter().map(|c| c.to_string()));
    let mut sql = format!("INSERT INTO {table} ({}) VALUES {}", all_columns.join(", "), tuples.join(", "));
    sql.push_str(&conflict_clause(primary_key, update_columns));
    if !returning.is_empty() {
        sql.push_str(&format!(" RETURNING {}", returning.join(", ")));
    }
    Some(PreparedQuery { sql, values })
}

pub fn build_soft_delete(table: &str, primary_key: &str, primary_key_value: &Json, additional_where: Option<(&str, &Filter)>) -> PreparedQuery {
    let mut values = vec![primary_key_value.clone()];
    let mut sql = format!("UPDATE {table} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE {primary_key} = $1");
    if let Some((column, filter)) = additional_where {
        match equality_condition(column, filter, values.len() + 1) {
            Some((condition, value)) => {
                values.push(value);
                sql.push_str(&format!(" AND {condition}"));
            }
            None => sql.push_str(&format!(" AND {column} IS NOT NULL")),
        }
    }
    sql.push_str(&format!(" RETURNING {primary_key}"));
    PreparedQuery { sql, values }
}

#[derive(Clone, Debug, Default)]
pub struct DateRange {
    pub column: String,
    /// `YYYY-MM-DD` (or any text Postgres reads as the column's type).
    pub start: Option<String>,
    pub end: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct SearchFilters {
    /// The owner filter: a user id (an empty one adds no condition, as a
    /// falsy id does in the TypeScript) or [`shared_with`] a user.
    pub user_id: Option<Filter>,
    pub primary_key: Option<(String, Json)>,
    pub filters: Filters,
    /// `column IN (…)`; an empty list is skipped.
    pub in_filters: Vec<(String, Vec<Json>)>,
    pub date_range: Option<DateRange>,
    /// `None` takes the default: exclude soft-deleted rows.
    pub exclude_deleted: Option<bool>,
    /// `lower(column) = lower($N)`.
    pub equals_ignoring_case: Option<(String, String)>,
    /// Keyset pagination: only rows whose `column` sorts after `value`.
    pub after: Option<(String, Json)>,
    pub order_by: Option<String>,
    pub limit: Option<i64>,
    pub offset: Option<i64>,
}

pub fn build_select_with_filters(table: &str, columns: &str, options: &SearchFilters) -> PreparedQuery {
    let mut conditions: Vec<String> = Vec::new();
    let mut values: Vec<Json> = Vec::new();

    // A falsy user id (`""`, `null`) adds no condition, as in the TypeScript.
    match &options.user_id {
        Some(Filter::Value(value)) if !crate::js::truthy(value) => {}
        Some(filter) => match equality_condition("user_id", filter, values.len() + 1) {
            Some((condition, value)) => {
                values.push(value);
                conditions.push(condition);
            }
            None => conditions.push("user_id IS NOT NULL".to_string()),
        },
        None => {}
    }
    if let Some((column, value)) = &options.primary_key {
        values.push(value.clone());
        conditions.push(format!("{column} = ${}", values.len()));
    }
    for (key, filter) in &options.filters {
        match filter {
            Filter::IsNotNull => conditions.push(format!("{key} IS NOT NULL")),
            Filter::Value(Json::Null) => conditions.push(format!("{key} IS NULL")),
            other => {
                if let Some((condition, value)) = equality_condition(key, other, values.len() + 1) {
                    values.push(value);
                    conditions.push(condition);
                }
            }
        }
    }
    for (column, list) in &options.in_filters {
        if list.is_empty() {
            continue;
        }
        let placeholders: Vec<String> = list
            .iter()
            .map(|value| {
                values.push(value.clone());
                format!("${}", values.len())
            })
            .collect();
        conditions.push(format!("{column} IN ({})", placeholders.join(", ")));
    }
    if let Some((column, value)) = &options.equals_ignoring_case {
        values.push(Json::String(value.clone()));
        conditions.push(format!("lower({column}) = lower(${})", values.len()));
    }
    if let Some(range) = &options.date_range {
        if let Some(start) = range.start.as_ref().filter(|s| !s.is_empty()) {
            values.push(Json::String(start.clone()));
            conditions.push(format!("{} >= ${}", range.column, values.len()));
        }
        if let Some(end) = range.end.as_ref().filter(|s| !s.is_empty()) {
            values.push(Json::String(end.clone()));
            conditions.push(format!("{} <= ${}", range.column, values.len()));
        }
    }
    if options.exclude_deleted.unwrap_or(true) {
        conditions.push(SOFT_DELETE_CONDITION.to_string());
    }
    if let Some((column, value)) = &options.after {
        values.push(value.clone());
        conditions.push(format!("{column} > ${}", values.len()));
    }

    let mut sql = format!("SELECT {columns} FROM {table}");
    if !conditions.is_empty() {
        sql.push_str(&format!(" WHERE {}", conditions.join(" AND ")));
    }
    if let Some(order_by) = &options.order_by {
        sql.push_str(&format!(" ORDER BY {order_by}"));
    }
    if let Some(limit) = options.limit {
        values.push(Json::from(limit));
        sql.push_str(&format!(" LIMIT ${}", values.len()));
    }
    if let Some(offset) = options.offset {
        values.push(Json::from(offset));
        sql.push_str(&format!(" OFFSET ${}", values.len()));
    }
    PreparedQuery { sql, values }
}

/// What a repository write reports: the row's id and an HTTP-like status.
#[derive(Clone, Debug)]
pub struct UpsertResult {
    pub id: String,
    pub status: u16,
}

impl UpsertResult {
    pub fn to_json(&self) -> Json {
        serde_json::json!({ "update": { "_id": self.id }, "status": self.status })
    }
}

pub fn success_result(id: &str, row_count: Option<u64>) -> UpsertResult {
    UpsertResult { id: id.to_string(), status: if row_count.unwrap_or(0) > 0 { 200 } else { 404 } }
}

pub fn error_result(id: &str) -> UpsertResult {
    UpsertResult { id: id.to_string(), status: 500 }
}

/// The write was refused because the request named a row the caller can't use.
pub fn refused_result(id: &str) -> UpsertResult {
    UpsertResult { id: id.to_string(), status: 422 }
}

pub fn no_change_result(id: &str) -> UpsertResult {
    UpsertResult { id: id.to_string(), status: 304 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn data(value: Json) -> QueryData {
        value.as_object().cloned().unwrap()
    }

    #[test]
    fn insert_stamps_updated_first() {
        let query = build_insert("users", &data(json!({ "username": "a", "email": null })), &["user_id"], true);
        assert_eq!(
            query.sql,
            "INSERT INTO users (updated, username, email) VALUES (CURRENT_TIMESTAMP, $1, $2) ON CONFLICT DO NOTHING RETURNING user_id"
        );
        assert_eq!(query.values, vec![json!("a"), Json::Null]);
    }

    #[test]
    fn update_skips_raw_and_guards_tombstones() {
        let options = UpdateOptions {
            additional_where: &[AdditionalWhere::new("user_id", "u1"), AdditionalWhere::new("revoked_at", Json::Null)],
            returning: &["key_id"],
            exclude_deleted: true,
        };
        let query = build_update("t", "id", &json!("k"), &data(json!({ "raw": {}, "name": "n" })), &options).unwrap();
        assert_eq!(
            query.sql,
            "UPDATE t SET updated = CURRENT_TIMESTAMP, name = $1 WHERE id = $2 AND user_id = $3 AND revoked_at IS NULL AND (is_deleted IS NULL OR is_deleted = FALSE) RETURNING key_id"
        );
        assert!(build_update("t", "id", &json!("k"), &data(json!({ "raw": {} })), &options).is_none());
    }

    #[test]
    fn upsert_updates_named_columns() {
        let query = build_upsert("t", "id", &data(json!({ "id": "1", "a": 2 })), &["id".into(), "a".into()], &["*"]);
        assert_eq!(
            query.sql,
            "INSERT INTO t (updated, id, a) VALUES (CURRENT_TIMESTAMP, $1, $2) ON CONFLICT (id) DO UPDATE SET a = EXCLUDED.a, updated = CURRENT_TIMESTAMP RETURNING *"
        );
    }

    #[test]
    fn select_orders_conditions_like_the_typescript() {
        let query = build_select_with_filters(
            "t",
            "*",
            &SearchFilters {
                user_id: Some(Filter::from("u")),
                filters: crate::filters! { "a" => 1, "b" => Json::Null, "c" => Filter::IsNotNull },
                in_filters: vec![("d".into(), vec![json!("x"), json!("y")])],
                after: Some(("id".into(), json!("k"))),
                order_by: Some("id".into()),
                limit: Some(5),
                ..Default::default()
            },
        );
        assert_eq!(
            query.sql,
            "SELECT * FROM t WHERE user_id = $1 AND a = $2 AND b IS NULL AND c IS NOT NULL AND d IN ($3, $4) AND (is_deleted IS NULL OR is_deleted = FALSE) AND id > $5 ORDER BY id LIMIT $6"
        );
    }
}

#[cfg(test)]
mod sharing_tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn shared_with_widens_the_owner_column() {
        let query = build_select_with_filters(
            "accounts",
            "*",
            &SearchFilters {
                user_id: Some(Filter::SharedWith("u1".into())),
                filters: crate::filters! { "item_id" => "i1", "user_id" => Filter::SharedWith("u2".into()) },
                ..Default::default()
            },
        );
        assert_eq!(
            query.sql,
            "SELECT * FROM accounts WHERE user_id = ANY(sharing_user_ids($1)) AND item_id = $2 AND user_id = ANY(sharing_user_ids($3)) AND (is_deleted IS NULL OR is_deleted = FALSE)"
        );
        assert_eq!(query.values, vec![json!("u1"), json!("i1"), json!("u2")]);
    }

    #[test]
    fn a_falsy_owner_adds_nothing() {
        for owner in [Filter::from(""), Filter::Value(Json::Null)] {
            let query = build_select_with_filters("t", "*", &SearchFilters { user_id: Some(owner), ..Default::default() });
            assert_eq!(query.sql, "SELECT * FROM t WHERE (is_deleted IS NULL OR is_deleted = FALSE)");
        }
    }

    #[test]
    fn update_and_soft_delete_take_a_sharing_group() {
        let options = UpdateOptions {
            additional_where: &[AdditionalWhere::new("user_id", Filter::SharedWith("u".into()))],
            returning: &["chart_id"],
            exclude_deleted: true,
        };
        let data = json!({ "name": "n" }).as_object().cloned().unwrap();
        let query = build_update("charts", "chart_id", &json!("c"), &data, &options).unwrap();
        assert_eq!(
            query.sql,
            "UPDATE charts SET updated = CURRENT_TIMESTAMP, name = $1 WHERE chart_id = $2 AND user_id = ANY(sharing_user_ids($3)) AND (is_deleted IS NULL OR is_deleted = FALSE) RETURNING chart_id"
        );
        let delete = build_soft_delete("charts", "chart_id", &json!("c"), Some(("user_id", &Filter::SharedWith("u".into()))));
        assert_eq!(
            delete.sql,
            "UPDATE charts SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE chart_id = $1 AND user_id = ANY(sharing_user_ids($2)) RETURNING chart_id"
        );
        assert_eq!(delete.values, vec![json!("c"), json!("u")]);
    }
}
