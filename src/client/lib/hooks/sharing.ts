import { useCallback } from "react";
import { TableName } from "common";
import type { SharingInvitationPostResponse } from "server";
import { call, useSync } from "client";

/**
 * Every action answers `undefined` once the server has done it, or the
 * reason it refused. The tab that acts refetches for itself; the server's
 * event reaches everyone else the change concerns.
 */
export interface SharingActions {
  /** Invite the user `username` names to share data. */
  invite: (username: string) => Promise<string | undefined>;
  /** Accept an invitation: both sides see and edit each other's data from then on. */
  accept: (invitation_id: string) => Promise<string | undefined>;
  /** Decline an invitation received, or withdraw one sent. */
  dismiss: (invitation_id: string) => Promise<string | undefined>;
  /** Stop sharing with a member of the group, or leave it by naming oneself. */
  remove: (user_id: string) => Promise<string | undefined>;
}

const FALLBACK_MESSAGE = "Something went wrong. Try again.";

export const useSharing = (): SharingActions => {
  const { sync, syncDomain } = useSync();

  const invite = useCallback(
    async (username: string) => {
      const r = await call.post<SharingInvitationPostResponse>("/api/sharing/invitation", {
        username,
      });
      if (r.status !== "success") return r.message ?? FALLBACK_MESSAGE;
      syncDomain(TableName.SharingInvitations);
      return undefined;
    },
    [syncDomain],
  );

  const dismiss = useCallback(
    async (invitation_id: string) => {
      const r = await call.delete(`/api/sharing/invitation?id=${encodeURIComponent(invitation_id)}`);
      // An invitation someone else already answered is gone either way.
      syncDomain(TableName.SharingInvitations);
      return r.status === "success" ? undefined : (r.message ?? FALLBACK_MESSAGE);
    },
    [syncDomain],
  );

  const accept = useCallback(
    async (invitation_id: string) => {
      const r = await call.post("/api/sharing/member", { invitation_id });
      if (r.status !== "success") {
        syncDomain(TableName.SharingInvitations);
        return r.message ?? FALLBACK_MESSAGE;
      }
      sync();
      return undefined;
    },
    [sync, syncDomain],
  );

  const remove = useCallback(
    async (user_id: string) => {
      const r = await call.delete(`/api/sharing/member?user_id=${encodeURIComponent(user_id)}`);
      sync();
      return r.status === "success" ? undefined : (r.message ?? FALLBACK_MESSAGE);
    },
    [sync],
  );

  return { invite, accept, dismiss, remove };
};
