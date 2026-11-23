//! One route shape per budget / category / section operation, parameterized
//! by the repository function and the fields that differ per entity:
//! `src/server/lib/entity-routes.ts`.
//!
//! The three entities share an auth guard, an id validated as a UUID, and the
//! same failure answers. A rule that holds for one entity only stays an
//! `extra_checks` function instead of a shared branch.

use futures::future::BoxFuture;
use serde_json::json;

use crate::js::{Json, Obj};
use crate::server::logger;
use crate::server::postgres::models::MaskedUser;
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{
    require_body_object, require_query_string, require_string_field, validate_fields, validation_error, FieldSpec, FieldType,
};

fn unauthenticated() -> ApiResponse {
    ApiResponse::failed("Request user is not authenticated.")
}

/// `(user, id) -> deleted`.
pub type DeleteFn = for<'a> fn(&'a MaskedUser, &'a str) -> BoxFuture<'a, anyhow::Result<bool>>;
/// `(user, data) -> created row as JSON, or None`.
pub type CreateFn = for<'a> fn(&'a MaskedUser, &'a Obj) -> BoxFuture<'a, anyhow::Result<Option<Json>>>;
/// `(user, id, data) -> updated`.
pub type UpdateFn = for<'a> fn(&'a MaskedUser, &'a str, &'a Obj) -> BoxFuture<'a, anyhow::Result<bool>>;

/// `DELETE /<entity>?id=` — auth, an `id` query param validated as a UUID,
/// the repository delete, success. A delete that matches no row still answers success.
pub fn make_delete_entity_route(path: &'static str, delete_fn: DeleteFn) -> Route {
    Route {
        method: "DELETE",
        path,
        required_scope: None,
        handler: Box::new(move |ctx: &mut Ctx| -> BoxFuture<'_, HandlerResult> {
            Box::pin(async move {
                let Some(user) = ctx.session.user.clone() else { return Ok(unauthenticated().into()) };
                let id = match require_query_string(&ctx.req, "id") {
                    Ok(id) => id,
                    Err(message) => return Ok(validation_error(message).into()),
                };
                // `id` becomes a UUID-column predicate: a malformed value is
                // refused here instead of failing inside Postgres.
                if let Err(message) = validate_fields(&ctx.req.query_json(), &[FieldSpec::new("id", FieldType::Uuid).required()]) {
                    return Ok(validation_error(message).into());
                }
                delete_fn(&user, &id).await?;
                Ok(ApiResponse::success().into())
            })
        }),
    }
}

pub struct GetNewEntityOptions {
    /// The column the `parent` query parameter fills in; `None` for an entity with no parent.
    pub parent_field: Option<&'static str>,
    /// The key the created row is answered under.
    pub body_key: &'static str,
    pub failure_message: &'static str,
}

/// `GET /new-<entity>[?parent=]` — auth, a `parent` query param validated as
/// a UUID where the entity has one, the repository create, and the created row
/// under `body_key`. A `None` create (a foreign or missing parent) answers `failure_message`.
pub fn make_get_new_entity_route(path: &'static str, create_fn: CreateFn, options: GetNewEntityOptions) -> Route {
    Route {
        method: "GET",
        path,
        required_scope: None,
        handler: Box::new(move |ctx: &mut Ctx| -> BoxFuture<'_, HandlerResult> {
            let (parent_field, body_key, failure_message) = (options.parent_field, options.body_key, options.failure_message);
            Box::pin(async move {
                let Some(user) = ctx.session.user.clone() else { return Ok(unauthenticated().into()) };
                let mut data = Obj::new();
                if let Some(parent_field) = parent_field {
                    let parent = match require_query_string(&ctx.req, "parent") {
                        Ok(parent) => parent,
                        Err(message) => return Ok(validation_error(message).into()),
                    };
                    let mut shape = Obj::new();
                    shape.insert("parent".into(), json!(parent));
                    if let Err(message) = validate_fields(&shape, &[FieldSpec::new("parent", FieldType::Uuid)]) {
                        return Ok(validation_error(message).into());
                    }
                    data.insert(parent_field.to_string(), json!(parent));
                }
                match create_fn(&user, &data).await? {
                    Some(created) => {
                        let mut body = Obj::new();
                        body.insert(body_key.to_string(), created);
                        Ok(ApiResponse::success_with(Json::Object(body)).into())
                    }
                    None => Ok(ApiResponse::failed(failure_message).into()),
                }
            })
        }),
    }
}

/// A per-entity rule the shared skeleton cannot express. It runs after field
/// validation and before the repository call; `Some` answers with that failure.
pub type ExtraCheck = fn(&Obj) -> Option<ApiResponse>;

pub struct UpdateEntityOptions {
    pub id_field: &'static str,
    pub field_spec: &'static [FieldSpec],
    /// "budget" — the noun in the `Failed to update <entity>` log line.
    pub entity_label: &'static str,
    /// "budgetId" — the logger context key for the id.
    pub id_log_key: &'static str,
    pub extra_checks: Option<ExtraCheck>,
}

/// `POST /<entity>` — auth, a body object, the id field as a string, the
/// field validation, the per-entity extra checks, then the repository update.
/// A repository failure is logged with the id and passed on to the route's alarm path.
pub fn make_update_entity_route(path: &'static str, update_fn: UpdateFn, options: UpdateEntityOptions) -> Route {
    Route {
        method: "POST",
        path,
        required_scope: None,
        handler: Box::new(move |ctx: &mut Ctx| -> BoxFuture<'_, HandlerResult> {
            let UpdateEntityOptions { id_field, field_spec, entity_label, id_log_key, extra_checks } = options_ref(&options);
            Box::pin(async move {
                let Some(user) = ctx.session.user.clone() else { return Ok(unauthenticated().into()) };
                let body = match require_body_object(&ctx.req) {
                    Ok(body) => body.clone(),
                    Err(message) => return Ok(validation_error(message).into()),
                };
                let id = match require_string_field(&body, id_field) {
                    Ok(id) => id,
                    Err(message) => return Ok(validation_error(message).into()),
                };
                if let Err(message) = validate_fields(&body, field_spec) {
                    return Ok(validation_error(message).into());
                }
                let mut data = body;
                data.shift_remove(id_field);

                if let Some(failure) = extra_checks.and_then(|check| check(&data)) {
                    return Ok(failure.into());
                }

                match update_fn(&user, &id, &data).await {
                    Ok(_) => Ok(ApiResponse::success().into()),
                    Err(error) => {
                        let mut context = Obj::new();
                        context.insert(id_log_key.to_string(), json!(id));
                        logger::error(&format!("Failed to update {entity_label}"), Some(&context), Some(&error));
                        Err(error)
                    }
                }
            })
        }),
    }
}

fn options_ref(options: &UpdateEntityOptions) -> UpdateEntityOptions {
    UpdateEntityOptions {
        id_field: options.id_field,
        field_spec: options.field_spec,
        entity_label: options.entity_label,
        id_log_key: options.id_log_key,
        extra_checks: options.extra_checks,
    }
}
