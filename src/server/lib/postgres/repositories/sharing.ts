import {
  DEMO_USERNAME,
  SHARING_INVITATIONS,
  SHARING_MEMBERS,
  TRANSACTIONS,
  TRANSACTION_PAIRS,
  USERS,
} from "common/constants";
import { pool, withTransaction } from "../client";
import { SHARING_USER_IDS, sharedWithSql } from "../database";
import {
  MaskedUser,
  QueryExecutor,
  sharingInvitationsTable,
  sharingMembersTable,
  usersTable,
  GROUP_ID,
  INVITATION_ID,
  INVITEE_USER_ID,
  INVITER_USER_ID,
  IS_DELETED,
  TRANSACTION_ID,
  TRANSACTION_ID_A,
  TRANSACTION_ID_B,
  UPDATED,
  USERNAME,
  USER_ID,
} from "../models";

export interface SharingInvitation {
  invitation_id: string;
  inviter: MaskedUser;
  invitee: MaskedUser;
}

export interface Sharing {
  /** Everyone in the user's sharing group, the user included. Empty while they share with nobody. */
  members: MaskedUser[];
  /** Unanswered invitations sent to the user, or sent by the user or anyone in their group. */
  invitations: SharingInvitation[];
}

export type SharingResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Who an invitation or a membership change has to reach, for the events that follow it. */
interface Affected {
  affected_user_ids: string[];
}

type InvitationRow = {
  invitation_id: string;
  inviter_user_id: string;
  inviter_username: string;
  invitee_user_id: string;
  invitee_username: string;
};

const toInvitation = (row: InvitationRow): SharingInvitation => ({
  invitation_id: row.invitation_id,
  inviter: { user_id: row.inviter_user_id, username: row.inviter_username },
  invitee: { user_id: row.invitee_user_id, username: row.invitee_username },
});

const SELECT_INVITATIONS = `
  SELECT i.${INVITATION_ID},
         inviter.${USER_ID} AS inviter_user_id, inviter.${USERNAME} AS inviter_username,
         invitee.${USER_ID} AS invitee_user_id, invitee.${USERNAME} AS invitee_username
  FROM ${SHARING_INVITATIONS} i
  JOIN ${USERS} inviter ON inviter.${USER_ID} = i.${INVITER_USER_ID}
  JOIN ${USERS} invitee ON invitee.${USER_ID} = i.${INVITEE_USER_ID}`;

/** An invitation the user may answer or withdraw: sent to them, or sent from their group. */
const INVITATION_CONCERNS_USER = `(i.${INVITEE_USER_ID} = $1 OR ${sharedWithSql(`i.${INVITER_USER_ID}`, "$1")})`;

/** Sharing changes are rare, and one lock for all of them keeps every membership check race-free. */
const lockSharing = (client: QueryExecutor): Promise<unknown> =>
  client.query(`SELECT pg_advisory_xact_lock(hashtext('sharing'))`);

/** The user and everyone in their sharing group. */
export const getSharingUserIds = async (
  user_id: string,
  client: QueryExecutor = pool,
): Promise<string[]> => {
  const result = await client.query<{ user_id: string }>(
    `SELECT unnest(${SHARING_USER_IDS}($1)) AS ${USER_ID}`,
    [user_id],
  );
  return result.rows.map((row) => row.user_id);
};

export const getSharing = async (user: MaskedUser): Promise<Sharing> => {
  const [members, invitations] = await Promise.all([
    pool.query<MaskedUser>(
      `SELECT u.${USER_ID}, u.${USERNAME}
       FROM ${SHARING_MEMBERS} m
       JOIN ${USERS} u ON u.${USER_ID} = m.${USER_ID}
       WHERE m.${GROUP_ID} = (
         SELECT own.${GROUP_ID} FROM ${SHARING_MEMBERS} own WHERE own.${USER_ID} = $1
       )
       ORDER BY u.${USERNAME}`,
      [user.user_id],
    ),
    pool.query<InvitationRow>(
      `${SELECT_INVITATIONS}
       WHERE ${INVITATION_CONCERNS_USER}
       ORDER BY invitee.${USERNAME}, i.${INVITATION_ID}`,
      [user.user_id],
    ),
  ]);
  return {
    members: members.rows.map(({ user_id, username }) => ({ user_id, username })),
    invitations: invitations.rows.map(toInvitation),
  };
};

