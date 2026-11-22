import { TableName } from "common";
import {
  Route,
  emitToSharingGroup,
  emitToUser,
  inviteToShare,
  originTabPayload,
  requireBodyObject,
  requireStringField,
  validationError,
} from "server";
import type { SharingInvitation } from "server";

export interface SharingInvitationPostResponse {
  invitation: SharingInvitation;
}

/** `POST /sharing/invitation { username }` invites that user to share data with the caller's group. */
export const postSharingInvitationRoute = new Route<SharingInvitationPostResponse>(
  "POST",
  "/sharing/invitation",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };

    const bodyResult = requireBodyObject(req);
    if (!bodyResult.success) return validationError(bodyResult.error!);
    const usernameResult = requireStringField(bodyResult.data as Record<string, unknown>, "username");
    if (!usernameResult.success) return validationError(usernameResult.error!);

    const result = await inviteToShare(user, usernameResult.data!.trim());
    if (!result.ok) return { status: "failed", message: result.error };

    const payload = originTabPayload(req.headers);
    void emitToSharingGroup(user.user_id, TableName.SharingInvitations, payload);
    emitToUser(result.invitation.invitee.user_id, TableName.SharingInvitations, payload);
    return { status: "success", body: { invitation: result.invitation } };
  },
);
