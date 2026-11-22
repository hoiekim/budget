//! Creates tables, runs the column migration, creates indexes and the
//! default users at every start: `src/server/lib/postgres/initialize.ts`.

use std::time::Duration;

use crate::js::to_js_string;
use crate::server::logger;
use crate::server::postgres::client::{pool, Executor};
use crate::server::postgres::database::{build_create_index, build_create_table, build_select_duplicate_keys};
use crate::server::postgres::migration::run_migrations;
use crate::server::postgres::models::sharing::CREATE_SHARING_USER_IDS_FUNCTION;
use crate::server::postgres::models::{tables, IndexKey};
use crate::server::postgres::repositories::users::{search_user, write_user};

/// The app's data version, reported by `GET /login`.
pub const VERSION: &str = "6";

/// Stops the start when existing rows share a key a unique index is about to
/// forbid, naming every shared key and nothing else of those rows.
async fn refuse_duplicate_keys(table: &str, keys: &[String], predicate: Option<&str>) -> anyhow::Result<()> {
    let rows = pool().query(&build_select_duplicate_keys(table, keys, predicate), &[]).await?.rows;
    if rows.is_empty() {
        return Ok(());
    }
    let key_name = if keys.len() > 1 { format!("({})", keys.join(", ")) } else { keys[0].clone() };
    let duplicates: Vec<String> =
        rows.iter().map(|row| format!("- {}", row.values().map(to_js_string).collect::<Vec<_>>().join(", "))).collect();
    let message = format!(
        "These values of {key_name} are shared by more than one {table} row, and must be unique. Change the rows so no two match, then start again:\n{}",
        duplicates.join("\n")
    );
    logger::error(&message, None, None);
    anyhow::bail!(message)
}

async fn create_schema() -> anyhow::Result<()> {
    // pg_trgm enables similarity()-based fuzzy matching on merchant names.
    pool().query("CREATE EXTENSION IF NOT EXISTS pg_trgm", &[]).await?;
    let tables = tables();
    for table in &tables {
        pool().query(&build_create_table(table.name, table.schema, table.constraints), &[]).await?;
    }
    logger::info("Database tables created/verified successfully", None);

    pool().query(CREATE_SHARING_USER_IDS_FUNCTION, &[]).await?;

    let schemas: Vec<(&str, &[(&str, &str)])> = tables.iter().map(|t| (t.name, t.schema)).collect();
    run_migrations(&schemas).await?;

    // After the migrations, so an index can cover a column they just added.
    for table in &tables {
        for index in table.indexes {
            let (keys, name): (Vec<String>, Option<&str>) = match index.key {
                IndexKey::Column(column) => (vec![column.to_string()], None),
                IndexKey::Columns(columns) => (columns.iter().map(|c| c.to_string()).collect(), None),
                IndexKey::Expression { expression, name } => (vec![expression.to_string()], Some(name)),
            };
            if index.unique {
                refuse_duplicate_keys(table.name, &keys, index.predicate).await?;
            }
            pool().query(&build_create_index(table.name, &keys, name, index.unique, index.predicate), &[]).await?;
        }
    }
    Ok(())
}

pub async fn initialize_postgres() -> anyhow::Result<()> {
    logger::info("Initialization started", None);
    loop {
        match pool().connect().await {
            Ok(_) => {
                logger::info("PostgreSQL connection established", None);
                break;
            }
            Err(error) => {
                logger::warn("PostgreSQL connection failed, retrying in 10 seconds", None, Some(&error));
                tokio::time::sleep(Duration::from_secs(10)).await;
            }
        }
    }

    if let Err(error) = create_schema().await {
        logger::error("Failed to create tables", None, Some(&error));
        anyhow::bail!("Failed to setup PostgreSQL tables.");
    }

    let password_of = |name: &str| std::env::var(name).ok().filter(|p| !p.is_empty()).unwrap_or_else(|| "budget".to_string());

    let existing_admin = search_user(None, Some("admin")).await?;
    let created = write_user(existing_admin.as_ref().map(|u| u.user_id.as_str()), "admin", &password_of("ADMIN_PASSWORD")).await?;
    if created.is_none() {
        anyhow::bail!("Failed to create admin user");
    }

    let existing_demo = search_user(None, Some("demo")).await?;
    write_user(existing_demo.as_ref().map(|u| u.user_id.as_str()), "demo", &password_of("DEMO_PASSWORD")).await?;

    logger::info("Successfully initialized PostgreSQL database and setup default users", None);
    Ok(())
}
