//! Routes and what they exchange with the HTTP layer: `src/server/lib/route.ts`.

use std::collections::HashMap;

use bytes::Bytes;
use futures::future::BoxFuture;
use futures::stream::BoxStream;
use futures::StreamExt;
use indexmap::IndexMap;
use serde_json::json;
use tokio_util::sync::CancellationToken;

use crate::js::{json_stringify, Json, Obj};
use crate::server::alarm::send_alarm;
use crate::server::logger;
use crate::server::postgres::models::{MaskedUser, SessionAuth};

/// The body every API response carries: `{ status, body?, message? }`.
#[derive(Clone, Debug, PartialEq)]
pub struct ApiResponse {
    /// `"success"`, `"failed"` (a refusal the caller caused) or `"error"` (a server fault).
    pub status: &'static str,
    pub body: Option<Json>,
    pub message: Option<String>,
}

impl ApiResponse {
    pub fn success() -> Self {
        ApiResponse { status: "success", body: None, message: None }
    }

    pub fn success_with(body: Json) -> Self {
        ApiResponse { status: "success", body: Some(body), message: None }
    }

    pub fn failed(message: impl Into<String>) -> Self {
        ApiResponse { status: "failed", body: None, message: Some(message.into()) }
    }

    pub fn error(message: impl Into<String>) -> Self {
        ApiResponse { status: "error", body: None, message: Some(message.into()) }
    }

    pub fn with_body(mut self, body: Json) -> Self {
        self.body = Some(body);
        self
    }

    pub fn with_message(mut self, message: impl Into<String>) -> Self {
        self.message = Some(message.into());
        self
    }

    pub fn to_json(&self) -> Json {
        let mut object = Obj::new();
        object.insert("status".into(), json!(self.status));
        if let Some(body) = &self.body {
            object.insert("body".into(), body.clone());
        }
        if let Some(message) = &self.message {
            object.insert("message".into(), json!(message));
        }
        Json::Object(object)
    }
}

/// One node of a JSON document that is serialized while it is sent.
pub enum StreamNode {
    /// Written whole.
    Value(Json),
    /// An object whose members are written in order.
    Object(Vec<(String, StreamNode)>),
    /// A JSON array written one batch of rows at a time, so a large result is never held whole.
    Batches(BoxStream<'static, anyhow::Result<Vec<Json>>>),
}

/// A JSON response serialized while it is sent.
///
/// ```ignore
/// Ok(Reply::Stream(JsonStream::success(vec![
///     ("transactions".into(), StreamNode::Batches(search_transactions(&user))),
///     ("investmentTransactions".into(), StreamNode::Value(json!([]))),
/// ])))
/// ```
pub struct JsonStream {
    pub root: StreamNode,
}

impl JsonStream {
    /// `{ status: "success", body: { …members } }`.
    pub fn success(body: Vec<(String, StreamNode)>) -> Self {
        JsonStream {
            root: StreamNode::Object(vec![
                ("status".into(), StreamNode::Value(json!("success"))),
                ("body".into(), StreamNode::Object(body)),
            ]),
        }
    }

    /// The document as chunks of text; an error from a batch ends the stream with that error.
    pub fn into_chunks(self) -> BoxStream<'static, anyhow::Result<Bytes>> {
        fn chunks(node: StreamNode) -> BoxStream<'static, anyhow::Result<Bytes>> {
            match node {
                StreamNode::Value(value) => futures::stream::once(async move { Ok(Bytes::from(json_stringify(&value))) }).boxed(),
                StreamNode::Object(members) => {
                    let mut parts: Vec<BoxStream<'static, anyhow::Result<Bytes>>> = Vec::new();
                    parts.push(futures::stream::once(async { Ok(Bytes::from_static(b"{")) }).boxed());
                    for (index, (key, member)) in members.into_iter().enumerate() {
                        let prefix = format!("{}{}:", if index == 0 { "" } else { "," }, json_stringify(&json!(key)));
                        parts.push(futures::stream::once(async move { Ok(Bytes::from(prefix)) }).boxed());
                        parts.push(chunks(member));
                    }
                    parts.push(futures::stream::once(async { Ok(Bytes::from_static(b"}")) }).boxed());
                    futures::stream::iter(parts).flatten().boxed()
                }
                StreamNode::Batches(batches) => {
                    let open = futures::stream::once(async { Ok(Bytes::from_static(b"[")) });
                    let mut first = true;
                    let items = batches.filter_map(move |batch| {
                        let chunk = match batch {
                            Err(error) => Some(Err(error)),
                            Ok(rows) if rows.is_empty() => None,
                            Ok(rows) => {
                                let joined = rows.iter().map(json_stringify).collect::<Vec<_>>().join(",");
                                let text = if first { joined } else { format!(",{joined}") };
                                first = false;
                                Some(Ok(Bytes::from(text)))
                            }
                        };
                        async move { chunk }
                    });
                    let close = futures::stream::once(async { Ok(Bytes::from_static(b"]")) });
                    open.chain(items).chain(close).boxed()
                }
            }
        }
        // Nothing is sent after the first failure.
        let mut failed = false;
        chunks(self.root)
            .take_while(move |chunk| {
                let keep = !failed;
                if chunk.is_err() {
                    failed = true;
                }
                async move { keep }
            })
            .boxed()
    }
}

/// A response a route builds itself: a redirect, or a stream that stays open.
pub struct RawResponse {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: RawBody,
}

