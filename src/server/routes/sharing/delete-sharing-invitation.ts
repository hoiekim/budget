import { TableName } from "common";
import {
  Route,
  deleteSharingInvitation,
  emitToSharingGroup,
  originTabPayload,
  requireQueryString,
  validateFields,
  validationError,
} from "server";

/**
 * `DELETE /sharing/invitation?id=` declines an invitation sent to the caller,
 * or withdraws one sent by the caller or someone sharing data with them.
 */
export const deleteSharingInvitationRoute = new Route("DELETE", "/sharing/invitation", async (req) => {
  const { user } = req.session;
  if (!user) return { status: "failed", message: "Request user is not authenticated." };

  const idResult = requireQueryString(req, "id");
  if (!idResult.success) return validationError(idResult.error!);
  const idCheck = validateFields(req.query, [{ path: "id", type: "uuid", required: true }]);
  if (!idCheck.success) return validationError(idCheck.error!);

  const deleted = await deleteSharingInvitation(user, idResult.data!);
  if (!deleted) return { status: "failed", message: "That invitation is no longer open." };

  const payload = originTabPayload(req.headers);
  for (const user_id of deleted.affected_user_ids) {
    void emitToSharingGroup(user_id, TableName.SharingInvitations, payload);
  }
  return { status: "success" };
});
