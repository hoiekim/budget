import { isString, isNullableString } from "common";
import { SHARING_INVITATIONS, SHARING_MEMBERS, USERS } from "common/constants";
import { SHARING_USER_IDS } from "../database";
import {
  GROUP_ID,
  INVITATION_ID,
  INVITEE_USER_ID,
  INVITER_USER_ID,
  UPDATED,
  USER_ID,
} from "./common";

import { Model, RowValueType, createTable } from "./base";

export interface JSONSharingMember {
  user_id: string;
  group_id: string;
}

/**
 * Who shares data with whom. The members of one group read and write each
 * other's rows as their own. A user is in at most one group (the primary
 * key), and a group never has fewer than two members.
 */
const sharingMemberSchema = {
  [USER_ID]: `UUID PRIMARY KEY REFERENCES ${USERS}(${USER_ID}) ON DELETE CASCADE`,
  [GROUP_ID]: "UUID NOT NULL",
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type SharingMemberSchema = typeof sharingMemberSchema;
type SharingMemberRow = { [k in keyof SharingMemberSchema]: RowValueType };

export class SharingMemberModel
  extends Model<JSONSharingMember, SharingMemberSchema>
  implements SharingMemberRow
{
  declare user_id: string;
  declare group_id: string;
  declare updated: string | null;

  static typeChecker = {
    user_id: isString,
    group_id: isString,
    updated: isNullableString,
  };

  constructor(data: unknown) {
    super(data, SharingMemberModel.typeChecker);
  }

  toJSON(): JSONSharingMember {
    return { user_id: this.user_id, group_id: this.group_id };
  }
}

export const sharingMembersTable = createTable({
  name: SHARING_MEMBERS,
  primaryKey: USER_ID,
  schema: sharingMemberSchema,
  indexes: [{ column: GROUP_ID }],
  ModelClass: SharingMemberModel,
  supportsSoftDelete: false,
});

export interface JSONSharingInvitationRow {
  invitation_id: string;
  inviter_user_id: string;
  invitee_user_id: string;
}

/** An offer to share data that the invitee has not answered yet. Answering it deletes the row. */
const sharingInvitationSchema = {
  [INVITATION_ID]: "UUID PRIMARY KEY DEFAULT gen_random_uuid()",
  [INVITER_USER_ID]: `UUID NOT NULL REFERENCES ${USERS}(${USER_ID}) ON DELETE CASCADE`,
  [INVITEE_USER_ID]: `UUID NOT NULL REFERENCES ${USERS}(${USER_ID}) ON DELETE CASCADE`,
  [UPDATED]: "TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP",
};

type SharingInvitationSchema = typeof sharingInvitationSchema;
type SharingInvitationRow = { [k in keyof SharingInvitationSchema]: RowValueType };

export class SharingInvitationModel
  extends Model<JSONSharingInvitationRow, SharingInvitationSchema>
  implements SharingInvitationRow
{
  declare invitation_id: string;
  declare inviter_user_id: string;
  declare invitee_user_id: string;
  declare updated: string | null;

  static typeChecker = {
    invitation_id: isString,
    inviter_user_id: isString,
    invitee_user_id: isString,
    updated: isNullableString,
  };

  constructor(data: unknown) {
    super(data, SharingInvitationModel.typeChecker);
  }

  toJSON(): JSONSharingInvitationRow {
    return {
      invitation_id: this.invitation_id,
      inviter_user_id: this.inviter_user_id,
      invitee_user_id: this.invitee_user_id,
    };
  }
}

export const sharingInvitationsTable = createTable({
  name: SHARING_INVITATIONS,
  primaryKey: INVITATION_ID,
  schema: sharingInvitationSchema,
  constraints: [
    `CONSTRAINT sharing_invitations_pair_unique UNIQUE (${INVITER_USER_ID}, ${INVITEE_USER_ID})`,
  ],
  indexes: [{ column: INVITEE_USER_ID }],
  ModelClass: SharingInvitationModel,
  supportsSoftDelete: false,
});

/**
 * `sharing_user_ids(user)` answers the user and everyone in their sharing
 * group; every `sharedWith` filter matches an owner column against it. Its
 * argument is always a statement parameter, so Postgres evaluates it once per
 * statement and still uses the owner column's index.
 */
export const CREATE_SHARING_USER_IDS_FUNCTION = `
  CREATE OR REPLACE FUNCTION ${SHARING_USER_IDS}(viewer UUID) RETURNS UUID[]
  LANGUAGE sql STABLE PARALLEL SAFE AS $$
    SELECT array_append(
      ARRAY(
        SELECT peer.${USER_ID} FROM ${SHARING_MEMBERS} peer
        WHERE peer.${USER_ID} <> viewer
          AND peer.${GROUP_ID} = (
            SELECT own.${GROUP_ID} FROM ${SHARING_MEMBERS} own WHERE own.${USER_ID} = viewer
          )
      ),
      viewer
    )
  $$
`.trim();
