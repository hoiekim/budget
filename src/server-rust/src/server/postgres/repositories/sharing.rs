//! Data sharing between users: `src/server/lib/postgres/repositories/sharing.ts`.
//!
//! The TypeScript's `SharingResult<T>` (`{ ok: true, …T } | { ok: false, error }`)
//! is [`SharingOutcome<T>`]: `Shared(T)` or `Refused(message)`.

use std::collections::HashMap;

use serde_json::json;

use crate::common::constants::DEMO_USERNAME;
use crate::filters;
use crate::js::{truthy_opt, Json, JsDate, Obj};
use crate::server::postgres::client::{or_pool, pool, with_transaction, Executor};
use crate::server::postgres::database::{SearchFilters, SHARING_MEMBERSHIP_LOCK_KEY};
use crate::server::postgres::models::base::{str_of, value_of};
use crate::server::postgres::models::sharing::{EMAIL_INVITATIONS_TABLE, INVITATIONS_TABLE, MEMBERS_TABLE};
use crate::server::postgres::models::user::{self, MaskedUser};
use crate::server::postgres::models::Table;
use crate::server::validation::js_trim;

/// How long an invitation sent to an email address stays open: 30 days.
pub const EMAIL_INVITATION_LIFETIME_MS: f64 = 30.0 * 24.0 * 60.0 * 60.0 * 1000.0;

/// What a sharing change answers: done, with what it produced, or refused with the reason.
#[derive(Clone, Debug, PartialEq)]
pub enum SharingOutcome<T> {
    Shared(T),
    Refused(String),
}

/// Whom an invitation went to: a user, or an email address nobody may have signed in with yet.
#[derive(Clone, Debug, PartialEq)]
pub enum SharingInvitee {
    User(MaskedUser),
    Email(String),
}

impl SharingInvitee {
    pub fn to_json(&self) -> Json {
        match self {
            SharingInvitee::User(user) => user.to_json(),
            SharingInvitee::Email(email) => json!({ "email": email }),
        }
    }
}

/// An unanswered invitation, with both people named.
#[derive(Clone, Debug, PartialEq)]
pub struct SharingInvitation {
    pub invitation_id: String,
    pub inviter: MaskedUser,
    /// The user it was sent to. One sent to an email address names the
    /// address to the inviter's group, and names the user it reached to that
    /// user.
    pub invitee: SharingInvitee,
    /// When an invitation sent to an email address lapses. One sent to a user never does.
    pub expires_at: Option<Json>,
}

impl SharingInvitation {
    pub fn to_json(&self) -> Json {
        let mut invitation =
            json!({ "invitation_id": self.invitation_id, "inviter": self.inviter.to_json(), "invitee": self.invitee.to_json() });
        if let (Some(expires_at), Json::Object(fields)) = (&self.expires_at, &mut invitation) {
            fields.insert("expires_at".into(), expires_at.clone());
        }
        invitation
    }
}

const DEMO_REFUSAL: &str = "The demo account can't share data.";

fn masked(row: &Obj, user_id: &str, username: &str) -> MaskedUser {
    MaskedUser { user_id: str_of(row, user_id).to_string(), username: str_of(row, username).to_string() }
}

fn to_invitation(row: &Obj) -> SharingInvitation {
    SharingInvitation {
        invitation_id: str_of(row, "invitation_id").to_string(),
        inviter: masked(row, "inviter_user_id", "inviter_username"),
        invitee: SharingInvitee::User(masked(row, "invitee_user_id", "invitee_username")),
        expires_at: None,
    }
}

const SELECT_INVITATIONS: &str = "
  SELECT i.invitation_id,
         inviter.user_id AS inviter_user_id, inviter.username AS inviter_username,
         invitee.user_id AS invitee_user_id, invitee.username AS invitee_username
  FROM sharing_invitations i
  JOIN users inviter ON inviter.user_id = i.inviter_user_id
  JOIN users invitee ON invitee.user_id = i.invitee_user_id";

/// An invitation the user may answer or withdraw: sent to them, or sent from their group.
const INVITATION_CONCERNS_USER: &str = "(i.invitee_user_id = $1 OR i.inviter_user_id = ANY(sharing_user_ids($1)))";

/// An email invitation sent by the user `$1` names, or by anyone in their group.
const EMAIL_INVITATION_FROM_GROUP: &str = "e.inviter_user_id = ANY(sharing_user_ids($1))";

/// An email invitation sent to the address of the user `param` names, and not lapsed.
fn email_invitation_open_to(param: &str) -> String {
    format!(
        "(e.invitee_email = (SELECT lower(u.email) FROM users u WHERE u.user_id = {param}) AND e.expires_at > CURRENT_TIMESTAMP)"
    )
}

/// An email invitation the user may withdraw, sent from their group, lapsed or
/// not; or one they may answer, open and sent to their address.
fn email_invitation_concerns_user() -> String {
    format!("({EMAIL_INVITATION_FROM_GROUP} OR {})", email_invitation_open_to("$1"))
}

