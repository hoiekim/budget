//! Automatic schema migration: adds columns the schema declares and the
//! database lacks, never drops or changes one, and stops the start on a type
//! mismatch. `src/server/lib/postgres/migration.ts`.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::json;

use crate::server::logger;
use crate::server::postgres::client::{pool, Client, Executor};

static DEFAULT_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)DEFAULT\s+").unwrap());
static NOT_NULL_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)NOT\s+NULL").unwrap());
static PRIMARY_KEY_RE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)PRIMARY\s+KEY").unwrap());

/// The normalized type of a schema column definition.
pub fn parse_column_type(definition: &str) -> String {
    let upper = definition.trim().to_uppercase();
    let parts: Vec<&str> = upper.split_whitespace().collect();
    let raw = parts.first().copied().unwrap_or("");
    let two_words = if parts.len() > 1 { format!("{} {}", parts[0], parts[1]) } else { String::new() };
    let normalized = if raw.starts_with("VARCHAR") {
        "VARCHAR"
    } else if raw.starts_with("CHAR") && raw != "CHAR" {
        "CHAR"
    } else if raw == "TIMESTAMPTZ" || raw == "TIMESTAMP" {
        "TIMESTAMP"
    } else if raw == "INTEGER" || raw == "INT" || raw == "SERIAL" {
        "INTEGER"
    } else if raw == "BIGINT" || raw == "BIGSERIAL" {
        "BIGINT"
    } else if raw.starts_with("DECIMAL") || raw.starts_with("NUMERIC") {
        "NUMERIC"
    } else if matches!(raw, "REAL" | "FLOAT" | "FLOAT4" | "FLOAT8") || two_words == "DOUBLE PRECISION" {
        "FLOAT"
    } else {
        raw
    };
    normalized.to_string()
}

/// Maps `information_schema`'s `data_type` and `udt_name` to the normalized type.
pub fn normalize_db_type(data_type: &str, udt_name: &str) -> String {
    let data_type = data_type.to_uppercase();
    let udt = udt_name.to_uppercase();
    if data_type == "USER-DEFINED" {
        return udt;
    }
    if data_type.contains("TIMESTAMP") {
        return "TIMESTAMP".into();
    }
    if data_type.contains("CHARACTER VARYING") {
        return "VARCHAR".into();
    }
    if data_type.contains("CHARACTER") {
        return "CHAR".into();
    }
    match data_type.as_str() {
        "TEXT" | "INTEGER" | "BIGINT" | "SMALLINT" | "BOOLEAN" | "UUID" => return data_type,
        "NUMERIC" | "DECIMAL" => return "NUMERIC".into(),
        "REAL" | "DOUBLE PRECISION" => return "FLOAT".into(),
        _ => {}
    }
    if data_type == "JSONB" || udt == "JSONB" {
        return "JSONB".into();
    }
    if data_type == "JSON" || udt == "JSON" {
        return "JSON".into();
    }
    if data_type == "ARRAY" {
        let element = udt_name.strip_prefix('_').unwrap_or(udt_name);
        return format!("{}[]", normalize_db_type(element, udt_name));
    }
    data_type
}

pub fn types_compatible(schema_type: &str, db_type: &str) -> bool {
    if schema_type == db_type {
        return true;
    }
    let both = |options: &[&str]| options.contains(&schema_type) && options.contains(&db_type);
    both(&["VARCHAR", "TEXT"]) || both(&["JSON", "JSONB"]) || both(&["INTEGER", "INT4"]) || both(&["FLOAT", "FLOAT8"])
}

/// The `ALTER TABLE … ADD COLUMN` for a missing column. A `NOT NULL` column
/// without a default gets one inferred from its type, since existing rows need a value.
pub fn build_add_column_sql(table: &str, column: &str, definition: &str) -> String {
    let mut clean = PRIMARY_KEY_RE.replace_all(definition, "").to_string();
    if NOT_NULL_RE.is_match(definition) && !DEFAULT_RE.is_match(definition) {
        let column_type = definition.split_whitespace().next().unwrap_or("").to_uppercase();
        let default = match column_type.as_str() {
            "BOOLEAN" => "FALSE",
            "INTEGER" | "BIGINT" | "SMALLINT" => "0",
            "UUID" => "gen_random_uuid()",
            "JSONB" => "'{}'::jsonb",
            "JSON" => "'{}'::json",
            other if other.contains("TIMESTAMP") => "CURRENT_TIMESTAMP",
            _ => "''",
        };
        clean = NOT_NULL_RE.replace(&clean, format!("DEFAULT {default} NOT NULL")).to_string();
    }
    format!("ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {column} {}", clean.trim())
}

