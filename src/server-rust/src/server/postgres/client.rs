//! The connection pool and the one place values cross between JSON and
//! Postgres. Mirrors `src/server/lib/postgres/client.ts`, including how the
//! Bun driver puts each kind of value on the wire, because that decides which
//! statements Postgres accepts:
//!
//! - a JS number is sent *typed* (`int4`, `int8` past 32 bits, `float8` when
//!   fractional or past 2^53) and a boolean as `bool`, so `WHERE text_col = 5`
//!   fails with "operator does not exist" on both servers alike;
//! - strings and `null` are sent untyped and Postgres infers the type;
//! - an array or object is sent untyped too, written as JSON for a json/jsonb
//!   parameter, as an array literal for an array parameter, and as
//!   `String(value)` (an object as JSON) for anything else.
//!
//! Results come back the way the TypeScript adapter converts them: `NUMERIC`
//! and `BIGINT` as floats, `DATE` as `YYYY-MM-DD`, `TIMESTAMPTZ` as an ISO
//! string with milliseconds and `Z`, json parsed.

use std::error::Error as StdError;
use std::fmt;
use std::sync::OnceLock;
use std::time::Duration;

use async_trait::async_trait;
use bytes::{BufMut, BytesMut};
use deadpool_postgres::{Manager, ManagerConfig, Object, Pool as DeadPool, RecyclingMethod};
use fallible_iterator::FallibleIterator;
use futures::{pin_mut, TryStreamExt};
use postgres_types::{Format, FromSql, IsNull, Kind, ToSql, Type};
use tokio_postgres::NoTls;

use crate::js::{self, Json, JsDate, Obj};
use crate::server::logger;

pub struct QueryResult {
    pub rows: Vec<Obj>,
    pub row_count: Option<u64>,
}

/// A failed statement. `code` is the SQLSTATE when Postgres reported one.
#[derive(Debug, Clone)]
pub struct DbError {
    pub code: Option<String>,
    pub message: String,
}

impl fmt::Display for DbError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}", self.message)
    }
}

impl StdError for DbError {}

impl From<tokio_postgres::Error> for DbError {
    fn from(error: tokio_postgres::Error) -> Self {
        match error.as_db_error() {
            Some(db) => DbError { code: Some(db.code().code().to_string()), message: db.message().to_string() },
            None => DbError { code: None, message: error.to_string() },
        }
    }
}

/// The SQLSTATE of a database error anywhere in `error`'s chain.
pub fn sqlstate(error: &anyhow::Error) -> Option<String> {
    error.downcast_ref::<DbError>().and_then(|e| e.code.clone())
}

/// Anything that can run a parameterized query: the pool or a reserved client.
#[async_trait]
pub trait Executor: Send + Sync {
    async fn query(&self, text: &str, values: &[Json]) -> anyhow::Result<QueryResult>;
}

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------

const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// The type the Bun driver declares for a value in `Parse`; `UNKNOWN` leaves it to Postgres.
fn declared_type(value: &Json) -> Type {
    match value {
        Json::Bool(_) => Type::BOOL,
        Json::Number(n) => match n.as_i64() {
            Some(i) if i32::try_from(i).is_ok() => Type::INT4,
            Some(i) if i.abs() <= MAX_SAFE_INTEGER => Type::INT8,
            _ => Type::FLOAT8,
        },
        _ => Type::UNKNOWN,
    }
}

fn quote_array_element(out: &mut String, text: &str) {
    out.push('"');
    for ch in text.chars() {
        if ch == '"' || ch == '\\' {
            out.push('\\');
        }
        out.push(ch);
    }
    out.push('"');
}

fn write_array_literal(out: &mut String, items: &[Json]) {
    out.push('{');
    for (i, item) in items.iter().enumerate() {
        if i > 0 {
            out.push(',');
        }
        match item {
            Json::Null => out.push_str("NULL"),
            Json::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
            Json::Number(n) => out.push_str(&js::number_to_string(n.as_f64().unwrap_or(f64::NAN))),
            Json::String(s) => quote_array_element(out, s),
            Json::Array(nested) => write_array_literal(out, nested),
            Json::Object(_) => quote_array_element(out, &js::json_stringify(item)),
        }
    }
    out.push('}');
}

