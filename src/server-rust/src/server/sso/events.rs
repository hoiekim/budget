//! What a security event from the identity provider does here:
//! `src/server/lib/sso/events.ts`.

use crate::js::Json;
use crate::server::auth_client::AuthEvent;
use crate::server::postgres::repositories::api_keys::{list_api_keys, revoke_api_key};
use crate::server::postgres::repositories::session::{delete_sessions_by_auth_sid, delete_sessions_by_user_id};
use crate::server::postgres::repositories::users::get_user_by_auth_sub;
use crate::server::realtime::{close_subscribers, Which};

/// Event types after which a person may no longer use the app at all.
const ACCESS_ENDING_EVENTS: [&str; 2] = ["user.disabled", "user.deleted"];

/// Applies a verified security event. The identity provider delivers each
/// event at least once, and every branch here is idempotent — deleting what is
/// already gone deletes nothing — so no record of handled `jti`s is kept.
///
/// Budget has no roles: any role is access, so `access.changed` matters only
/// when access is removed. Ending access deletes the account's sessions and
/// revokes the API keys budget itself issued to it, since those never ask the
/// provider; its password no longer signs in while single sign-on is on (see
/// `post_login`). Keys the provider issued stop at the provider. Giving access
/// back doesn't restore revoked keys. `user.deleted` keeps the user's data.
/// `credential.revoked` needs nothing here: `read_event` already dropped the
/// key's cached introspection answer, and no connection is held by a key.
/// Other copies of the app notice deleted sessions through their own 60-second
/// re-check of each open event stream.
pub async fn handle_auth_event(event: &AuthEvent) -> anyhow::Result<()> {
    if let ("session.ended", Some(sid)) = (event.event_type.as_str(), &event.sid) {
        delete_sessions_by_auth_sid(sid).await?;
        close_subscribers(Which::AuthSid(sid));
        return Ok(());
    }

    let ends_access = ACCESS_ENDING_EVENTS.contains(&event.event_type.as_str())
        || (event.event_type == "access.changed" && event.role == Some(None));
    let (true, Some(sub)) = (ends_access, &event.sub) else { return Ok(()) };

    let Some(user) = get_user_by_auth_sub(sub).await? else { return Ok(()) };
    delete_sessions_by_user_id(&user.user_id).await?;
    close_subscribers(Which::UserId(&user.user_id));
    for key in list_api_keys(&user.user_id).await? {
        if let Some(key_id) = key.get("key_id").and_then(Json::as_str) {
            revoke_api_key(key_id, &user.user_id).await?;
        }
    }
    Ok(())
}
