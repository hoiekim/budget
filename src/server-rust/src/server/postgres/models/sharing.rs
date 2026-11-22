//! `src/server/lib/postgres/models/sharing.ts`.

use serde_json::json;

use super::base::{value_of, Check, IndexDefinition, Row, Table};
use crate::js::Json;

/// Who shares data with whom. The members of one group read and write each
/// other's rows as their own. A user is in at most one group (the primary
/// key), and a group never has fewer than two members.
pub static MEMBERS_TABLE: Table = Table {
    name: "sharing_members",
    primary_key: "user_id",
    schema: &[
        ("user_id", "UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE"),
        ("group_id", "UUID NOT NULL"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
    ],
    constraints: &[],
    indexes: &[IndexDefinition::column("group_id")],
    model: "SharingMemberModel",
    checks: &[("user_id", Check::String), ("group_id", Check::String), ("updated", Check::NullableString)],
    supports_soft_delete: false,
};

/// `SharingMemberModel.toJSON()`.
pub fn member_to_json(row: &Row) -> Json {
    json!({ "user_id": value_of(row, "user_id"), "group_id": value_of(row, "group_id") })
}

/// An offer to share data that the invitee has not answered yet. Answering it deletes the row.
pub static INVITATIONS_TABLE: Table = Table {
    name: "sharing_invitations",
    primary_key: "invitation_id",
    schema: &[
        ("invitation_id", "UUID PRIMARY KEY DEFAULT gen_random_uuid()"),
        ("inviter_user_id", "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE"),
        ("invitee_user_id", "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
    ],
    constraints: &["CONSTRAINT sharing_invitations_pair_unique UNIQUE (inviter_user_id, invitee_user_id)"],
    indexes: &[IndexDefinition::column("invitee_user_id")],
    model: "SharingInvitationModel",
    checks: &[
        ("invitation_id", Check::String),
        ("inviter_user_id", Check::String),
        ("invitee_user_id", Check::String),
        ("updated", Check::NullableString),
    ],
    supports_soft_delete: false,
};

/// `SharingInvitationModel.toJSON()`.
pub fn invitation_to_json(row: &Row) -> Json {
    json!({
        "invitation_id": value_of(row, "invitation_id"),
        "inviter_user_id": value_of(row, "inviter_user_id"),
        "invitee_user_id": value_of(row, "invitee_user_id"),
    })
}

/// `sharing_user_ids(user)` answers the user and everyone in their sharing
/// group; every `shared_with` filter matches an owner column against it. Its
/// argument is always a statement parameter, so Postgres evaluates it once per
/// statement and still uses the owner column's index.
pub const CREATE_SHARING_USER_IDS_FUNCTION: &str = "CREATE OR REPLACE FUNCTION sharing_user_ids(viewer UUID) RETURNS UUID[]
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT array_append(
      ARRAY(
        SELECT peer.user_id FROM sharing_members peer
        WHERE peer.user_id <> viewer
          AND peer.group_id = (
            SELECT own.group_id FROM sharing_members own WHERE own.user_id = viewer
          )
      ),
      viewer
    )
  $$";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::js::Obj;

    #[test]
    fn rows_answer_their_public_fields() {
        let row: Obj = json!({ "user_id": "u", "group_id": "g", "updated": null }).as_object().cloned().unwrap();
        assert_eq!(member_to_json(&MEMBERS_TABLE.validate(row).unwrap()), json!({ "user_id": "u", "group_id": "g" }));
        let row: Obj = json!({ "invitation_id": "i", "inviter_user_id": "a", "invitee_user_id": "b", "updated": "2026-01-01T00:00:00.000Z" })
            .as_object()
            .cloned()
            .unwrap();
        assert_eq!(
            invitation_to_json(&INVITATIONS_TABLE.validate(row).unwrap()),
            json!({ "invitation_id": "i", "inviter_user_id": "a", "invitee_user_id": "b" })
        );
    }
}