/// Only the inviter's group learns the address; the user it reached sees it
/// addressed to them. `sent`: sent from the reader's group, else to the
/// reader's address.
fn to_email_invitation(reader: &MaskedUser, row: &Obj) -> SharingInvitation {
    SharingInvitation {
        invitation_id: str_of(row, "invitation_id").to_string(),
        inviter: masked(row, "inviter_user_id", "inviter_username"),
        invitee: if truthy_opt(row.get("sent")) {
            SharingInvitee::Email(str_of(row, "invitee_email").to_string())
        } else {
            SharingInvitee::User(reader.clone())
        },
        expires_at: Some(value_of(row, "expires_at")),
    }
}

/// Sharing changes are rare, and one lock for all of them keeps every membership check race-free.
async fn lock_sharing(client: &dyn Executor) -> anyhow::Result<()> {
    client.query(&format!("SELECT pg_advisory_xact_lock({SHARING_MEMBERSHIP_LOCK_KEY})"), &[]).await?;
    Ok(())
}

/// The user and everyone in their sharing group.
pub async fn get_sharing_user_ids(user_id: &str, client: Option<&dyn Executor>) -> anyhow::Result<Vec<String>> {
    let result = or_pool(client).query("SELECT unnest(sharing_user_ids($1)) AS user_id", &[json!(user_id)]).await?;
    Ok(result.rows.iter().map(|row| str_of(row, "user_id").to_string()).collect())
}

const SELECT_MEMBERS: &str = "SELECT u.user_id, u.username
       FROM sharing_members m
       JOIN users u ON u.user_id = m.user_id
       WHERE m.group_id = (
         SELECT own.group_id FROM sharing_members own WHERE own.user_id = $1
       )
       ORDER BY u.username";

/// The invitations to users that concern the user `$1` names.
fn select_invitations_concerning_user() -> String {
    format!(
        "{SELECT_INVITATIONS}
       WHERE {INVITATION_CONCERNS_USER}
       ORDER BY invitee.username, i.invitation_id"
    )
}

/// The invitations to email addresses that concern the user `$1` names, each
/// saying whether it was `sent` from their group.
fn select_email_invitations_concerning_user() -> String {
    format!(
        "SELECT e.invitation_id, e.invitee_email, e.expires_at,
              inviter.user_id AS inviter_user_id, inviter.username AS inviter_username,
              {EMAIL_INVITATION_FROM_GROUP} AS sent
       FROM sharing_email_invitations e
       JOIN users inviter ON inviter.user_id = e.inviter_user_id
       WHERE {}
       ORDER BY e.invitee_email, e.invitation_id",
        email_invitation_concerns_user()
    )
}

/// Everyone in the user's sharing group, the user included (empty while they
/// share with nobody), and the unanswered invitations sent to the user or to
/// their email address, or sent by the user or anyone in their group.
pub async fn get_sharing(user: &MaskedUser) -> anyhow::Result<Json> {
    let (invitations_sql, email_invitations_sql) = (select_invitations_concerning_user(), select_email_invitations_concerning_user());
    let values = [json!(user.user_id)];
    let (members, invitations, email_invitations) = futures::join!(
        pool().query(SELECT_MEMBERS, &values),
        pool().query(&invitations_sql, &values),
        pool().query(&email_invitations_sql, &values),
    );
    let (members, invitations, email_invitations) = (members?, invitations?, email_invitations?);
    Ok(to_sharing(user, &members.rows, &invitations.rows, &email_invitations.rows))
}

/// What [`get_sharing`] answers, from its three reads: invitations to users
/// first, then invitations to addresses.
fn to_sharing(reader: &MaskedUser, members: &[Obj], invitations: &[Obj], email_invitations: &[Obj]) -> Json {
    let invitations = invitations.iter().map(to_invitation).chain(email_invitations.iter().map(|row| to_email_invitation(reader, row)));
    json!({
        "members": members.iter().map(|row| masked(row, "user_id", "username").to_json()).collect::<Vec<_>>(),
        "invitations": invitations.map(|invitation| invitation.to_json()).collect::<Vec<_>>(),
    })
}

/// The owner of a row the user may act on: the user or someone in their
/// sharing group. `None` when the row is deleted, missing, or belongs to
/// anyone else. A row written under a parent row takes the parent's owner, so
/// that a connection or a budget leaves a sharing group with everything in it.
pub async fn get_row_owner(user: &MaskedUser, table: &Table, id: &str) -> anyhow::Result<Option<MaskedUser>> {
    let live = if table.supports_soft_delete { " AND (r.is_deleted IS NULL OR r.is_deleted = FALSE)" } else { "" };
    let sql = format!(
        "SELECT u.user_id, u.username
     FROM {} r
     JOIN users u ON u.user_id = r.user_id
     WHERE r.{} = $1 AND r.user_id = ANY(sharing_user_ids($2)){live}",
        table.name, table.primary_key
    );
    let result = pool().query(&sql, &[json!(id), json!(user.user_id)]).await?;
    Ok(result.rows.first().map(|row| masked(row, "user_id", "username")))
}

