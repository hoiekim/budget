//! Which local user a single sign-on stands for: `src/server/lib/sso/users.ts`.

use indexmap::IndexMap;

use crate::common::constants::sso_error;
use crate::js::Json;
use crate::server::postgres::models::MaskedUser;
use crate::server::postgres::repositories::users::{create_sso_user, get_user_by_auth_sub, link_user_by_email, link_user_to_auth_sub};
use crate::server::validation::js_trim;

/// The user, or the `sso_error` the sign-in page shows instead.
pub type SsoUserResult = Result<MaskedUser, &'static str>;

/// The local user a single sign-on stands for: the one already linked to the
/// token's `sub`, else the account `link_users` maps the token's username to
/// if it is not linked yet, else the unlinked account with the ID token's
/// email in any letter case, else a new user named after the token's
/// username, keeping that email when no other account has it.
///
/// The email is matched whether or not the provider says it is verified: the
/// operator filled in the accounts' addresses, and the auth identity service
/// sets an address a person chose only once they confirm it (an unconfirmed
/// one was entered by its administrator), so a match is as trustworthy as
/// `AUTH_LINK_USERS`. A provider that lets people claim addresses they have
/// not confirmed must not be used this way.
///
/// A username taken by an unlinked local account, the seeded `admin` and
/// `demo` included, is refused rather than guessed at: `AUTH_LINK_USERS` or
/// the account's email is how an operator says which account is whose.
pub async fn find_or_create_sso_user(
    sub: &str,
    username: &str,
    email: Option<&Json>,
    link_users: &IndexMap<String, String>,
) -> anyhow::Result<SsoUserResult> {
    if let Some(linked) = get_user_by_auth_sub(sub).await? {
        return Ok(Ok(linked));
    }

    if let Some(local_account) = link_users.get(username) {
        if let Some(user) = link_user_to_auth_sub(local_account, sub).await? {
            return Ok(Ok(user));
        }
    }

    let email = email.and_then(Json::as_str).map(js_trim).unwrap_or("");
    if !email.is_empty() {
        if let Some(user) = link_user_by_email(email, sub).await? {
            return Ok(Ok(user));
        }
    }

    // An address another account holds, a deleted one included, would break
    // the unique index on emails: the user is created without it instead.
    let mut created = None;
    if !email.is_empty() {
        created = create_sso_user(username, sub, Some(email)).await?;
    }
    if created.is_none() {
        created = create_sso_user(username, sub, None).await?;
    }
    if let Some(created) = created {
        return Ok(Ok(created));
    }

    // A concurrent sign-in by the same person may have linked or created the
    // user between the read above and these writes.
    Ok(get_user_by_auth_sub(sub).await?.ok_or(sso_error::ACCOUNT_EXISTS))
}
