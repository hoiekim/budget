//! `GET /health`: `src/server/routes/health.ts`.

use serde_json::json;

use crate::js::JsDate;
use crate::server::postgres::client::{pool, Executor};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};

async fn get_health(ctx: &mut Ctx) -> HandlerResult {
    let healthy = pool().query("SELECT 1", &[]).await.is_ok();
    if !healthy {
        ctx.status = 503;
    }
    let body = json!({
        "healthy": healthy,
        "checks": { "database": if healthy { "ok" } else { "unhealthy" } },
        "timestamp": JsDate::now_ms() as i64,
    });
    Ok(ApiResponse { status: if healthy { "success" } else { "error" }, body: Some(body), message: None }.into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("GET", "/health", get_health)]
}