#[derive(Debug)]
struct Param<'a>(&'a Json);

impl ToSql for Param<'_> {
    fn to_sql(&self, ty: &Type, out: &mut BytesMut) -> Result<IsNull, Box<dyn StdError + Sync + Send>> {
        match self.0 {
            Json::Null => return Ok(IsNull::Yes),
            Json::Bool(b) => out.put_u8(*b as u8),
            Json::Number(n) => {
                let as_float = n.as_f64().unwrap_or(f64::NAN);
                if *ty == Type::INT4 {
                    out.put_i32(n.as_i64().unwrap_or(0) as i32);
                } else if *ty == Type::INT8 {
                    out.put_i64(n.as_i64().unwrap_or(0));
                } else {
                    out.put_f64(as_float);
                }
            }
            Json::String(s) => out.put_slice(s.as_bytes()),
            Json::Array(items) => {
                let text = if matches!(*ty, Type::JSON | Type::JSONB) {
                    js::json_stringify(self.0)
                } else if matches!(ty.kind(), Kind::Array(_)) {
                    let mut literal = String::new();
                    write_array_literal(&mut literal, items);
                    literal
                } else {
                    js::to_js_string(self.0)
                };
                out.put_slice(text.as_bytes());
            }
            Json::Object(_) => out.put_slice(js::json_stringify(self.0).as_bytes()),
        }
        Ok(IsNull::No)
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }

    fn encode_format(&self, _ty: &Type) -> Format {
        match self.0 {
            Json::Bool(_) | Json::Number(_) => Format::Binary,
            _ => Format::Text,
        }
    }

    fn to_sql_checked(&self, ty: &Type, out: &mut BytesMut) -> Result<IsNull, Box<dyn StdError + Sync + Send>> {
        self.to_sql(ty, out)
    }
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/// A `NUMERIC` in binary form as its decimal text.
fn numeric_to_string(raw: &[u8]) -> Option<String> {
    if raw.len() < 8 {
        return None;
    }
    let read = |at: usize| i16::from_be_bytes([raw[at], raw[at + 1]]);
    let ndigits = read(0) as usize;
    let weight = read(2) as i32;
    let sign = u16::from_be_bytes([raw[4], raw[5]]);
    let dscale = read(6).max(0) as usize;
    match sign {
        0xC000 => return Some("NaN".to_string()),
        0xD000 => return Some("Infinity".to_string()),
        0xF000 => return Some("-Infinity".to_string()),
        _ => {}
    }
    if raw.len() < 8 + ndigits * 2 {
        return None;
    }
    let groups: Vec<i16> = (0..ndigits).map(|i| read(8 + i * 2)).collect();
    let mut out = String::new();
    if sign == 0x4000 {
        out.push('-');
    }
    // Integer part: groups 0..=weight.
    if weight < 0 {
        out.push('0');
    } else {
        for position in 0..=(weight as usize) {
            let group = groups.get(position).copied().unwrap_or(0);
            if position == 0 {
                out.push_str(&group.to_string());
            } else {
                out.push_str(&format!("{:04}", group));
            }
        }
    }
    if dscale > 0 {
        out.push('.');
        let mut fraction = String::new();
        let mut position = weight + 1;
        while fraction.len() < dscale {
            let group = if position < 0 { 0 } else { groups.get(position as usize).copied().unwrap_or(0) };
            fraction.push_str(&format!("{:04}", group));
            position += 1;
        }
        fraction.truncate(dscale);
        out.push_str(&fraction);
    }
    Some(out)
}

const PG_EPOCH_UNIX_MS: f64 = 946_684_800_000.0;
const PG_EPOCH_DAYS: i64 = 10_957;

