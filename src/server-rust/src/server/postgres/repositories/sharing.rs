//! Data sharing between users: `src/server/lib/postgres/repositories/sharing.ts`.
//!
//! The TypeScript's `SharingResult<T>` (`{ ok: true, …T } | { ok: false, error }`)
//! is [`SharingOutcome<T>`]: `Shared(T)` or `Refused(message)`.

use std::collections::HashMap;

use serde_json::json;

use crate::common::constants::DEMO_USERNAME;
use crate::filters;
use crate::js::{Json, Obj};
use crate::server::postgres::client::{or_pool, pool, with_transaction, Executor};
use crate::server::postgres::database::{SearchFilters, SHARING_MEMBERSHIP_LOCK_KEY};
use crate::server::postgres::models::base::str_of;
use crate::server::postgres::models::sharing::{INVITATIONS_TABLE, MEMBERS_TABLE};
use crate::server::postgres::models::user::{self, MaskedUser};
use crate::server::postgres::models::Table;

/// What a sharing change answers: done, with what it produced, or refused with the reason.
#[derive(Clone, Debug, PartialEq)]
pub enum SharingOutcome<T> {
    Shared(T),
    Refused(String),
}

/// An unanswered invitation, with both people named.
#[derive(Clone, Debug, PartialEq)]
pub struct SharingInvitation {
    pub invitation_id: String,
    pub inviter: MaskedUser,
    pub invitee: MaskedUser,
}

impl SharingInvitation {
    pub fn to_json(&self) -> Json {
        json!({ "invitation_id": self.invitation_id, "inviter": self.inviter.to_json(), "invitee": self.invitee.to_json() })
    }
}

fn masked(row: &Obj, user_id: &str, username: &str) -> MaskedUser {
    MaskedUser { user_id: str_of(row, user_id).to_string(), username: str_of(row, username).to_string() }
}

fn to_invitation(row: &Obj) -> SharingInvitation {
    SharingInvitation {
        invitation_id: str_of(row, "invitation_id").to_string(),
        inviter: masked(row, "inviter_user_id", "inviter_username"),
        invitee: masked(row, "invitee_user_id", "invitee_username"),
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

/// Everyone in the user's sharing group, the user included (empty while they
/// share with nobody), and the unanswered invitations sent to the user, or
/// sent by the user or anyone in their group.
pub async fn get_sharing(user: &MaskedUser) -> anyhow::Result<Json> {
    let members_sql = "SELECT u.user_id, u.username
       FROM sharing_members m
       JOIN users u ON u.user_id = m.user_id
       WHERE m.group_id = (
         SELECT own.group_id FROM sharing_members own WHERE own.user_id = $1
       )
       ORDER BY u.username";
    let invitations_sql = format!(
        "{SELECT_INVITATIONS}
       WHERE {INVITATION_CONCERNS_USER}
       ORDER BY invitee.username, i.invitation_id"
    );
    let values = [json!(user.user_id)];
    let (members, invitations) = futures::join!(pool().query(members_sql, &values), pool().query(&invitations_sql, &values));
    let (members, invitations) = (members?, invitations?);
    Ok(json!({
        "members": members.rows.iter().map(|row| masked(row, "user_id", "username").to_json()).collect::<Vec<_>>(),
        "invitations": invitations.rows.iter().map(|row| to_invitation(row).to_json()).collect::<Vec<_>>(),
    }))
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
        return refuse("The demo account can't share data.".to_string());
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
        invitee,
    }))
}

/// Declines an invitation sent to the user, or withdraws one the user or
/// anyone in their group sent. Answers the two people it was between, or
/// `None` when the user has no such invitation.
pub async fn delete_sharing_invitation(user: &MaskedUser, invitation_id: &str) -> anyhow::Result<Option<Vec<String>>> {
    let sql = format!(
        "DELETE FROM sharing_invitations i
     WHERE i.invitation_id = $2 AND {INVITATION_CONCERNS_USER}
     RETURNING i.inviter_user_id, i.invitee_user_id"
    );
    let result = pool().query(&sql, &[json!(user.user_id), json!(invitation_id)]).await?;
    Ok(result
        .rows
        .first()
        .map(|row| vec![str_of(row, "inviter_user_id").to_string(), str_of(row, "invitee_user_id").to_string()]))
}

/// Accepts an invitation sent to the user: they join the inviter's sharing
/// group, which is created when the inviter shared with nobody yet. From then
/// on every member reads and writes every other member's data. Answers who the
/// change reaches: everyone now in the group.
pub async fn accept_sharing_invitation(user: &MaskedUser, invitation_id: &str) -> anyhow::Result<SharingOutcome<Vec<String>>> {
    if user.username == DEMO_USERNAME {
        return Ok(SharingOutcome::Refused("The demo account can't share data.".to_string()));
    }
    let (user, invitation_id) = (user.clone(), invitation_id.to_string());
    with_transaction(move |client| {
        Box::pin(async move {
            let client: &dyn Executor = client;
            lock_sharing(client).await?;

            let invitation = client
                .query(
                    "SELECT inviter_user_id FROM sharing_invitations
       WHERE invitation_id = $1 AND invitee_user_id = $2",
                    &[json!(invitation_id), json!(user.user_id)],
                )
                .await?;
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

            // The accepted invitation, and any other between two people who now share.
            client
                .query(
                    "DELETE FROM sharing_invitations i
       USING sharing_members inviter, sharing_members invitee
       WHERE inviter.user_id = i.inviter_user_id
         AND invitee.user_id = i.invitee_user_id
         AND inviter.group_id = $1
         AND invitee.group_id = $1",
                    &[json!(group_id)],
                )
                .await?;

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