/// Invites the user `username` names to share data. Inviting someone twice
/// answers with the invitation that is already open.
pub async fn invite_to_share(user: &MaskedUser, username: &str) -> anyhow::Result<SharingOutcome<SharingInvitation>> {
    let refuse = |message: String| Ok(SharingOutcome::Refused(message));
    if user.username == DEMO_USERNAME || username == DEMO_USERNAME {
        return refuse(DEMO_REFUSAL.to_string());
    }
    let Some(invitee) = user::TABLE.query_one(filters! { "username" => username }).await? else {
        return refuse("No user has that username.".to_string());
    };
    let invitee = user::to_masked_user(&invitee);
    if invitee.user_id == user.user_id {
        return refuse("You can't invite yourself.".to_string());
    }

    let group_ids = get_sharing_user_ids(&user.user_id, None).await?;
    if group_ids.contains(&invitee.user_id) {
        return refuse(format!("You already share data with {}.", invitee.username));
    }

    let crossing = INVITATIONS_TABLE
        .query_one(filters! { "inviter_user_id" => invitee.user_id.as_str(), "invitee_user_id" => user.user_id.as_str() })
        .await?;
    if crossing.is_some() {
        return refuse(format!("{} already invited you. Accept that invitation.", invitee.username));
    }

    let mut data = Obj::new();
    data.insert("inviter_user_id".into(), json!(user.user_id));
    data.insert("invitee_user_id".into(), json!(invitee.user_id));
    INVITATIONS_TABLE.insert(&data, Some(&["invitation_id"]), true).await?;
    let invitations = INVITATIONS_TABLE
        .query(
            filters! { "inviter_user_id" => user.user_id.as_str(), "invitee_user_id" => invitee.user_id.as_str() },
            SearchFilters::default(),
            None,
        )
        .await?;
    let Some(invitation) = invitations.first() else {
        anyhow::bail!("The invitation was withdrawn while it was being sent.");
    };
    Ok(SharingOutcome::Shared(SharingInvitation {
        invitation_id: str_of(invitation, "invitation_id").to_string(),
        inviter: user.clone(),
        invitee: SharingInvitee::User(invitee),
        expires_at: None,
    }))
}

/// The most invitations to email addresses one user keeps, open and lapsed
/// together. Nothing deletes a lapsed one but its group, and every member
/// reads them all on every sync, so the number has to stop somewhere.
pub const EMAIL_INVITATIONS_PER_USER: usize = 20;

/// An invitation sent to an email address, and the user who has the address,
/// if anyone does, for the event that tells them. That user never goes back
/// to the inviter.
#[derive(Clone, Debug, PartialEq)]
pub struct EmailInvitationSent {
    pub invitation: SharingInvitation,
    pub invitee_user_id: Option<String>,
}

/// One user's sends wait for each other, so two at once can't both pass the cap.
const LOCK_EMAIL_INVITATIONS: &str = "SELECT pg_advisory_xact_lock(hashtext($1 || ':email-invitations'))";

/// Invites whoever signs in with `email` to share data: the user who has that
/// address now, or one who signs up with it before the invitation lapses. It
/// answers alike whether anyone has the address yet, in what it says and in
/// the statements it runs, so it can't be used to learn who has an account.
/// Inviting an address again keeps the invitation and restarts its time.
pub async fn invite_by_email(user: &MaskedUser, email: &str) -> anyhow::Result<SharingOutcome<EmailInvitationSent>> {
    if user.username == DEMO_USERNAME {
        return Ok(SharingOutcome::Refused(DEMO_REFUSAL.to_string()));
    }
    let invitee_email = js_trim(email).to_lowercase();

    let holder_lookup = SearchFilters {
        equals_ignoring_case: Some(("email".to_string(), invitee_email.clone())),
        limit: Some(1),
        ..Default::default()
    };
    let (holders, group_ids) =
        futures::join!(user::TABLE.query(Vec::new(), holder_lookup, None), get_sharing_user_ids(&user.user_id, None));
    let (holders, group_ids) = (holders?, group_ids?);
    let holder = holders.first().map(user::to_masked_user);
    if let Some(holder) = &holder {
        if holder.user_id == user.user_id {
            return Ok(SharingOutcome::Refused("You can't invite yourself.".to_string()));
        }
        if group_ids.contains(&holder.user_id) {
            return Ok(SharingOutcome::Refused(format!("You already share data with {}.", holder.username)));
        }
    }

    let (user, invitee_user_id) = (user.clone(), holder.map(|holder| holder.user_id));
    with_transaction(move |client| {
        Box::pin(async move { send_email_invitation(client, &user, &invitee_email, invitee_user_id).await })
    })
    .await
}