pub enum RawBody {
    Empty,
    /// Chunks sent as they arrive; the response ends when the stream does.
    Stream(BoxStream<'static, Bytes>),
}

/// What a route hands back.
pub enum Reply {
    Api(ApiResponse),
    /// Passed through as is: no session cookie, no change event.
    Raw(RawResponse),
    Stream(JsonStream),
    /// The handler returned nothing: the response has no body.
    None,
}

impl From<ApiResponse> for Reply {
    fn from(response: ApiResponse) -> Self {
        Reply::Api(response)
    }
}

/// A query parameter: its value, or every value when the name repeats.
#[derive(Clone, Debug, PartialEq)]
pub enum QueryValue {
    One(String),
    Many(Vec<String>),
}

impl QueryValue {
    pub fn to_json(&self) -> Json {
        match self {
            QueryValue::One(value) => json!(value),
            QueryValue::Many(values) => json!(values),
        }
    }
}

pub struct Request {
    pub method: String,
    /// The route path: the URL path without its `/api` prefix.
    pub path: String,
    /// The full request URL.
    pub url: String,
    /// Header values by lower-case name.
    pub headers: HashMap<String, String>,
    pub query: IndexMap<String, QueryValue>,
    /// The parsed JSON body; `None` when there is none or it did not parse.
    pub body: Option<Json>,
    pub raw_body: Option<String>,
    pub ip: String,
    /// Cancelled when the client disconnects.
    pub disconnected: CancellationToken,
}

impl Request {
    /// The query as the object the TypeScript handlers read.
    pub fn query_json(&self) -> Obj {
        self.query.iter().map(|(key, value)| (key.clone(), value.to_json())).collect()
    }
}

/// The session of one request. `user` is who is signed in.
pub struct Session {
    pub id: String,
    pub user: Option<MaskedUser>,
    /// Set on a session started by single sign-on.
    pub auth: Option<SessionAuth>,
    pub destroyed: bool,
    /// True when the session's row was read from the store on this request.
    pub stored: bool,
    /// True when the request authenticated with an API key: no cookie is written back.
    pub bearer: bool,
}

impl Session {
    /// Replaces the session id and forgets who was signed in, deleting the old row.
    pub async fn regenerate(&mut self) {
        let old_id = std::mem::replace(&mut self.id, uuid::Uuid::new_v4().to_string());
        self.user = None;
        self.auth = None;
        self.stored = false;
        let _ = crate::server::session::session_store().destroy(&old_id).await;
    }

    /// Ends the session: its row is deleted and its cookie cleared.
    pub async fn destroy(&mut self) {
        self.destroyed = true;
        if let Err(error) = crate::server::session::session_store().destroy(&self.id).await {
            logger::error("Failed to destroy session", None, Some(&error));
        }
    }
}

/// What a handler works with: the request, the session, and the response status.
pub struct Ctx {
    pub req: Request,
    pub session: Session,
    /// The HTTP status of the response; 200 unless the handler sets it.
    pub status: u16,
}

impl Ctx {
    /// The signed-in user. The HTTP layer has already refused anonymous
    /// callers on every route that is not public.
    pub fn user(&self) -> Option<&MaskedUser> {
        self.session.user.as_ref()
    }
}

pub type HandlerResult = anyhow::Result<Reply>;
pub type Handler = for<'a> fn(&'a mut Ctx) -> BoxFuture<'a, HandlerResult>;

pub struct Route {
    pub method: &'static str,
    pub path: &'static str,
    pub handler: Handler,
    /// A route with a scope also accepts an API key whose scopes include it.
    pub required_scope: Option<&'static str>,
}

impl Route {
    /// Runs the handler; a failure is logged, alarmed and answered 500.
    pub async fn execute(&self, ctx: &mut Ctx) -> Reply {
        match (self.handler)(ctx).await {
            Ok(reply) => reply,
            Err(error) => {
                logger::error(
                    "Route handler error",
                    Some(&crate::ctx! { "method": self.method, "path": self.path }),
                    Some(&error),
                );
                let title = format!("Route Error: {} {}", self.method, self.path);
                let detail = format!("**Error:** {}", error);
                tokio::spawn(async move { send_alarm(&title, &detail, None, false).await });
                ctx.status = 500;
                Reply::Api(ApiResponse::error("Internal server error"))
            }
        }
    }
}

/// Declares a route from an `async fn(&mut Ctx) -> HandlerResult`.
///
/// ```ignore
/// pub fn routes() -> Vec<Route> {
///     vec![
///         route!("GET", "/health", get_health),
///         route!("POST", "/suggest-category", post_suggest_category, scope = "transactions:suggest"),
///     ]
/// }
/// ```
#[macro_export]
macro_rules! route {
    ($method:literal, $path:literal, $handler:path) => {
        $crate::route!(@build $method, $path, $handler, None)
    };
    ($method:literal, $path:literal, $handler:path, scope = $scope:literal) => {
        $crate::route!(@build $method, $path, $handler, Some($scope))
    };
    (@build $method:literal, $path:literal, $handler:path, $scope:expr) => {{
        fn boxed<'a>(
            ctx: &'a mut $crate::server::route::Ctx,
        ) -> ::futures::future::BoxFuture<'a, $crate::server::route::HandlerResult> {
            ::std::boxed::Box::pin($handler(ctx))
        }
        $crate::server::route::Route { method: $method, path: $path, handler: boxed, required_scope: $scope }
    }};
}
