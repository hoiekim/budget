//! Data sharing between users: `src/server/routes/sharing/`.

use serde_json::json;

use crate::common::constants::{SHARING_INVITATIONS, SHARING_MEMBERS};
use crate::js::Obj;
use crate::server::postgres::repositories::sharing::{
    accept_sharing_invitation, delete_sharing_invitation, get_sharing, invite_to_share, remove_sharing_member, SharingOutcome,
};
use crate::server::realtime::{emit_to_user, origin_tab_payload, spawn_emit_to_sharing_group};
use crate::server::route::{ApiResponse, Ctx, HandlerResult, Route};
use crate::server::validation::{
    js_trim, require_body_object, require_query_string, require_string_field, validate_fields, validation_error, FieldSpec,
    FieldType,
};

fn unauthenticated() -> HandlerResult {
    Ok(ApiResponse::failed("Request user is not authenticated.").into())
}

/// `GET /sharing`: who the caller shares data with, and the open invitations.
async fn get_sharing_route(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else { return unauthenticated() };
    Ok(ApiResponse::success_with(get_sharing(&user).await?).into())
}

/// `POST /sharing/invitation { username }` invites that user to share data with the caller's group.
async fn post_sharing_invitation(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else { return unauthenticated() };
    let body = match require_body_object(&ctx.req) {
        Ok(body) => body,
        Err(message) => return Ok(validation_error(message).into()),
    };
    let username = match require_string_field(body, "username") {
        Ok(username) => username,
        Err(message) => return Ok(validation_error(message).into()),
    };

    let invitation = match invite_to_share(&user, js_trim(&username)).await? {
        SharingOutcome::Shared(invitation) => invitation,
        SharingOutcome::Refused(message) => return Ok(ApiResponse::failed(message).into()),
    };

    let payload = origin_tab_payload(&ctx.req.headers);
    spawn_emit_to_sharing_group(&user.user_id, SHARING_INVITATIONS, payload.clone());
    emit_to_user(&invitation.invitee.user_id, SHARING_INVITATIONS, payload.as_deref());
    Ok(ApiResponse::success_with(json!({ "invitation": invitation.to_json() })).into())
}

/// `DELETE /sharing/invitation?id=` declines an invitation sent to the caller,
/// or withdraws one sent by the caller or someone sharing data with them.
async fn delete_sharing_invitation_route(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else { return unauthenticated() };
    let id = match require_query_string(&ctx.req, "id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };
    if let Err(message) = validate_fields(&ctx.req.query_json(), &[FieldSpec::new("id", FieldType::Uuid).required()]) {
        return Ok(validation_error(message).into());
    }

    let Some(affected_user_ids) = delete_sharing_invitation(&user, &id).await? else {
        return Ok(ApiResponse::failed("That invitation is no longer open.").into());
    };

    let payload = origin_tab_payload(&ctx.req.headers);
    for user_id in affected_user_ids {
        spawn_emit_to_sharing_group(&user_id, SHARING_INVITATIONS, payload.clone());
    }
    Ok(ApiResponse::success().into())
}

/// `POST /sharing/member { invitation_id }` accepts an invitation sent to the
/// caller, who joins the inviter's sharing group.
async fn post_sharing_member(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else { return unauthenticated() };
    let body: Obj = match require_body_object(&ctx.req) {
        Ok(body) => body.clone(),
        Err(message) => return Ok(validation_error(message).into()),
    };
    let invitation_id = match require_string_field(&body, "invitation_id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };
    if let Err(message) = validate_fields(&body, &[FieldSpec::new("invitation_id", FieldType::Uuid).required()]) {
        return Ok(validation_error(message).into());
    }

    let affected_user_ids = match accept_sharing_invitation(&user, &invitation_id).await? {
        SharingOutcome::Shared(user_ids) => user_ids,
        SharingOutcome::Refused(message) => return Ok(ApiResponse::failed(message).into()),
    };

    let payload = origin_tab_payload(&ctx.req.headers);
    for user_id in affected_user_ids {
        emit_to_user(&user_id, SHARING_MEMBERS, payload.as_deref());
    }
    Ok(ApiResponse::success().into())
}

/// `DELETE /sharing/member?user_id=` takes a user out of the caller's sharing
/// group: the caller, to stop sharing, or anyone else in the group.
async fn delete_sharing_member(ctx: &mut Ctx) -> HandlerResult {
    let Some(user) = ctx.user().cloned() else { return unauthenticated() };
    let member_user_id = match require_query_string(&ctx.req, "user_id") {
        Ok(id) => id,
        Err(message) => return Ok(validation_error(message).into()),
    };
    if let Err(message) = validate_fields(&ctx.req.query_json(), &[FieldSpec::new("user_id", FieldType::Uuid).required()]) {
        return Ok(validation_error(message).into());
    }

    let affected_user_ids = match remove_sharing_member(&user, &member_user_id).await? {
        SharingOutcome::Shared(user_ids) => user_ids,
        SharingOutcome::Refused(message) => return Ok(ApiResponse::failed(message).into()),
    };

    let payload = origin_tab_payload(&ctx.req.headers);
    for user_id in affected_user_ids {
        emit_to_user(&user_id, SHARING_MEMBERS, payload.as_deref());
    }
    Ok(ApiResponse::success().into())
}

pub fn routes() -> Vec<Route> {
    vec![
        crate::route!("GET", "/sharing", get_sharing_route),
        crate::route!("POST", "/sharing/invitation", post_sharing_invitation),
        crate::route!("DELETE", "/sharing/invitation", delete_sharing_invitation_route),
        crate::route!("POST", "/sharing/member", post_sharing_member),
        crate::route!("DELETE", "/sharing/member", delete_sharing_member),
    ]
}
