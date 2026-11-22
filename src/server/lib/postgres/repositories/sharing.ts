import {
  DEMO_USERNAME,
  SHARING_EMAIL_INVITATIONS,
  SHARING_INVITATIONS,
  SHARING_MEMBERS,
  TRANSACTIONS,
  TRANSACTION_PAIRS,
  USERS,
} from "common/constants";
import { pool, withTransaction } from "../client";
import { SHARING_MEMBERSHIP_LOCK_KEY, SHARING_USER_IDS, sharedWithSql } from "../database";
import {
  MaskedUser,
  QueryExecutor,
  SharingEmailInvitationModel,
  sharingEmailInvitationsTable,
  sharingInvitationsTable,
  sharingMembersTable,
  usersTable,
  EMAIL,
  EXPIRES_AT,
  GROUP_ID,
  INVITATION_ID,
  INVITEE_EMAIL,
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

/** How long an invitation sent to an email address stays open: 30 days. */
export const EMAIL_INVITATION_LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;

/** Whom an invitation went to: a user, or an email address nobody may have signed in with yet. */
export type SharingInvitee = MaskedUser | { email: string };

export interface SharingInvitation {
  invitation_id: string;
  inviter: MaskedUser;
  /**
   * The user it was sent to. One sent to an email address names the address
   * to the inviter's group, and names the user it reached to that user.
   */
  invitee: SharingInvitee;
  /** When an invitation sent to an email address lapses. One sent to a user never does. */
  expires_at?: string;
}

export interface Sharing {
  /** Everyone in the user's sharing group, the user included. Empty while they share with nobody. */
  members: MaskedUser[];
  /**
   * Unanswered invitations sent to the user or to their email address, or
   * sent by the user or anyone in their group.
   */
  invitations: SharingInvitation[];
}

export type SharingResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

/** Who an invitation or a membership change has to reach, for the events that follow it. */
interface Affected {
  affected_user_ids: string[];
}

const DEMO_REFUSAL = { ok: false, error: "The demo account can't share data." } as const;

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

/** An email invitation sent by the user `$1` names, or by anyone in their group. */
const EMAIL_INVITATION_FROM_GROUP = sharedWithSql(`e.${INVITER_USER_ID}`, "$1");

/** An email invitation sent to the address of the user `param` names, and not lapsed. */
const emailInvitationOpenTo = (param: string): string =>
  `(e.${INVITEE_EMAIL} = (SELECT lower(u.${EMAIL}) FROM ${USERS} u WHERE u.${USER_ID} = ${param})` +
  ` AND e.${EXPIRES_AT} > CURRENT_TIMESTAMP)`;

/**
 * An email invitation the user may withdraw, sent from their group, lapsed or
 * not; or one they may answer, open and sent to their address.
 */
const EMAIL_INVITATION_CONCERNS_USER = `(${EMAIL_INVITATION_FROM_GROUP} OR ${emailInvitationOpenTo("$1")})`;

type EmailInvitationRow = {
  invitation_id: string;
  invitee_email: string;
  expires_at: string;
  inviter_user_id: string;
  inviter_username: string;
  /** Sent from the reader's group. Otherwise it was sent to the reader's address. */
  sent: boolean;
};

/** Only the inviter's group learns the address; the user it reached sees it addressed to them. */
const toEmailInvitation =
  (reader: MaskedUser) =>
  (row: EmailInvitationRow): SharingInvitation => ({
    invitation_id: row.invitation_id,
    inviter: { user_id: row.inviter_user_id, username: row.inviter_username },
    invitee: row.sent
      ? { email: row.invitee_email }
      : { user_id: reader.user_id, username: reader.username },
    expires_at: row.expires_at,
  });

/** Sharing changes are rare, and one lock for all of them keeps every membership check race-free. */
const lockSharing = (client: QueryExecutor): Promise<unknown> =>
  client.query(`SELECT pg_advisory_xact_lock(${SHARING_MEMBERSHIP_LOCK_KEY})`);

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
  const [members, invitations, emailInvitations] = await Promise.all([
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
    pool.query<EmailInvitationRow>(
      `SELECT e.${INVITATION_ID}, e.${INVITEE_EMAIL}, e.${EXPIRES_AT},
              inviter.${USER_ID} AS inviter_user_id, inviter.${USERNAME} AS inviter_username,
              ${EMAIL_INVITATION_FROM_GROUP} AS sent
       FROM ${SHARING_EMAIL_INVITATIONS} e
       JOIN ${USERS} inviter ON inviter.${USER_ID} = e.${INVITER_USER_ID}
       WHERE ${EMAIL_INVITATION_CONCERNS_USER}
       ORDER BY e.${INVITEE_EMAIL}, e.${INVITATION_ID}`,
      [user.user_id],
    ),
  ]);
  return {
    members: members.rows.map(({ user_id, username }) => ({ user_id, username })),
    invitations: [
      ...invitations.rows.map(toInvitation),
      ...emailInvitations.rows.map(toEmailInvitation(user)),
    ],
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
): Promise<SharingResult<{ invitation: SharingInvitation & { invitee: MaskedUser } }>> => {
  if (user.username === DEMO_USERNAME || username === DEMO_USERNAME) return DEMO_REFUSAL;
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
 * Invites whoever signs in with `email` to share data: the user who has that
 * address now, or one who signs up with it before the invitation lapses. It
 * answers alike whether anyone has the address yet, so it can't be used to
 * learn who has an account. Inviting an address again keeps the invitation
 * and restarts its time. `invitee_user_id` names the user who has the
 * address, for the event that tells them; it never goes back to the inviter.
 */
export const inviteByEmail = async (
  user: MaskedUser,
  email: string,
): Promise<SharingResult<{ invitation: SharingInvitation; invitee_user_id?: string }>> => {
  if (user.username === DEMO_USERNAME) return DEMO_REFUSAL;
  const invitee_email = email.trim().toLowerCase();

  const [holder] = await usersTable.query(
    {},
    { equalsIgnoringCase: { column: EMAIL, value: invitee_email }, limit: 1 },
  );
  if (holder?.user_id === user.user_id) return { ok: false, error: "You can't invite yourself." };
  if (holder) {
    const groupIds = await getSharingUserIds(user.user_id);
    if (groupIds.includes(holder.user_id)) {
      return { ok: false, error: `You already share data with ${holder.username}.` };
    }
  }

  const expires_at = new Date(Date.now() + EMAIL_INVITATION_LIFETIME_MS).toISOString();
  const row = await sharingEmailInvitationsTable.upsert(
    { [INVITER_USER_ID]: user.user_id, [INVITEE_EMAIL]: invitee_email, [EXPIRES_AT]: expires_at },
    [EXPIRES_AT],
    undefined,
    { conflictColumns: [INVITER_USER_ID, INVITEE_EMAIL] },
  );
  // A conflict updates the row, so the statement always answers one.
  const invitation = new SharingEmailInvitationModel(row);
  return {
    ok: true,
    invitation: {
      invitation_id: invitation.invitation_id,
      inviter: { user_id: user.user_id, username: user.username },
      invitee: { email: invitation.invitee_email },
      expires_at: invitation.expires_at,
    },
    invitee_user_id: holder?.user_id,
  };
};

/**
 * Declines an invitation sent to the user or to their address, or withdraws
 * one the user or anyone in their group sent. Answers who it was between, or
 * `undefined` when the user has no such invitation. An email invitation is
 * between its inviter and whoever has the address, when anyone does.
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
  if (row) return { affected_user_ids: [row.inviter_user_id, row.invitee_user_id] };

  const emailResult = await pool.query<{ inviter_user_id: string; invitee_user_id: string | null }>(
    `DELETE FROM ${SHARING_EMAIL_INVITATIONS} e
     WHERE e.${INVITATION_ID} = $2 AND ${EMAIL_INVITATION_CONCERNS_USER}
     RETURNING e.${INVITER_USER_ID},
       (SELECT u.${USER_ID} FROM ${USERS} u WHERE lower(u.${EMAIL}) = e.${INVITEE_EMAIL}) AS invitee_user_id`,
    [user.user_id, invitation_id],
  );
  const emailRow = emailResult.rows[0];
  if (!emailRow) return undefined;
  const { inviter_user_id, invitee_user_id } = emailRow;
  return { affected_user_ids: invitee_user_id ? [inviter_user_id, invitee_user_id] : [inviter_user_id] };
};

/**
 * Accepts an invitation sent to the user or to their address: they join the
 * inviter's sharing group, which is created when the inviter shared with
 * nobody yet. From then on every member reads and writes every other
 * member's data.
 */
export const acceptSharingInvitation = async (
  user: MaskedUser,
  invitation_id: string,
): Promise<SharingResult<Affected>> => {
  if (user.username === DEMO_USERNAME) return DEMO_REFUSAL;
  return withTransaction(async (client) => {
    await lockSharing(client);

    // An address that has since become the inviter's own can't join them to themself.
    const invitation = await client.query<{ inviter_user_id: string }>(
      `SELECT ${INVITER_USER_ID} FROM ${SHARING_INVITATIONS}
       WHERE ${INVITATION_ID} = $1 AND ${INVITEE_USER_ID} = $2
       UNION ALL
       SELECT e.${INVITER_USER_ID} FROM ${SHARING_EMAIL_INVITATIONS} e
       WHERE e.${INVITATION_ID} = $1 AND e.${INVITER_USER_ID} <> $2 AND ${emailInvitationOpenTo("$2")}`,
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

    // The accepted invitation, and any other between two people who now
    // share, whether it named the user or their address.
    await client.query(
      `DELETE FROM ${SHARING_INVITATIONS} i
       USING ${SHARING_MEMBERS} inviter, ${SHARING_MEMBERS} invitee
       WHERE inviter.${USER_ID} = i.${INVITER_USER_ID}
         AND invitee.${USER_ID} = i.${INVITEE_USER_ID}
         AND inviter.${GROUP_ID} = $1
         AND invitee.${GROUP_ID} = $1`,
      [group_id],
    );
    await client.query(
      `DELETE FROM ${SHARING_EMAIL_INVITATIONS} e
       USING ${SHARING_MEMBERS} inviter, ${SHARING_MEMBERS} invitee, ${USERS} u
       WHERE inviter.${USER_ID} = e.${INVITER_USER_ID}
         AND u.${USER_ID} = invitee.${USER_ID}
         AND lower(u.${EMAIL}) = e.${INVITEE_EMAIL}
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
