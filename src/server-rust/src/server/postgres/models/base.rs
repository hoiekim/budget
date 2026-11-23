//! The `Table` base, method for method `src/server/lib/postgres/models/base.ts`.
//!
//! A row is a JSON object as the client decoded it. Where the TypeScript
//! wraps a row in a `Model` whose constructor type-checks every column, a
//! table here carries the same checks as data ([`Check`]) and `validate`
//! applies them: a row that fails is an error, exactly as the `Model`
//! constructor throws. Each table's module adds its own `to_json(&row)`.

use std::fmt;

use futures::stream::{self, BoxStream};


use crate::js::{Json, Obj};
use crate::server::postgres::client::{or_pool, pool, Executor};
use crate::server::postgres::database::{
    build_insert, build_select_with_filters, build_soft_delete, build_update, build_upsert, build_upsert_many,
    equality_condition, AdditionalWhere, Filter, Filters, QueryData, SearchFilters, UpdateOptions,
};

/// Rows per database read when a result is streamed rather than returned whole.
pub const STREAM_BATCH_SIZE: usize = 500;

/// A validated row.
pub type Row = Obj;

/// The type check a model applies to one column; `None` is a missing column (`undefined`).
#[derive(Clone, Copy)]
pub enum Check {
    String,
    Number,
    Boolean,
    NullableString,
    NullableNumber,
    NullableBoolean,
    NullableObject,
    NullableArray,
    OptionalNullableObject,
    StringArray,
    Custom(fn(Option<&Json>) -> bool),
}

impl Check {
    pub fn passes(&self, value: Option<&Json>) -> bool {
        match self {
            Check::String => matches!(value, Some(Json::String(_))),
            Check::Number => matches!(value, Some(Json::Number(_))),
            Check::Boolean => matches!(value, Some(Json::Bool(_))),
            Check::NullableString => matches!(value, Some(Json::Null) | Some(Json::String(_))),
            Check::NullableNumber => matches!(value, Some(Json::Null) | Some(Json::Number(_))),
            Check::NullableBoolean => matches!(value, Some(Json::Null) | Some(Json::Bool(_))),
            // `isObject` is `typeof value === "object" && value !== null`, which arrays pass too.
            Check::NullableObject => matches!(value, Some(Json::Null) | Some(Json::Object(_)) | Some(Json::Array(_))),
            Check::NullableArray => matches!(value, Some(Json::Null) | Some(Json::Array(_))),
            Check::OptionalNullableObject => {
                matches!(value, None | Some(Json::Null) | Some(Json::Object(_)) | Some(Json::Array(_)))
            }
            Check::StringArray => match value {
                Some(Json::Array(items)) => items.iter().all(|item| item.is_string()),
                _ => false,
            },
            Check::Custom(check) => check(value),
        }
    }
}

#[derive(Debug)]
pub struct ModelValidationError {
    pub model: &'static str,
    pub errors: Vec<String>,
}

impl fmt::Display for ModelValidationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} validation failed:\n{}", self.model, self.errors.join("\n"))
    }
}

impl std::error::Error for ModelValidationError {}

#[derive(Clone, Copy)]
pub enum IndexKey {
    Column(&'static str),
    Columns(&'static [&'static str]),
    /// An expression such as `lower(email)` makes no index name of its own.
    Expression { expression: &'static str, name: &'static str },
}

#[derive(Clone, Copy)]
pub struct IndexDefinition {
    pub key: IndexKey,
    pub unique: bool,
    /// Makes the index partial: it covers only the rows this predicate holds for.
    pub predicate: Option<&'static str>,
}

impl IndexDefinition {
    pub const fn column(column: &'static str) -> Self {
        IndexDefinition { key: IndexKey::Column(column), unique: false, predicate: None }
    }

    pub const fn columns(columns: &'static [&'static str]) -> Self {
        IndexDefinition { key: IndexKey::Columns(columns), unique: false, predicate: None }
    }
}

/// One database table: its schema, its row checks and the generic statements.
pub struct Table {
    pub name: &'static str,
    pub primary_key: &'static str,
    /// Column definitions in declaration order.
    pub schema: &'static [(&'static str, &'static str)],
    pub constraints: &'static [&'static str],
    pub indexes: &'static [IndexDefinition],
    /// The model's class name, for validation errors.
    pub model: &'static str,
    pub checks: &'static [(&'static str, Check)],
    pub supports_soft_delete: bool,
}

