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

/// An offer to share data sent to an email address rather than to a user, so
/// it reaches whoever signs in with that address, now or later. The address
/// is stored in lower case. The offer lapses at `expires_at`, so an address
/// that changes hands long after it was sent doesn't carry it to the next
/// holder. Answering it deletes the row.
pub static EMAIL_INVITATIONS_TABLE: Table = Table {
    name: "sharing_email_invitations",
    primary_key: "invitation_id",
    schema: &[
        ("invitation_id", "UUID PRIMARY KEY DEFAULT gen_random_uuid()"),
        ("inviter_user_id", "UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE"),
        ("invitee_email", "VARCHAR(255) NOT NULL"),
        ("expires_at", "TIMESTAMPTZ NOT NULL"),
        ("updated", "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP"),
    ],
    constraints: &["CONSTRAINT sharing_email_invitations_pair_unique UNIQUE (inviter_user_id, invitee_email)"],
    indexes: &[IndexDefinition::column("invitee_email")],
    model: "SharingEmailInvitationModel",
    checks: &[
        ("invitation_id", Check::String),
        ("inviter_user_id", Check::String),
        ("invitee_email", Check::String),
        ("expires_at", Check::String),
        ("updated", Check::NullableString),
    ],
    supports_soft_delete: false,
};

/// `SharingEmailInvitationModel.toJSON()`.
pub fn email_invitation_to_json(row: &Row) -> Json {
    json!({
        "invitation_id": value_of(row, "invitation_id"),
        "inviter_user_id": value_of(row, "inviter_user_id"),
        "invitee_email": value_of(row, "invitee_email"),
        "expires_at": value_of(row, "expires_at"),
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

    // `sharing.test.ts`, "sharingEmailInvitationsTable" and "SharingEmailInvitationModel".

    use super::super::base::ModelValidationError;
    use super::super::base_test::FakeExecutor;
    use super::super::js_object::testing::obj;
    use crate::server::postgres::database::build_create_table;

    fn email_invitation_row(overrides: Json) -> Obj {
        let mut row = obj(json!({
            "invitation_id": "inv-e1",
            "inviter_user_id": "u-1",
            "invitee_email": "friend@example.com",
            "expires_at": "2026-12-22T00:00:00.000Z",
            "updated": "2026-11-22T00:00:00.000Z",
        }));
        row.extend(obj(overrides));
        row
    }

    /// The statement with its whitespace runs collapsed, as the TypeScript tests' `flat` reads it.
    fn flat(sql: &str) -> String {
        sql.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    #[test]
    fn the_email_invitations_table_is_keyed_on_a_generated_id_and_holds_one_invitation_per_inviter_and_address() {
        let table = &EMAIL_INVITATIONS_TABLE;
        assert_eq!(table.name, "sharing_email_invitations");
        assert_eq!(table.primary_key, "invitation_id");
        assert_eq!(table.constraints, ["CONSTRAINT sharing_email_invitations_pair_unique UNIQUE (inviter_user_id, invitee_email)"]);
        assert_eq!(
            flat(&build_create_table(table.name, table.schema, table.constraints)),
            "CREATE TABLE IF NOT EXISTS sharing_email_invitations ( \
             invitation_id UUID PRIMARY KEY DEFAULT gen_random_uuid(), \
             inviter_user_id UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE, \
             invitee_email VARCHAR(255) NOT NULL, \
             expires_at TIMESTAMPTZ NOT NULL, \
             updated TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP, \
             CONSTRAINT sharing_email_invitations_pair_unique UNIQUE (inviter_user_id, invitee_email) )"
        );
    }

    #[test]
    fn the_email_invitations_table_indexes_the_address_since_the_unique_constraint_serves_lookups_by_inviter() {
        let [index] = EMAIL_INVITATIONS_TABLE.indexes else { panic!("expected one index") };
        assert!(matches!(index.key, super::super::IndexKey::Column("invitee_email")));
        assert!(!index.unique && index.predicate.is_none());
    }

    #[tokio::test]
    async fn the_email_invitations_table_has_no_is_deleted_column_and_reads_carry_no_soft_delete_predicate() {
        assert!(!EMAIL_INVITATIONS_TABLE.supports_soft_delete);
        assert_eq!(EMAIL_INVITATIONS_TABLE.columns(), ["invitation_id", "inviter_user_id", "invitee_email", "expires_at", "updated"]);

        let executor = FakeExecutor::default();
        EMAIL_INVITATIONS_TABLE
            .query(crate::filters! { "inviter_user_id" => "u-1" }, Default::default(), Some(&executor))
            .await
            .unwrap();
        assert_eq!(executor.calls()[0].0, "SELECT * FROM sharing_email_invitations WHERE inviter_user_id = $1");
    }

    #[tokio::test]
    async fn an_email_invitation_upsert_finds_the_row_by_inviter_and_address_and_rewrites_only_what_it_is_told_to() {
        let executor = FakeExecutor::default();
        let data = obj(json!({
            "inviter_user_id": "u-1",
            "invitee_email": "friend@example.com",
            "expires_at": "2026-12-22T00:00:00.000Z",
        }));
        EMAIL_INVITATIONS_TABLE
            .upsert(&data, Some(&["expires_at"]), Some(&executor), Some(&["inviter_user_id", "invitee_email"]))
            .await
            .unwrap();
        let calls = executor.calls();
        assert_eq!(
            calls[0].0,
            "INSERT INTO sharing_email_invitations (updated, inviter_user_id, invitee_email, expires_at) \
             VALUES (CURRENT_TIMESTAMP, $1, $2, $3) \
             ON CONFLICT (inviter_user_id, invitee_email) \
             DO UPDATE SET expires_at = EXCLUDED.expires_at, updated = CURRENT_TIMESTAMP RETURNING *"
        );
        assert_eq!(calls[0].1, vec![json!("u-1"), json!("friend@example.com"), json!("2026-12-22T00:00:00.000Z")]);
    }

    #[test]
    fn an_email_invitation_answers_the_id_the_inviter_the_address_and_the_lapse_time_and_drops_the_timestamp() {
        let invitation = EMAIL_INVITATIONS_TABLE.validate(email_invitation_row(json!({}))).unwrap();
        assert_eq!(
            email_invitation_to_json(&invitation),
            json!({
                "invitation_id": "inv-e1",
                "inviter_user_id": "u-1",
                "invitee_email": "friend@example.com",
                "expires_at": "2026-12-22T00:00:00.000Z",
            })
        );
        assert_eq!(invitation.get("updated"), Some(&json!("2026-11-22T00:00:00.000Z")));
    }

    #[test]
    fn an_email_invitation_row_with_a_malformed_column_is_refused_naming_each_one() {
        let error = EMAIL_INVITATIONS_TABLE.validate(email_invitation_row(json!({ "invitee_email": null, "expires_at": 3 }))).unwrap_err();
        let error = error.downcast_ref::<ModelValidationError>().unwrap();
        assert_eq!(error.errors, ["invitee_email: null (object)", "expires_at: 3 (number)"]);
    }
}