/// The writing half of [`invite_by_email`], in its transaction: under the
/// cap, the invitation from `user` to `invitee_email`, new or renewed.
async fn send_email_invitation(
    client: &dyn Executor,
    user: &MaskedUser,
    invitee_email: &str,
    invitee_user_id: Option<String>,
) -> anyhow::Result<SharingOutcome<EmailInvitationSent>> {
    client.query(LOCK_EMAIL_INVITATIONS, &[json!(user.user_id)]).await?;
    let sent = EMAIL_INVITATIONS_TABLE
        .query(filters! { "inviter_user_id" => user.user_id.as_str() }, SearchFilters::default(), Some(client))
        .await?;
    let others = sent.iter().filter(|invitation| value_of(invitation, "invitee_email") != json!(invitee_email)).count();
    if others >= EMAIL_INVITATIONS_PER_USER {
        return Ok(SharingOutcome::Refused(format!(
            "You have {EMAIL_INVITATIONS_PER_USER} invitations sent to email addresses. Withdraw one before sending another."
        )));
    }

    let expires_at = JsDate::from_ms(JsDate::now_ms() + EMAIL_INVITATION_LIFETIME_MS).to_json();
    let mut data = Obj::new();
    data.insert("inviter_user_id".into(), json!(user.user_id));
    data.insert("invitee_email".into(), json!(invitee_email));
    data.insert("expires_at".into(), expires_at);
    let row = EMAIL_INVITATIONS_TABLE
        .upsert(&data, Some(&["expires_at"]), Some(client), Some(&["inviter_user_id", "invitee_email"]))
        .await?;
    // A conflict updates the row, so the statement always answers one.
    let invitation = EMAIL_INVITATIONS_TABLE.validate(row.unwrap_or_default())?;
    Ok(SharingOutcome::Shared(EmailInvitationSent {
        invitation: SharingInvitation {
            invitation_id: str_of(&invitation, "invitation_id").to_string(),
            inviter: user.clone(),
            invitee: SharingInvitee::Email(str_of(&invitation, "invitee_email").to_string()),
            expires_at: Some(value_of(&invitation, "expires_at")),
        },
        invitee_user_id,
    }))
}

fn delete_invitation_sql() -> String {
    format!(
        "DELETE FROM sharing_invitations i
     WHERE i.invitation_id = $2 AND {INVITATION_CONCERNS_USER}
     RETURNING i.inviter_user_id, i.invitee_user_id"
    )
}

fn delete_email_invitation_sql() -> String {
    format!(
        "DELETE FROM sharing_email_invitations e
     WHERE e.invitation_id = $2 AND {}
     RETURNING e.inviter_user_id,
       (SELECT u.user_id FROM users u WHERE lower(u.email) = e.invitee_email) AS invitee_user_id",
        email_invitation_concerns_user()
    )
}

/// Declines an invitation sent to the user or to their address, or withdraws
/// one the user or anyone in their group sent. Answers who it was between, or
/// `None` when the user has no such invitation. An email invitation is
/// between its inviter and whoever has the address, when anyone does.
pub async fn delete_sharing_invitation(user: &MaskedUser, invitation_id: &str) -> anyhow::Result<Option<Vec<String>>> {
    let values = [json!(user.user_id), json!(invitation_id)];
    let result = pool().query(&delete_invitation_sql(), &values).await?;
    if let Some(row) = result.rows.first() {
        return Ok(Some(vec![str_of(row, "inviter_user_id").to_string(), str_of(row, "invitee_user_id").to_string()]));
    }

    let email_result = pool().query(&delete_email_invitation_sql(), &values).await?;
    let Some(row) = email_result.rows.first() else { return Ok(None) };
    let mut affected_user_ids = vec![str_of(row, "inviter_user_id").to_string()];
    if truthy_opt(row.get("invitee_user_id")) {
        affected_user_ids.push(str_of(row, "invitee_user_id").to_string());
    }
    Ok(Some(affected_user_ids))
}

/// Sent to the user `$2` names, or open, sent to their address, and not by
/// themself: an address that has since become the inviter's own can't join
/// them to themself.
fn find_open_invitation_sql() -> String {
    format!(
        "SELECT inviter_user_id FROM sharing_invitations
       WHERE invitation_id = $1 AND invitee_user_id = $2
       UNION ALL
       SELECT e.inviter_user_id FROM sharing_email_invitations e
       WHERE e.invitation_id = $1 AND e.inviter_user_id <> $2 AND {}",
        email_invitation_open_to("$2")
    )
}

/// The invitations to users settled once group `$1` is formed: any between two of its members.
const DELETE_SETTLED_INVITATIONS: &str = "DELETE FROM sharing_invitations i
       USING sharing_members inviter, sharing_members invitee
       WHERE inviter.user_id = i.inviter_user_id
         AND invitee.user_id = i.invitee_user_id
         AND inviter.group_id = $1
         AND invitee.group_id = $1";