/**
 * The owner of a row the user may act on: the user or someone in their
 * sharing group. `undefined` when the row is deleted, missing, or belongs to
 * anyone else. A row written under a parent row takes the parent's owner, so
 * that a connection or a budget leaves a sharing group with everything in it.
 */
export const getRowOwner = async (
  user: MaskedUser,
  table: { name: string; primaryKey: string; supportsSoftDelete: boolean },
  id: string,
): Promise<MaskedUser | undefined> => {
  const live = table.supportsSoftDelete
    ? ` AND (r.${IS_DELETED} IS NULL OR r.${IS_DELETED} = FALSE)`
    : "";
  const result = await pool.query<MaskedUser>(
    `SELECT u.${USER_ID}, u.${USERNAME}
     FROM ${table.name} r
     JOIN ${USERS} u ON u.${USER_ID} = r.${USER_ID}
     WHERE r.${table.primaryKey} = $1 AND ${sharedWithSql(`r.${USER_ID}`, "$2")}${live}`,
    [id, user.user_id],
  );
  const owner = result.rows[0];
  return owner && { user_id: owner.user_id, username: owner.username };
};

/**
 * Invites the user `username` names to share data. Inviting someone twice
 * answers with the invitation that is already open.
 */
export const inviteToShare = async (
  user: MaskedUser,
  username: string,
): Promise<SharingResult<{ invitation: SharingInvitation }>> => {
  if (user.username === DEMO_USERNAME || username === DEMO_USERNAME) {
    return { ok: false, error: "The demo account can't share data." };
  }
  const invitee = await usersTable.queryOne({ [USERNAME]: username });
  if (!invitee) return { ok: false, error: "No user has that username." };
  if (invitee.user_id === user.user_id) return { ok: false, error: "You can't invite yourself." };

  const groupIds = await getSharingUserIds(user.user_id);
  if (groupIds.includes(invitee.user_id)) {
    return { ok: false, error: `You already share data with ${invitee.username}.` };
  }

  const crossing = await sharingInvitationsTable.queryOne({
    [INVITER_USER_ID]: invitee.user_id,
    [INVITEE_USER_ID]: user.user_id,
  });
  if (crossing) {
    return { ok: false, error: `${invitee.username} already invited you. Accept that invitation.` };
  }

  await sharingInvitationsTable.insert(
    { [INVITER_USER_ID]: user.user_id, [INVITEE_USER_ID]: invitee.user_id },
    [INVITATION_ID],
    { onConflictDoNothing: true },
  );
  const [invitation] = await sharingInvitationsTable.query({
    [INVITER_USER_ID]: user.user_id,
    [INVITEE_USER_ID]: invitee.user_id,
  });
  if (!invitation) throw new Error("The invitation was withdrawn while it was being sent.");
  return {
    ok: true,
    invitation: {
      invitation_id: invitation.invitation_id,
      inviter: { user_id: user.user_id, username: user.username },
      invitee: invitee.toMaskedUser(),
    },
  };
};

/**
 * Declines an invitation sent to the user, or withdraws one the user or
 * anyone in their group sent. Answers the two people it was between, or
 * `undefined` when the user has no such invitation.
 */
export const deleteSharingInvitation = async (
  user: MaskedUser,
  invitation_id: string,
): Promise<Affected | undefined> => {
  const result = await pool.query<{ inviter_user_id: string; invitee_user_id: string }>(
    `DELETE FROM ${SHARING_INVITATIONS} i
     WHERE i.${INVITATION_ID} = $2 AND ${INVITATION_CONCERNS_USER}
     RETURNING i.${INVITER_USER_ID}, i.${INVITEE_USER_ID}`,
    [user.user_id, invitation_id],
  );
  const row = result.rows[0];
  return row && { affected_user_ids: [row.inviter_user_id, row.invitee_user_id] };
};