/// Options of [`Table::update`] beyond the data.
#[derive(Default)]
pub struct UpdateArgs<'a> {
    /// Defaults to the primary key.
    pub returning: Option<&'a [&'a str]>,
    /// ANDs an owner condition into the WHERE: `user_id = $N` for an id,
    /// the sharing-group predicate for [`shared_with`](crate::server::postgres::database::shared_with).
    pub user_id: Option<Filter>,
    pub client: Option<&'a dyn Executor>,
    pub extra_where: &'a [AdditionalWhere],
    /// Defaults to true: a soft-deleted row is not updated.
    pub exclude_deleted: Option<bool>,
}

/// ` AND <key> = $N` per filter, numbered after the values already bound;
/// [`Filter::SharedWith`] widens its column to the sharing group.
fn append_equality_filters(filters: &[(&str, Filter)], values: &mut Vec<Json>) -> String {
    let mut sql = String::new();
    for (key, filter) in filters {
        match equality_condition(key, filter, values.len() + 1) {
            Some((condition, value)) => {
                values.push(value);
                sql.push_str(&format!(" AND {condition}"));
            }
            None => sql.push_str(&format!(" AND {key} IS NOT NULL")),
        }
    }
    sql
}

fn placeholders(count: usize) -> String {
    (1..=count).map(|i| format!("${i}")).collect::<Vec<_>>().join(", ")
}