/// The invitations to addresses settled once group `$1` is formed: any from a
/// member to the address of another.
const DELETE_SETTLED_EMAIL_INVITATIONS: &str = "DELETE FROM sharing_email_invitations e
       USING sharing_members inviter, sharing_members invitee, users u
       WHERE inviter.user_id = e.inviter_user_id
         AND u.user_id = invitee.user_id
         AND lower(u.email) = e.invitee_email
         AND inviter.group_id = $1
         AND invitee.group_id = $1";

/// Accepts an invitation sent to the user or to their address: they join the
/// inviter's sharing group, which is created when the inviter shared with
/// nobody yet. From then on every member reads and writes every other
/// member's data. Answers who the change reaches: everyone now in the group.
pub async fn accept_sharing_invitation(user: &MaskedUser, invitation_id: &str) -> anyhow::Result<SharingOutcome<Vec<String>>> {
    if user.username == DEMO_USERNAME {
        return Ok(SharingOutcome::Refused(DEMO_REFUSAL.to_string()));
    }
    let (user, invitation_id) = (user.clone(), invitation_id.to_string());
    with_transaction(move |client| {
        Box::pin(async move {
            let client: &dyn Executor = client;
            lock_sharing(client).await?;

            let invitation = client.query(&find_open_invitation_sql(), &[json!(invitation_id), json!(user.user_id)]).await?;
            let Some(invitation) = invitation.rows.first() else {
                return Ok(SharingOutcome::Refused("That invitation is no longer open.".to_string()));
            };
            let inviter_user_id = str_of(invitation, "inviter_user_id").to_string();

            let memberships = MEMBERS_TABLE
                .query(
                    Vec::new(),
                    SearchFilters {
                        in_filters: vec![("user_id".to_string(), vec![json!(user.user_id), json!(inviter_user_id)])],
                        ..Default::default()
                    },
                    Some(client),
                )
                .await?;
            let group_of: HashMap<String, String> = memberships
                .iter()
                .map(|member| (str_of(member, "user_id").to_string(), str_of(member, "group_id").to_string()))
                .collect();
            if group_of.contains_key(&user.user_id) {
                return Ok(SharingOutcome::Refused("Stop sharing with your current group before joining another.".to_string()));
            }

            let group_id = group_of.get(&inviter_user_id).cloned().unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            let member = |user_id: &str| -> Obj {
                let mut row = Obj::new();
                row.insert("user_id".into(), json!(user_id));
                row.insert("group_id".into(), json!(group_id));
                row
            };
            MEMBERS_TABLE.upsert_many(&[member(&inviter_user_id), member(&user.user_id)], Some(&[]), Some(client)).await?;

            // The accepted invitation, and any other between two people who now
            // share, whether it named the user or their address.
            client.query(DELETE_SETTLED_INVITATIONS, &[json!(group_id)]).await?;
            client.query(DELETE_SETTLED_EMAIL_INVITATIONS, &[json!(group_id)]).await?;

            Ok(SharingOutcome::Shared(get_sharing_user_ids(&user.user_id, Some(client)).await?))
        })
    })
    .await
}

