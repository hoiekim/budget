//! `POST /client-error`: frontend error reports, forwarded to the alarm.
//! `src/server/routes/client-error.ts`.

use crate::js::{js_slice_start, Json};
use crate::server::alarm::send_alarm;
use crate::server::logger;
use crate::server::rate_limit::CLIENT_ERROR_RATE_LIMITER;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};

async fn post_client_error(ctx: &mut Ctx) -> HandlerResult {
    CLIENT_ERROR_RATE_LIMITER.consume(&ctx.req.ip, 1);

    // The body is absent without a JSON content type, when the JSON does not
    // parse, or for a literal null: the report still goes through.
    let field = |name: &str| -> Option<String> {
        match &ctx.req.body {
            Some(Json::Object(body)) => body.get(name).and_then(|v| v.as_str()).map(str::to_string),
            _ => None,
        }
    };
    let message = field("message").unwrap_or_else(|| "(no message)".to_string());
    let stack = field("stack").unwrap_or_default();
    let url = field("url").unwrap_or_default();

    logger::error("Client error reported", Some(&crate::ctx! { "url": url, "message": message }), None);

    let mut lines = Vec::new();
    if !url.is_empty() {
        lines.push(format!("**URL:** {url}"));
    }
    lines.push(format!("**Message:** {message}"));
    if !stack.is_empty() {
        lines.push(format!("```\n{}\n```", js_slice_start(&stack, 1000)));
    }

    // A dedicated cooldown bucket, so client report volume is not charged to
    // the server-side alarm sources.
    send_alarm("Client JS Error", &lines.join("\n"), Some("client-error"), false).await;

    Ok(ApiResponse::success().into())
}

pub fn routes() -> Vec<Route> {
    vec![crate::route!("POST", "/client-error", post_client_error)]
}
