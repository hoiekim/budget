import { TableName } from "common";
import {
  Route,
  emitToSharingGroup,
  emitToUser,
  inviteByEmail,
  inviteToShare,
  isEmailAddress,
  originTabPayload,
  requireBodyObject,
  requireStringField,
  validateFields,
  validationError,
} from "server";
import type { SharingInvitation } from "server";

export interface SharingInvitationPostResponse {
  invitation: SharingInvitation;
}

/**
 * `POST /sharing/invitation { username }` invites that user to share data
 * with the caller's group. `{ email }` invites whoever signs in with that
 * address, now or before the invitation lapses, and answers alike whether
 * anyone has the address yet.
 */
export const postSharingInvitationRoute = new Route<SharingInvitationPostResponse>(
  "POST",
  "/sharing/invitation",
  async (req) => {
    const { user } = req.session;
    if (!user) return { status: "failed", message: "Request user is not authenticated." };

    const bodyResult = requireBodyObject(req);
    if (!bodyResult.success) return validationError(bodyResult.error!);
    const body = bodyResult.data as Record<string, unknown>;
    const payload = originTabPayload(req.headers);

    if (body.email !== undefined) {
      const emailResult = requireStringField(body, "email");
      if (!emailResult.success) return validationError(emailResult.error!);
      // Measured as it is stored: lower case can be longer ("İ" becomes two units).
      const email = emailResult.data!.trim().toLowerCase();
      const lengthCheck = validateFields({ email }, [
        { path: "email", type: "string", maxLength: 255 },
      ]);
      if (!lengthCheck.success) return validationError(lengthCheck.error!);
      if (!isEmailAddress(email)) return validationError("Field email must be an email address");

      const result = await inviteByEmail(user, email);
      if (!result.ok) return { status: "failed", message: result.error };

      void emitToSharingGroup(user.user_id, TableName.SharingInvitations, payload);
      if (result.invitee_user_id) {
        emitToUser(result.invitee_user_id, TableName.SharingInvitations, payload);
      }
      return { status: "success", body: { invitation: result.invitation } };
    }

    const usernameResult = requireStringField(body, "username");
    if (!usernameResult.success) return validationError(usernameResult.error!);

    const result = await inviteToShare(user, usernameResult.data!.trim());
    if (!result.ok) return { status: "failed", message: result.error };

    void emitToSharingGroup(user.user_id, TableName.SharingInvitations, payload);
    emitToUser(result.invitation.invitee.user_id, TableName.SharingInvitations, payload);
    return { status: "success", body: { invitation: result.invitation } };
  },
);