fn date_to_string(days_since_2000: i32) -> Json {
    let date = JsDate::from_ms((days_since_2000 as i64 + PG_EPOCH_DAYS) as f64 * 86_400_000.0);
    match date.to_iso_string() {
        Some(iso) => Json::String(iso[..iso.find('T').unwrap_or(10)].to_string()),
        None => Json::Null,
    }
}

fn timestamp_to_iso(micros_since_2000: i64) -> Json {
    if micros_since_2000 == i64::MAX || micros_since_2000 == i64::MIN {
        return Json::Null;
    }
    // A JS Date holds whole milliseconds: the driver drops the microseconds.
    let ms = (micros_since_2000 as f64 / 1000.0 + PG_EPOCH_UNIX_MS).trunc();
    JsDate::from_ms(ms).to_json()
}

fn decode_value(ty: &Type, raw: &[u8]) -> Json {
    let be_i16 = || raw.get(..2).map(|b| i16::from_be_bytes([b[0], b[1]]));
    let be_i32 = || raw.get(..4).map(|b| i32::from_be_bytes([b[0], b[1], b[2], b[3]]));
    let be_i64 = || raw.get(..8).map(|b| i64::from_be_bytes(b.try_into().unwrap_or([0; 8])));
    let text = || Json::String(String::from_utf8_lossy(raw).into_owned());
    match *ty {
        Type::BOOL => Json::Bool(raw.first().map(|b| *b != 0).unwrap_or(false)),
        Type::INT2 => be_i16().map(|v| js::num(v as f64)).unwrap_or(Json::Null),
        Type::INT4 | Type::OID => be_i32().map(|v| js::num(v as f64)).unwrap_or(Json::Null),
        // The TypeScript adapter runs `parseFloat` over BIGINT and NUMERIC text.
        Type::INT8 => be_i64().map(|v| js::num(v as f64)).unwrap_or(Json::Null),
        Type::NUMERIC => numeric_to_string(raw).map(|s| js::num(js::parse_float(&s))).unwrap_or(Json::Null),
        Type::FLOAT4 => be_i32()
            .map(|bits| f32::from_bits(bits as u32))
            .map(|v| js::num(v.to_string().parse::<f64>().unwrap_or(f64::NAN)))
            .unwrap_or(Json::Null),
        Type::FLOAT8 => be_i64().map(|bits| js::num(f64::from_bits(bits as u64))).unwrap_or(Json::Null),
        Type::DATE => be_i32().map(date_to_string).unwrap_or(Json::Null),
        Type::TIMESTAMPTZ | Type::TIMESTAMP => be_i64().map(timestamp_to_iso).unwrap_or(Json::Null),
        Type::JSON => js::json_parse(&String::from_utf8_lossy(raw)).unwrap_or(Json::Null),
        Type::JSONB => js::json_parse(&String::from_utf8_lossy(raw.get(1..).unwrap_or(&[]))).unwrap_or(Json::Null),
        Type::UUID => uuid::Uuid::from_slice(raw).map(|u| Json::String(u.hyphenated().to_string())).unwrap_or(Json::Null),
        _ => match ty.kind() {
            Kind::Array(element) => decode_array(element, raw),
            _ => text(),
        },
    }
}

fn decode_array(element: &Type, raw: &[u8]) -> Json {
    let Ok(array) = postgres_protocol::types::array_from_sql(raw) else { return Json::Null };
    let mut dimensions: Vec<usize> = Vec::new();
    let mut dimension_iter = array.dimensions();
    loop {
        match dimension_iter.next() {
            Ok(Some(dimension)) => dimensions.push(dimension.len as usize),
            Ok(None) => break,
            Err(_) => return Json::Null,
        }
    }
    let mut flat: Vec<Json> = Vec::new();
    let mut value_iter = array.values();
    loop {
        match value_iter.next() {
            Ok(Some(value)) => flat.push(value.map(|bytes| decode_value(element, bytes)).unwrap_or(Json::Null)),
            Ok(None) => break,
            Err(_) => return Json::Null,
        }
    }
    fn nest(flat: &mut std::vec::IntoIter<Json>, dimensions: &[usize]) -> Json {
        match dimensions {
            [] => Json::Array(Vec::new()),
            [last] => Json::Array(flat.take(*last).collect()),
            [first, rest @ ..] => Json::Array((0..*first).map(|_| nest(flat, rest)).collect()),
        }
    }
    nest(&mut flat.into_iter(), &dimensions)
}