/// Takes `member_user_id` out of the user's sharing group: the user leaving,
/// or the user removing someone else. Everyone keeps the rows they own. A
/// group left with one member is dissolved, and a transfer pair with one side
/// on each side of the split is deleted the way a pair is when one of its
/// transactions is, since neither side could see or replace it any more.
/// Answers who the change reaches: everyone who was in the group.
pub async fn remove_sharing_member(user: &MaskedUser, member_user_id: &str) -> anyhow::Result<SharingOutcome<Vec<String>>> {
    let (user, member_user_id) = (user.clone(), member_user_id.to_string());
    with_transaction(move |client| {
        Box::pin(async move {
            let client: &dyn Executor = client;
            lock_sharing(client).await?;

            let former = get_sharing_user_ids(&user.user_id, Some(client)).await?;
            if former.len() < 2 || !former.contains(&member_user_id) {
                return Ok(SharingOutcome::Refused("You don't share data with that user.".to_string()));
            }

            let leaving: Vec<String> = if former.len() == 2 { former.clone() } else { vec![member_user_id.clone()] };
            client.query("DELETE FROM sharing_members WHERE user_id = ANY($1::uuid[])", &[json!(leaving)]).await?;

            client
                .query(
                    "UPDATE transaction_pairs pair
       SET is_deleted = TRUE, updated = CURRENT_TIMESTAMP
       FROM transactions a, transactions b
       WHERE a.transaction_id = pair.transaction_id_a
         AND b.transaction_id = pair.transaction_id_b
         AND pair.user_id = ANY($1::uuid[])
         AND (pair.is_deleted IS NULL OR pair.is_deleted = FALSE)
         AND (a.user_id = $2) <> (b.user_id = $2)",
                    &[json!(former), json!(member_user_id)],
                )
                .await?;

            Ok(SharingOutcome::Shared(former))
        })
    })
    .await
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::super::transactions::testing::{obj, FakeExecutor};
    use super::*;

    // The statements as the TypeScript sends them, character for character.

    const SELECT_INVITATIONS_CONCERNING_USER: &str = "\n  SELECT i.invitation_id,\n         inviter.user_id AS inviter_user_id, inviter.username AS inviter_username,\n         invitee.user_id AS invitee_user_id, invitee.username AS invitee_username\n  FROM sharing_invitations i\n  JOIN users inviter ON inviter.user_id = i.inviter_user_id\n  JOIN users invitee ON invitee.user_id = i.invitee_user_id\n       WHERE (i.invitee_user_id = $1 OR i.inviter_user_id = ANY(sharing_user_ids($1)))\n       ORDER BY invitee.username, i.invitation_id";
    const SELECT_EMAIL_INVITATIONS_CONCERNING_USER: &str = "SELECT e.invitation_id, e.invitee_email, e.expires_at,\n              inviter.user_id AS inviter_user_id, inviter.username AS inviter_username,\n              e.inviter_user_id = ANY(sharing_user_ids($1)) AS sent\n       FROM sharing_email_invitations e\n       JOIN users inviter ON inviter.user_id = e.inviter_user_id\n       WHERE (e.inviter_user_id = ANY(sharing_user_ids($1)) OR (e.invitee_email = (SELECT lower(u.email) FROM users u WHERE u.user_id = $1) AND e.expires_at > CURRENT_TIMESTAMP))\n       ORDER BY e.invitee_email, e.invitation_id";
    const DELETE_INVITATION: &str = "DELETE FROM sharing_invitations i\n     WHERE i.invitation_id = $2 AND (i.invitee_user_id = $1 OR i.inviter_user_id = ANY(sharing_user_ids($1)))\n     RETURNING i.inviter_user_id, i.invitee_user_id";
    const DELETE_EMAIL_INVITATION: &str = "DELETE FROM sharing_email_invitations e\n     WHERE e.invitation_id = $2 AND (e.inviter_user_id = ANY(sharing_user_ids($1)) OR (e.invitee_email = (SELECT lower(u.email) FROM users u WHERE u.user_id = $1) AND e.expires_at > CURRENT_TIMESTAMP))\n     RETURNING e.inviter_user_id,\n       (SELECT u.user_id FROM users u WHERE lower(u.email) = e.invitee_email) AS invitee_user_id";
    const FIND_OPEN_INVITATION: &str = "SELECT inviter_user_id FROM sharing_invitations\n       WHERE invitation_id = $1 AND invitee_user_id = $2\n       UNION ALL\n       SELECT e.inviter_user_id FROM sharing_email_invitations e\n       WHERE e.invitation_id = $1 AND e.inviter_user_id <> $2 AND (e.invitee_email = (SELECT lower(u.email) FROM users u WHERE u.user_id = $2) AND e.expires_at > CURRENT_TIMESTAMP)";
    const SETTLED_INVITATIONS: &str = "DELETE FROM sharing_invitations i\n       USING sharing_members inviter, sharing_members invitee\n       WHERE inviter.user_id = i.inviter_user_id\n         AND invitee.user_id = i.invitee_user_id\n         AND inviter.group_id = $1\n         AND invitee.group_id = $1";
    const SETTLED_EMAIL_INVITATIONS: &str = "DELETE FROM sharing_email_invitations e\n       USING sharing_members inviter, sharing_members invitee, users u\n       WHERE inviter.user_id = e.inviter_user_id\n         AND u.user_id = invitee.user_id\n         AND lower(u.email) = e.invitee_email\n         AND inviter.group_id = $1\n         AND invitee.group_id = $1";
    const SELECT_SENT: &str = "SELECT * FROM sharing_email_invitations WHERE inviter_user_id = $1";
    const UPSERT_INVITATION: &str = "INSERT INTO sharing_email_invitations (updated, inviter_user_id, invitee_email, expires_at) VALUES (CURRENT_TIMESTAMP, $1, $2, $3) ON CONFLICT (inviter_user_id, invitee_email) DO UPDATE SET expires_at = EXCLUDED.expires_at, updated = CURRENT_TIMESTAMP RETURNING *";

    fn person(name: &str) -> MaskedUser {
        MaskedUser { user_id: format!("u-{name}"), username: name.to_string() }
    }

    #[test]
    fn every_statement_is_the_typescript_s() {
        assert_eq!(SELECT_MEMBERS, "SELECT u.user_id, u.username\n       FROM sharing_members m\n       JOIN users u ON u.user_id = m.user_id\n       WHERE m.group_id = (\n         SELECT own.group_id FROM sharing_members own WHERE own.user_id = $1\n       )\n       ORDER BY u.username");
        assert_eq!(select_invitations_concerning_user(), SELECT_INVITATIONS_CONCERNING_USER);
        assert_eq!(select_email_invitations_concerning_user(), SELECT_EMAIL_INVITATIONS_CONCERNING_USER);
        assert_eq!(delete_invitation_sql(), DELETE_INVITATION);
        assert_eq!(delete_email_invitation_sql(), DELETE_EMAIL_INVITATION);
        assert_eq!(find_open_invitation_sql(), FIND_OPEN_INVITATION);
        assert_eq!(DELETE_SETTLED_INVITATIONS, SETTLED_INVITATIONS);
        assert_eq!(DELETE_SETTLED_EMAIL_INVITATIONS, SETTLED_EMAIL_INVITATIONS);
        assert_eq!(LOCK_EMAIL_INVITATIONS, "SELECT pg_advisory_xact_lock(hashtext($1 || ':email-invitations'))");
    }

    // "getSharing"

    fn email_row(invitation_id: &str, inviter: &MaskedUser, sent: bool) -> Obj {
        obj(json!({
            "invitation_id": invitation_id,
            "invitee_email": "friend@example.com",
            "expires_at": "2026-12-22T00:00:00.000Z",
            "inviter_user_id": inviter.user_id,
            "inviter_username": inviter.username,
            "sent": sent,
        }))
    }

    #[test]
    fn names_the_address_of_an_email_invitation_the_group_sent_and_the_user_reading_one_sent_to_their_address() {
        let (alice, bob, dave) = (person("alice"), person("bob"), person("dave"));
        let members = [obj(alice.to_json()), obj(bob.to_json())];
        let emails = [email_row("inv-sent", &bob, true), email_row("inv-received", &dave, false)];
        assert_eq!(
            to_sharing(&alice, &members, &[], &emails),
            json!({
                "members": [alice.to_json(), bob.to_json()],
                "invitations": [
                    {
                        "invitation_id": "inv-sent",
                        "inviter": bob.to_json(),
                        "invitee": { "email": "friend@example.com" },
                        "expires_at": "2026-12-22T00:00:00.000Z",
                    },
                    {
                        "invitation_id": "inv-received",
                        "inviter": dave.to_json(),
                        "invitee": alice.to_json(),
                        "expires_at": "2026-12-22T00:00:00.000Z",
                    },
                ],
            })
        );
    }

    #[test]
    fn lists_invitations_to_users_before_invitations_to_addresses_and_gives_only_these_a_lapse_time() {
        let alice = person("alice");
        let to_user = obj(json!({
            "invitation_id": "inv-user",
            "inviter_user_id": "u-alice",
            "inviter_username": "alice",
            "invitee_user_id": "u-carol",
            "invitee_username": "carol",
        }));
        let sharing = to_sharing(&alice, &[], &[to_user], &[email_row("inv-email", &alice, true)]);
        let invitations = sharing["invitations"].as_array().unwrap();
        assert_eq!(invitations[0], json!({ "invitation_id": "inv-user", "inviter": alice.to_json(), "invitee": person("carol").to_json() }));
        assert_eq!(invitations[1]["invitation_id"], json!("inv-email"));
        // The keys keep the TypeScript's order, which is what the response shows.
        let keys: Vec<&String> = invitations[1].as_object().unwrap().keys().collect();
        assert_eq!(keys, ["invitation_id", "inviter", "invitee", "expires_at"]);
    }

    #[test]
    fn answers_empty_lists_for_a_user_who_shares_with_nobody_and_has_no_invitation() {
        assert_eq!(to_sharing(&person("alice"), &[], &[], &[]), json!({ "members": [], "invitations": [] }));
    }

    // "inviteByEmail", its writes.

    fn invitation_row(invitation_id: &str, invitee_email: &str, expires_at: &str) -> Json {
        json!({
            "invitation_id": invitation_id,
            "inviter_user_id": "u-alice",
            "invitee_email": invitee_email,
            "expires_at": expires_at,
            "updated": "2026-11-22T10:00:00.000Z",
        })
    }

    /// `count` invitations alice already sent, none of them to friend@example.com.
    fn sent_elsewhere(count: usize) -> Vec<Json> {
        (0..count).map(|i| invitation_row(&format!("inv-{i}"), &format!("other{i}@example.com"), "2026-12-22T10:00:00.000Z")).collect()
    }

    async fn send(executor: &FakeExecutor, invitee_user_id: Option<&str>) -> SharingOutcome<EmailInvitationSent> {
        send_email_invitation(executor, &person("alice"), "friend@example.com", invitee_user_id.map(str::to_string)).await.unwrap()
    }

    /// Checks the statements of a send that wrote, and answers the lapse time it bound.
    fn expect_written(executor: &FakeExecutor) -> String {
        let calls = executor.calls();
        let statements: Vec<&str> = calls.iter().map(|(sql, _)| sql.as_str()).collect();
        assert_eq!(statements, [LOCK_EMAIL_INVITATIONS, SELECT_SENT, UPSERT_INVITATION]);
        assert_eq!(calls[0].1, vec![json!("u-alice")]);
        assert_eq!(calls[1].1, vec![json!("u-alice")]);
        assert_eq!(calls[2].1[..2], [json!("u-alice"), json!("friend@example.com")]);
        calls[2].1[2].as_str().unwrap().to_string()
    }

    fn row_kept(invitation_id: &str) -> Vec<Json> {
        vec![invitation_row(invitation_id, "friend@example.com", "2026-12-22T10:00:00.000Z")]
    }

    #[tokio::test]
    async fn an_address_gets_an_invitation_open_for_thirty_days() {
        assert_eq!(EMAIL_INVITATION_LIFETIME_MS, 2_592_000_000.0);
        let executor = FakeExecutor::new().count(0).rows(vec![]).rows(row_kept("inv-e1"));
        let before = JsDate::now_ms();
        let outcome = send(&executor, None).await;
        let after = JsDate::now_ms();

        let bound = JsDate::parse(&expect_written(&executor)).get_time();
        assert!(before + EMAIL_INVITATION_LIFETIME_MS <= bound && bound <= after + EMAIL_INVITATION_LIFETIME_MS);
        // What the invitation answers is the row the database kept.
        let SharingOutcome::Shared(sent) = outcome else { panic!("refused") };
        assert_eq!(sent.invitee_user_id, None);
        assert_eq!(
            sent.invitation.to_json(),
            json!({
                "invitation_id": "inv-e1",
                "inviter": person("alice").to_json(),
                "invitee": { "email": "friend@example.com" },
                "expires_at": "2026-12-22T10:00:00.000Z",
            })
        );
    }

    #[tokio::test]
    async fn an_address_someone_has_runs_the_same_statements_and_answers_alike_naming_that_user_only_for_the_event() {
        let nobody = FakeExecutor::new().count(0).rows(vec![]).rows(row_kept("inv-e1"));
        let someone = FakeExecutor::new().count(0).rows(vec![]).rows(row_kept("inv-e1"));
        let (SharingOutcome::Shared(for_nobody), SharingOutcome::Shared(for_someone)) =
            (send(&nobody, None).await, send(&someone, Some("u-bob")).await)
        else {
            panic!("refused")
        };
        assert_eq!(for_someone.invitee_user_id.as_deref(), Some("u-bob"));
        assert_eq!(for_someone.invitation, for_nobody.invitation);
        expect_written(&nobody);
        expect_written(&someone);
    }

    #[tokio::test]
    async fn inviting_an_address_again_answers_the_invitation_already_there() {
        // The conflict on (inviter, address) rewrites only the lapse time of the row already there.
        let executor = FakeExecutor::new()
            .count(0)
            .rows(vec![invitation_row("inv-open", "friend@example.com", "2026-11-30T00:00:00.000Z")])
            .rows(row_kept("inv-open"));
        let SharingOutcome::Shared(sent) = send(&executor, None).await else { panic!("refused") };
        assert_eq!(sent.invitation.invitation_id, "inv-open");
        assert_eq!(sent.invitation.expires_at, Some(json!("2026-12-22T10:00:00.000Z")));
        expect_written(&executor);
    }

    #[tokio::test]
    async fn a_user_with_twenty_invitations_to_other_addresses_cannot_send_another_and_nothing_is_written() {
        assert_eq!(EMAIL_INVITATIONS_PER_USER, 20);
        let executor = FakeExecutor::new().count(0).rows(sent_elsewhere(20));
        assert_eq!(
            send(&executor, None).await,
            SharingOutcome::Refused("You have 20 invitations sent to email addresses. Withdraw one before sending another.".to_string())
        );
        let statements: Vec<String> = executor.calls().into_iter().map(|(sql, _)| sql).collect();
        assert_eq!(statements, [LOCK_EMAIL_INVITATIONS, SELECT_SENT]);
    }

    #[tokio::test]
    async fn one_under_the_limit_can_still_send() {
        let executor = FakeExecutor::new().count(0).rows(sent_elsewhere(19)).rows(row_kept("inv-e1"));
        assert!(matches!(send(&executor, None).await, SharingOutcome::Shared(_)));
        expect_written(&executor);
    }

    #[tokio::test]
    async fn at_the_limit_sending_to_an_address_already_invited_renews_it_since_it_adds_no_row() {
        let mut sent = sent_elsewhere(19);
        sent.push(invitation_row("inv-open", "friend@example.com", "2026-11-30T00:00:00.000Z"));
        let executor = FakeExecutor::new().count(0).rows(sent).rows(row_kept("inv-open"));
        let SharingOutcome::Shared(sent) = send(&executor, None).await else { panic!("refused") };
        assert_eq!(sent.invitation.invitation_id, "inv-open");
        expect_written(&executor);
    }
}