impl Table {
    pub fn columns(&self) -> Vec<&'static str> {
        self.schema.iter().map(|(column, _)| *column).collect()
    }

    /// The `Model` constructor: checks every column and keeps exactly the checked ones.
    pub fn validate(&self, row: Obj) -> anyhow::Result<Row> {
        let mut errors = Vec::new();
        for (key, check) in self.checks {
            let value = row.get(*key);
            if !check.passes(value) {
                errors.push(format!(
                    "{}: {} ({})",
                    key,
                    value.map(crate::js::json_stringify).unwrap_or_else(|| "undefined".to_string()),
                    crate::js::type_of(value)
                ));
            }
        }
        if !errors.is_empty() {
            return Err(ModelValidationError { model: self.model, errors }.into());
        }
        let mut model = Obj::new();
        for (key, _) in self.checks {
            if let Some(value) = row.get(*key) {
                model.insert(key.to_string(), value.clone());
            }
        }
        Ok(model)
    }

    fn validate_all(&self, rows: Vec<Obj>) -> anyhow::Result<Vec<Row>> {
        rows.into_iter().map(|row| self.validate(row)).collect()
    }

    /// Composite-primary-key tables cannot use the single-column helpers.
    fn assert_simple_primary_key(&self, method: &str) -> anyhow::Result<()> {
        let composite = self.constraints.iter().any(|constraint| {
            let upper = constraint.to_uppercase();
            let collapsed = upper.split_whitespace().collect::<Vec<_>>().join(" ");
            collapsed.starts_with("PRIMARY KEY(")
                || collapsed.starts_with("PRIMARY KEY (")
                || collapsed.contains(" PRIMARY KEY(")
                || collapsed.contains(" PRIMARY KEY (")
        });
        if composite {
            anyhow::bail!(
                "Table.{}() is not supported on '{}' — composite PRIMARY KEY tables must use raw pool.query writes in their repository layer.",
                method,
                self.name
            );
        }
        Ok(())
    }

    fn with_defaults(&self, mut options: SearchFilters, filters: Filters) -> SearchFilters {
        options.filters = filters;
        options.exclude_deleted = Some(options.exclude_deleted.unwrap_or(self.supports_soft_delete));
        options
    }

    pub async fn query(&self, filters: Filters, options: SearchFilters, client: Option<&dyn Executor>) -> anyhow::Result<Vec<Row>> {
        let query = build_select_with_filters(self.name, "*", &self.with_defaults(options, filters));
        let result = or_pool(client).query(&query.sql, &query.values).await?;
        self.validate_all(result.rows)
    }

    /// `query` in primary-key order, `batch_size` rows at a time, so a caller
    /// streaming a large result never holds more than one batch.
    pub fn query_in_batches(
        &'static self,
        filters: Filters,
        options: SearchFilters,
        batch_size: usize,
    ) -> BoxStream<'static, anyhow::Result<Vec<Row>>> {
        struct State {
            after: Option<(String, Json)>,
            done: bool,
        }
        let base = self.with_defaults(options, filters);
        Box::pin(stream::unfold(State { after: None, done: false }, move |mut state| {
            let base = base.clone();
            async move {
                if state.done {
                    return None;
                }
                if let Err(error) = self.assert_simple_primary_key("queryInBatches") {
                    state.done = true;
                    return Some((Err(error), state));
                }
                let options = SearchFilters {
                    after: state.after.take(),
                    order_by: Some(self.primary_key.to_string()),
                    limit: Some(batch_size as i64),
                    offset: None,
                    ..base
                };
                let query = build_select_with_filters(self.name, "*", &options);
                let rows = match pool().query(&query.sql, &query.values).await {
                    Ok(result) => result.rows,
                    Err(error) => {
                        state.done = true;
                        return Some((Err(error), state));
                    }
                };
                if rows.is_empty() {
                    return None;
                }
                if rows.len() < batch_size {
                    state.done = true;
                } else {
                    let last = rows[rows.len() - 1].get(self.primary_key).cloned().unwrap_or(Json::Null);
                    state.after = Some((self.primary_key.to_string(), last));
                }
                let validated = self.validate_all(rows);
                if validated.is_err() {
                    state.done = true;
                }
                Some((validated, state))
            }
        }))
    }

    pub async fn query_one(&self, filters: Filters) -> anyhow::Result<Option<Row>> {
        let options = SearchFilters {
            filters,
            limit: Some(1),
            exclude_deleted: Some(self.supports_soft_delete),
            ..Default::default()
        };
        let query = build_select_with_filters(self.name, "*", &options);
        let result = pool().query(&query.sql, &query.values).await?;
        result.rows.into_iter().next().map(|row| self.validate(row)).transpose()
    }

    /// Inserts one row. `on_conflict_do_nothing` turns a row that would break
    /// a unique constraint into no row written, resolving to `None`.
    pub async fn insert(
        &self,
        data: &QueryData,
        returning: Option<&[&str]>,
        on_conflict_do_nothing: bool,
    ) -> anyhow::Result<Option<Obj>> {
        self.assert_simple_primary_key("insert")?;
        let query = build_insert(self.name, data, returning.unwrap_or(&[self.primary_key]), on_conflict_do_nothing);
        let result = pool().query(&query.sql, &query.values).await?;
        Ok(result.rows.into_iter().next())
    }

    /// Updates one row by primary key; `None` when no row matched or `data` set nothing.
    pub async fn update(&self, primary_key_value: &Json, data: &QueryData, args: UpdateArgs<'_>) -> anyhow::Result<Option<Obj>> {
        self.assert_simple_primary_key("update")?;
        let mut additional_where: Vec<AdditionalWhere> = Vec::new();
        if let Some(owner) = args.user_id {
            additional_where.push(AdditionalWhere { column: "user_id".to_string(), value: owner });
        }
        additional_where.extend(args.extra_where.iter().cloned());
        let default_returning = [self.primary_key];
        let options = UpdateOptions {
            additional_where: &additional_where,
            returning: args.returning.unwrap_or(&default_returning),
            exclude_deleted: args.exclude_deleted.unwrap_or(true) && self.supports_soft_delete,
        };
        let Some(query) = build_update(self.name, self.primary_key, primary_key_value, data, &options) else {
            return Ok(None);
        };
        let result = or_pool(args.client).query(&query.sql, &query.values).await?;
        Ok(result.rows.into_iter().next())
    }

    /// Inserts a row or, on a primary-key conflict, updates `update_columns`
    /// (by default every column `data` carries). Returns the whole row.
    /// `conflict_columns` finds the existing row by another unique key than
    /// the primary key: the columns of a UNIQUE constraint the table declares.
    pub async fn upsert(
        &self,
        data: &QueryData,
        update_columns: Option<&[&str]>,
        client: Option<&dyn Executor>,
        conflict_columns: Option<&[&str]>,
    ) -> anyhow::Result<Option<Obj>> {
        self.assert_simple_primary_key("upsert")?;
        let writable: Vec<String> = data.keys().filter(|key| key.as_str() != self.primary_key).cloned().collect();
        let update_columns: Vec<String> = match update_columns {
            Some(columns) => columns.iter().filter(|c| writable.iter().any(|w| w == *c)).map(|c| c.to_string()).collect(),
            None => writable,
        };
        let query = build_upsert(self.name, self.primary_key, data, &update_columns, &["*"], conflict_columns);
        let result = or_pool(client).query(&query.sql, &query.values).await?;
        Ok(result.rows.into_iter().next())
    }

    /// Upserts many rows in one round trip per distinct set of columns. Of
    /// rows sharing a primary key, the last wins.
    pub async fn upsert_many(
        &self,
        rows: &[QueryData],
        update_columns: Option<&[&str]>,
        client: Option<&dyn Executor>,
    ) -> anyhow::Result<Vec<Obj>> {
        self.assert_simple_primary_key("upsertMany")?;
        if rows.is_empty() {
            return Ok(Vec::new());
        }
        // A JS Map keeps a key's first position and its last value.
        let mut deduped: indexmap::IndexMap<String, &QueryData> = indexmap::IndexMap::new();
        for row in rows {
            let key = row.get(self.primary_key).map(crate::js::json_stringify).unwrap_or_else(|| "undefined".to_string());
            deduped.insert(key, row);
        }
        let mut groups: indexmap::IndexMap<String, Vec<QueryData>> = indexmap::IndexMap::new();
        for row in deduped.values() {
            let mut defined: Vec<&String> = row.keys().collect();
            defined.sort();
            let signature = defined.iter().map(|k| k.as_str()).collect::<Vec<_>>().join(",");
            groups.entry(signature).or_default().push((*row).clone());
        }
        let executor = or_pool(client);
        let mut upserted = Vec::new();
        for (signature, group) in &groups {
            let writable: Vec<&str> = signature.split(',').filter(|column| *column != self.primary_key).collect();
            let update: Vec<String> = match update_columns {
                Some(columns) => columns.iter().filter(|c| writable.contains(c)).map(|c| c.to_string()).collect(),
                None => writable.iter().map(|c| c.to_string()).collect(),
            };
            let Some(query) = build_upsert_many(self.name, self.primary_key, group, &update, &["*"]) else { continue };
            let result = executor.query(&query.sql, &query.values).await?;
            upserted.extend(result.rows);
        }
        Ok(upserted)
    }

    pub async fn soft_delete(&self, primary_key_value: &Json, owner: Option<Filter>) -> anyhow::Result<bool> {
        self.assert_simple_primary_key("softDelete")?;
        let query = build_soft_delete(self.name, self.primary_key, primary_key_value, owner.as_ref().map(|o| ("user_id", o)));
        let result = pool().query(&query.sql, &query.values).await?;
        Ok(result.row_count.unwrap_or(0) > 0)
    }

    pub async fn query_by_ids(&self, ids: &[Json], additional_filters: &[(&str, Filter)]) -> anyhow::Result<Vec<Row>> {
        self.assert_simple_primary_key("queryByIds")?;
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut sql = format!("SELECT * FROM {} WHERE {} IN ({})", self.name, self.primary_key, placeholders(ids.len()));
        if self.supports_soft_delete {
            sql.push_str(" AND (is_deleted IS NULL OR is_deleted = FALSE)");
        }
        let mut values: Vec<Json> = ids.to_vec();
        sql.push_str(&append_equality_filters(additional_filters, &mut values));
        let result = pool().query(&sql, &values).await?;
        self.validate_all(result.rows)
    }

    pub async fn bulk_soft_delete(
        &self,
        ids: &[Json],
        additional_filters: &[(&str, Filter)],
        client: Option<&dyn Executor>,
    ) -> anyhow::Result<u64> {
        self.assert_simple_primary_key("bulkSoftDelete")?;
        if ids.is_empty() {
            return Ok(0);
        }
        let mut sql = format!(
            "UPDATE {} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE {} IN ({})",
            self.name,
            self.primary_key,
            placeholders(ids.len())
        );
        let mut values: Vec<Json> = ids.to_vec();
        sql.push_str(&append_equality_filters(additional_filters, &mut values));
        sql.push_str(&format!(" RETURNING {}", self.primary_key));
        let result = or_pool(client).query(&sql, &values).await?;
        Ok(result.row_count.unwrap_or(0))
    }

    /// Soft-deletes the rows whose `column` equals `column_value`, or is any
    /// of it when it is an array (an empty array deletes nothing).
    pub async fn bulk_soft_delete_by_column(
        &self,
        column: &str,
        column_value: &Json,
        owner: Option<Filter>,
        client: Option<&dyn Executor>,
    ) -> anyhow::Result<u64> {
        self.assert_simple_primary_key("bulkSoftDeleteByColumn")?;
        let predicate = match column_value {
            Json::Array(items) if items.is_empty() => return Ok(0),
            Json::Array(_) => format!("{column} = ANY($1)"),
            _ => format!("{column} = $1"),
        };
        let mut sql = format!("UPDATE {} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE {predicate}", self.name);
        let mut values = vec![column_value.clone()];
        if let Some(owner) = owner {
            sql.push_str(&append_equality_filters(&[("user_id", owner)], &mut values));
        }
        sql.push_str(&format!(" RETURNING {}", self.primary_key));
        let result = or_pool(client).query(&sql, &values).await?;
        Ok(result.row_count.unwrap_or(0))
    }

    /// Soft-deletes rows whose `column` matches a row of `source_table`
    /// selected by `match_column = ANY(match_values)`. The identifiers are
    /// interpolated and must be schema constants.
    #[allow(clippy::too_many_arguments)]
    pub async fn bulk_soft_delete_by_related_column(
        &self,
        column: &str,
        source_table: &str,
        select_column: &str,
        match_column: &str,
        match_values: &[Json],
        owner: Option<Filter>,
        client: Option<&dyn Executor>,
    ) -> anyhow::Result<u64> {
        self.assert_simple_primary_key("bulkSoftDeleteByRelatedColumn")?;
        if match_values.is_empty() {
            return Ok(0);
        }
        let mut sql = format!(
            "UPDATE {} SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP WHERE {column} IN (SELECT {select_column} FROM {source_table} WHERE {match_column} = ANY($1))",
            self.name
        );
        let mut values = vec![Json::Array(match_values.to_vec())];
        if let Some(owner) = owner {
            sql.push_str(&append_equality_filters(&[("user_id", owner)], &mut values));
        }
        sql.push_str(&format!(" RETURNING {}", self.primary_key));
        let result = or_pool(client).query(&sql, &values).await?;
        Ok(result.row_count.unwrap_or(0))
    }

    pub async fn hard_delete(&self, primary_key_value: &Json) -> anyhow::Result<bool> {
        self.assert_simple_primary_key("hardDelete")?;
        let sql = format!("DELETE FROM {} WHERE {} = $1 RETURNING {}", self.name, self.primary_key, self.primary_key);
        let result = pool().query(&sql, std::slice::from_ref(primary_key_value)).await?;
        Ok(result.row_count.unwrap_or(0) > 0)
    }

    pub async fn bulk_hard_delete(&self, ids: &[Json]) -> anyhow::Result<u64> {
        self.assert_simple_primary_key("bulkHardDelete")?;
        if ids.is_empty() {
            return Ok(0);
        }
        let sql = format!(
            "DELETE FROM {} WHERE {} IN ({}) RETURNING {}",
            self.name,
            self.primary_key,
            placeholders(ids.len()),
            self.primary_key
        );
        let result = pool().query(&sql, ids).await?;
        Ok(result.row_count.unwrap_or(0))
    }

    pub async fn hard_delete_by_column(&self, column: &str, column_value: &Json) -> anyhow::Result<u64> {
        self.assert_simple_primary_key("hardDeleteByColumn")?;
        let sql = format!("DELETE FROM {} WHERE {column} = $1 RETURNING {}", self.name, self.primary_key);
        let result = pool().query(&sql, std::slice::from_ref(column_value)).await?;
        Ok(result.row_count.unwrap_or(0))
    }

    /// Deletes the rows where `column <operator> value`; `operator` is one of `= <= >= < > !=`.
    pub async fn delete_by_condition(&self, column: &str, operator: &str, value: &Json) -> anyhow::Result<u64> {
        self.assert_simple_primary_key("deleteByCondition")?;
        let sql = format!("DELETE FROM {} WHERE {column} {operator} $1 RETURNING {}", self.name, self.primary_key);
        let result = pool().query(&sql, std::slice::from_ref(value)).await?;
        Ok(result.row_count.unwrap_or(0))
    }
}

/// Reads a string column of a validated row; empty when absent or null.
pub fn str_of<'a>(row: &'a Obj, column: &str) -> &'a str {
    row.get(column).and_then(|v| v.as_str()).unwrap_or("")
}

/// A column of a row as an owned value; `null` when absent.
pub fn value_of(row: &Obj, column: &str) -> Json {
    row.get(column).cloned().unwrap_or(Json::Null)
}