/// A column value decoded to JSON whatever its type.
struct Cell(Json);

impl<'a> FromSql<'a> for Cell {
    fn from_sql(ty: &Type, raw: &'a [u8]) -> Result<Self, Box<dyn StdError + Sync + Send>> {
        Ok(Cell(decode_value(ty, raw)))
    }

    fn from_sql_null(_ty: &Type) -> Result<Self, Box<dyn StdError + Sync + Send>> {
        Ok(Cell(Json::Null))
    }

    fn accepts(_ty: &Type) -> bool {
        true
    }
}

async fn run(client: &tokio_postgres::Client, text: &str, values: &[Json]) -> Result<QueryResult, DbError> {
    let types: Vec<Type> = values.iter().map(declared_type).collect();
    let statement = client.prepare_typed(text, &types).await?;
    let params: Vec<Param> = values.iter().map(Param).collect();
    let stream = client.query_raw(&statement, params.iter().map(|p| p as &(dyn ToSql + Sync))).await?;
    pin_mut!(stream);
    let mut rows = Vec::new();
    while let Some(row) = stream.try_next().await? {
        let mut object = Obj::new();
        for (index, column) in row.columns().iter().enumerate() {
            let value = row.try_get::<_, Cell>(index).map(|cell| cell.0).unwrap_or(Json::Null);
            object.insert(column.name().to_string(), value);
        }
        rows.push(object);
    }
    Ok(QueryResult { rows, row_count: stream.rows_affected() })
}

// ---------------------------------------------------------------------------
// Pool
// ---------------------------------------------------------------------------

static POOL: OnceLock<DeadPool> = OnceLock::new();

fn env_or(name: &str, default: &str) -> String {
    std::env::var(name).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| default.to_string())
}

fn deadpool() -> &'static DeadPool {
    POOL.get_or_init(|| {
        let mut config = tokio_postgres::Config::new();
        config
            .host(env_or("POSTGRES_HOST", "localhost"))
            .port(env_or("POSTGRES_PORT", "5432").parse().unwrap_or(5432))
            .user(env_or("POSTGRES_USER", "postgres"))
            .dbname(env_or("POSTGRES_DATABASE", "budget"))
            .connect_timeout(Duration::from_secs(2));
        if let Ok(password) = std::env::var("POSTGRES_PASSWORD") {
            config.password(password);
        }
        let manager = Manager::from_config(config, NoTls, ManagerConfig { recycling_method: RecyclingMethod::Fast });
        // Same ceiling as the Bun server's pool.
        DeadPool::builder(manager).max_size(20).build().expect("the connection pool has valid settings")
    })
}

async fn checkout() -> anyhow::Result<Object> {
    deadpool().get().await.map_err(|error| {
        anyhow::Error::new(DbError { code: None, message: format!("Failed to connect to the database: {error}") })
    })
}

/// The pool: each query runs on whichever connection is free.
pub struct Pool;

pub static POOL_EXECUTOR: Pool = Pool;

/// The pool as an executor, for call sites that take `&dyn Executor`.
pub fn pool() -> &'static Pool {
    &POOL_EXECUTOR
}

#[async_trait]
impl Executor for Pool {
    async fn query(&self, text: &str, values: &[Json]) -> anyhow::Result<QueryResult> {
        let connection = checkout().await?;
        let result = run(&connection, text, values).await;
        if let Err(error) = &result {
            if error.code.is_none() && connection.is_closed() {
                logger::error("Database connection lost", None, Some(&anyhow::anyhow!(error.message.clone())));
            }
        }
        Ok(result?)
    }
}