/**
 * Accepts an invitation sent to the user: they join the inviter's sharing
 * group, which is created when the inviter shared with nobody yet. From then
 * on every member reads and writes every other member's data.
 */
export const acceptSharingInvitation = async (
  user: MaskedUser,
  invitation_id: string,
): Promise<SharingResult<Affected>> => {
  if (user.username === DEMO_USERNAME) {
    return { ok: false, error: "The demo account can't share data." };
  }
  return withTransaction(async (client) => {
    await lockSharing(client);

    const invitation = await client.query<{ inviter_user_id: string }>(
      `SELECT ${INVITER_USER_ID} FROM ${SHARING_INVITATIONS}
       WHERE ${INVITATION_ID} = $1 AND ${INVITEE_USER_ID} = $2`,
      [invitation_id, user.user_id],
    );
    if (invitation.rows.length === 0) {
      return { ok: false, error: "That invitation is no longer open." };
    }
    const { inviter_user_id } = invitation.rows[0];

    const memberships = await sharingMembersTable.query(
      {},
      { inFilters: { [USER_ID]: [user.user_id, inviter_user_id] } },
      client,
    );
    const groupOf = new Map(memberships.map((m) => [m.user_id, m.group_id]));
    if (groupOf.has(user.user_id)) {
      return { ok: false, error: "Stop sharing with your current group before joining another." };
    }

    const group_id = groupOf.get(inviter_user_id) ?? crypto.randomUUID();
    await sharingMembersTable.upsertMany(
      [
        { [USER_ID]: inviter_user_id, [GROUP_ID]: group_id },
        { [USER_ID]: user.user_id, [GROUP_ID]: group_id },
      ],
      [],
      client,
    );

    // The accepted invitation, and any other between two people who now share.
    await client.query(
      `DELETE FROM ${SHARING_INVITATIONS} i
       USING ${SHARING_MEMBERS} inviter, ${SHARING_MEMBERS} invitee
       WHERE inviter.${USER_ID} = i.${INVITER_USER_ID}
         AND invitee.${USER_ID} = i.${INVITEE_USER_ID}
         AND inviter.${GROUP_ID} = $1
         AND invitee.${GROUP_ID} = $1`,
      [group_id],
    );

    return { ok: true, affected_user_ids: await getSharingUserIds(user.user_id, client) };
  });
};

/**
 * Takes `member_user_id` out of the user's sharing group: the user leaving,
 * or the user removing someone else. Everyone keeps the rows they own. A
 * group left with one member is dissolved, and a transfer pair with one side
 * on each side of the split is deleted the way a pair is when one of its
 * transactions is, since neither side could see or replace it any more.
 */
export const removeSharingMember = async (
  user: MaskedUser,
  member_user_id: string,
): Promise<SharingResult<Affected>> =>
  withTransaction(async (client) => {
    await lockSharing(client);

    const former = await getSharingUserIds(user.user_id, client);
    if (former.length < 2 || !former.includes(member_user_id)) {
      return { ok: false, error: "You don't share data with that user." };
    }

    const leaving = former.length === 2 ? former : [member_user_id];
    await client.query(`DELETE FROM ${SHARING_MEMBERS} WHERE ${USER_ID} = ANY($1::uuid[])`, [
      leaving,
    ]);

    await client.query(
      `UPDATE ${TRANSACTION_PAIRS} pair
       SET ${IS_DELETED} = TRUE, ${UPDATED} = CURRENT_TIMESTAMP
       FROM ${TRANSACTIONS} a, ${TRANSACTIONS} b
       WHERE a.${TRANSACTION_ID} = pair.${TRANSACTION_ID_A}
         AND b.${TRANSACTION_ID} = pair.${TRANSACTION_ID_B}
         AND pair.${USER_ID} = ANY($1::uuid[])
         AND (pair.${IS_DELETED} IS NULL OR pair.${IS_DELETED} = FALSE)
         AND (a.${USER_ID} = $2) <> (b.${USER_ID} = $2)`,
      [former, member_user_id],
    );

    return { ok: true, affected_user_ids: former };
  });