#[derive(Default)]
pub struct MigrationResult {
    pub table: String,
    pub added: Vec<String>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

async fn migrate_table(client: &Client, table: &str, schema: &[(&str, &str)]) -> anyhow::Result<MigrationResult> {
    let mut result = MigrationResult { table: table.to_string(), ..Default::default() };
    let existing = client
        .query(
            "
    SELECT column_name, data_type, udt_name, is_nullable, column_default
    FROM information_schema.columns
    WHERE table_name = $1 AND table_schema = 'public'
    ORDER BY ordinal_position
  ",
            &[json!(table)],
        )
        .await?
        .rows;
    // A table that doesn't exist yet has nothing to migrate.
    if existing.is_empty() {
        return Ok(result);
    }
    let text = |row: &crate::js::Obj, key: &str| row.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string();

    for (column, definition) in schema {
        match existing.iter().find(|row| text(row, "column_name") == *column) {
            None => match client.query(&build_add_column_sql(table, column, definition), &[]).await {
                Ok(_) => {
                    result.added.push(column.to_string());
                    logger::info(&format!("Added column {table}.{column}"), Some(&crate::ctx! { "component": "migration" }));
                }
                Err(error) => result.errors.push(format!("Failed to add {column}: {error}")),
            },
            Some(row) => {
                let schema_type = parse_column_type(definition);
                let db_type = normalize_db_type(&text(row, "data_type"), &text(row, "udt_name"));
                if !types_compatible(&schema_type, &db_type) {
                    result.errors.push(format!(
                        "Type mismatch for {column}: schema expects {schema_type}, database has {db_type}"
                    ));
                }
            }
        }
    }
    for row in &existing {
        let name = text(row, "column_name");
        if !schema.iter().any(|(column, _)| *column == name) {
            result.warnings.push(format!("Extra column in database: {name} (not in schema)"));
        }
    }
    Ok(result)
}

/// Arbitrary stable lock key serializing migrations across instances.
const MIGRATION_ADVISORY_LOCK_KEY: i64 = 6453604;

async fn migrate_all(client: &Client, tables: &[(&str, &[(&str, &str)])]) -> anyhow::Result<()> {
    let context = crate::ctx! { "component": "migration" };
    // A session-level lock, so concurrent starts don't race on ALTER TABLE.
    client.query("SELECT pg_advisory_lock($1)", &[json!(MIGRATION_ADVISORY_LOCK_KEY)]).await?;
    println!("[Migration] Advisory lock acquired.");
    client.query("BEGIN", &[]).await?;

    let mut results = Vec::new();
    let mut fatal: Vec<String> = Vec::new();
    for (name, schema) in tables {
        let result = migrate_table(client, name, schema).await?;
        fatal.extend(result.errors.iter().map(|error| format!("{name}: {error}")));
        results.push(result);
    }

    let total_added: usize = results.iter().map(|r| r.added.len()).sum();
    if total_added > 0 {
        let tables_changed = results.iter().filter(|r| !r.added.is_empty()).count();
        logger::info(&format!("Added {total_added} column(s) across {tables_changed} table(s)"), Some(&context));
    }
    for result in &results {
        for warning in &result.warnings {
            logger::warn(&format!("{}: {}", result.table, warning), Some(&context), None);
        }
    }
    if !fatal.is_empty() {
        let message = format!("Schema migration failed:\n{}", fatal.join("\n"));
        logger::error(&message, Some(&context), None);
        client.query("ROLLBACK", &[]).await?;
        anyhow::bail!(message);
    }
    client.query("COMMIT", &[]).await?;
    logger::info("Schema migration check complete", Some(&context));
    Ok(())
}

/// Runs the migration for every table inside one transaction.
pub async fn run_migrations(tables: &[(&str, &[(&str, &str)])]) -> anyhow::Result<()> {
    logger::info("Starting schema migration check", Some(&crate::ctx! { "component": "migration" }));
    let client = pool().connect().await?;
    let outcome = migrate_all(&client, tables).await;
    if outcome.is_err() {
        let _ = client.query("ROLLBACK", &[]).await;
    }
    // Released before the connection goes back to the pool; a no-op if it was never taken.
    let _ = client.query("SELECT pg_advisory_unlock($1)", &[json!(MIGRATION_ADVISORY_LOCK_KEY)]).await;
    outcome
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_schema_types() {
        assert_eq!(parse_column_type("VARCHAR(255) UNIQUE NOT NULL"), "VARCHAR");
        assert_eq!(parse_column_type("DECIMAL(15, 2)"), "NUMERIC");
        assert_eq!(parse_column_type("TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"), "TIMESTAMP");
        assert_eq!(parse_column_type("TEXT[] NOT NULL DEFAULT '{}'"), "TEXT[]");
        assert_eq!(parse_column_type("DOUBLE PRECISION"), "FLOAT");
        assert_eq!(parse_column_type("UUID PRIMARY KEY DEFAULT gen_random_uuid()"), "UUID");
    }

    #[test]
    fn normalizes_database_types() {
        assert_eq!(normalize_db_type("character varying", "varchar"), "VARCHAR");
        assert_eq!(normalize_db_type("timestamp with time zone", "timestamptz"), "TIMESTAMP");
        assert_eq!(normalize_db_type("ARRAY", "_text"), "TEXT[]");
        assert_eq!(normalize_db_type("jsonb", "jsonb"), "JSONB");
        assert_eq!(normalize_db_type("double precision", "float8"), "FLOAT");
        assert!(types_compatible("VARCHAR", "TEXT"));
        assert!(!types_compatible("UUID", "TEXT"));
    }

    #[test]
    fn not_null_columns_get_a_default() {
        assert_eq!(
            build_add_column_sql("items", "user_id", "UUID REFERENCES users(user_id) ON DELETE RESTRICT NOT NULL"),
            "ALTER TABLE items ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(user_id) ON DELETE RESTRICT DEFAULT gen_random_uuid() NOT NULL"
        );
        assert_eq!(
            build_add_column_sql("t", "name", "VARCHAR(255) NOT NULL"),
            "ALTER TABLE t ADD COLUMN IF NOT EXISTS name VARCHAR(255) DEFAULT '' NOT NULL"
        );
    }
}