impl Pool {
    /// Reserves one connection, for a transaction or a session-level lock.
    pub async fn connect(&self) -> anyhow::Result<Client> {
        Ok(Client { connection: checkout().await? })
    }

    /// Closes the pool; later queries fail.
    pub fn end(&self) {
        deadpool().close();
    }
}

/// A single connection reserved from the pool. Dropping it returns the connection.
pub struct Client {
    connection: Object,
}

#[async_trait]
impl Executor for Client {
    async fn query(&self, text: &str, values: &[Json]) -> anyhow::Result<QueryResult> {
        Ok(run(&self.connection, text, values).await?)
    }
}

/// `executor` when given, else the pool: the `client ?? pool` of the TypeScript.
pub fn or_pool<'a>(executor: Option<&'a dyn Executor>) -> &'a dyn Executor {
    executor.unwrap_or(&POOL_EXECUTOR)
}

/// Runs `work` inside `BEGIN … COMMIT` on a reserved connection, rolling back
/// when it fails.
///
/// ```ignore
/// with_transaction(|client| Box::pin(async move {
///     accounts::TABLE.update(/* … */, Some(client)).await?;
///     Ok(())
/// })).await?;
/// ```
pub async fn with_transaction<T, F>(work: F) -> anyhow::Result<T>
where
    T: Send,
    F: for<'c> FnOnce(&'c Client) -> futures::future::BoxFuture<'c, anyhow::Result<T>> + Send,
{
    let client = POOL_EXECUTOR.connect().await?;
    client.query("BEGIN", &[]).await?;
    match work(&client).await {
        Ok(value) => {
            client.query("COMMIT", &[]).await?;
            Ok(value)
        }
        Err(error) => {
            client.query("ROLLBACK", &[]).await?;
            Err(error)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn numeric(ndigits: i16, weight: i16, sign: u16, dscale: i16, groups: &[i16]) -> Vec<u8> {
        let mut raw = Vec::new();
        raw.extend(ndigits.to_be_bytes());
        raw.extend(weight.to_be_bytes());
        raw.extend(sign.to_be_bytes());
        raw.extend(dscale.to_be_bytes());
        for group in groups {
            raw.extend(group.to_be_bytes());
        }
        raw
    }

    #[test]
    fn decodes_numeric() {
        assert_eq!(numeric_to_string(&numeric(2, 0, 0, 2, &[1234, 5700])).unwrap(), "1234.57");
        assert_eq!(numeric_to_string(&numeric(1, -1, 0x4000, 3, &[500])).unwrap(), "-0.050");
        assert_eq!(numeric_to_string(&numeric(0, 0, 0, 2, &[])).unwrap(), "0.00");
        assert_eq!(numeric_to_string(&numeric(2, 1, 0, 0, &[12, 3456])).unwrap(), "123456");
        assert_eq!(numeric_to_string(&numeric(1, 1, 0, 0, &[12])).unwrap(), "120000");
        assert_eq!(numeric_to_string(&numeric(1, -2, 0, 6, &[1200])).unwrap(), "0.000012");
    }

    #[test]
    fn declares_types_like_the_bun_driver() {
        assert_eq!(declared_type(&serde_json::json!(5)), Type::INT4);
        assert_eq!(declared_type(&serde_json::json!(2147483648u64)), Type::INT8);
        assert_eq!(declared_type(&js::num(9007199254740992.0)), Type::FLOAT8);
        assert_eq!(declared_type(&serde_json::json!(1.5)), Type::FLOAT8);
        assert_eq!(declared_type(&serde_json::json!(true)), Type::BOOL);
        assert_eq!(declared_type(&serde_json::json!("x")), Type::UNKNOWN);
        assert_eq!(declared_type(&serde_json::json!(["a"])), Type::UNKNOWN);
    }

    #[test]
    fn writes_array_literals() {
        let mut out = String::new();
        write_array_literal(&mut out, &[serde_json::json!("a"), serde_json::json!("q\"u"), Json::Null, serde_json::json!(1)]);
        assert_eq!(out, r#"{"a","q\"u",NULL,1}"#);
    }
}
