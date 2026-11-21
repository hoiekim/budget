import { TableName } from "common";
import {
  Route,
  acceptSharingInvitation,
  emitToUser,
  originTabPayload,
  requireBodyObject,
  requireStringField,
  validateFields,
  validationError,
} from "server";

/**
 * `POST /sharing/member { invitation_id }` accepts an invitation sent to the
 * caller, who joins the inviter's sharing group.
 */
export const postSharingMemberRoute = new Route("POST", "/sharing/member", async (req) => {
  const { user } = req.session;
  if (!user) return { status: "failed", message: "Request user is not authenticated." };

  const bodyResult = requireBodyObject(req);
  if (!bodyResult.success) return validationError(bodyResult.error!);
  const body = bodyResult.data as Record<string, unknown>;
  const idResult = requireStringField(body, "invitation_id");
  if (!idResult.success) return validationError(idResult.error!);
  const idCheck = validateFields(body, [{ path: "invitation_id", type: "uuid", required: true }]);
  if (!idCheck.success) return validationError(idCheck.error!);

  const result = await acceptSharingInvitation(user, idResult.data!);
  if (!result.ok) return { status: "failed", message: result.error };

  const payload = originTabPayload(req.headers);
  for (const user_id of result.affected_user_ids) {
    emitToUser(user_id, TableName.SharingMembers, payload);
  }
  return { status: "success" };
});
