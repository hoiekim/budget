import { TableName } from "common";
import {
  Route,
  emitToUser,
  originTabPayload,
  removeSharingMember,
  requireQueryString,
  validateFields,
  validationError,
} from "server";

/**
 * `DELETE /sharing/member?user_id=` takes a user out of the caller's sharing
 * group: the caller, to stop sharing, or anyone else in the group.
 */
export const deleteSharingMemberRoute = new Route("DELETE", "/sharing/member", async (req) => {
  const { user } = req.session;
  if (!user) return { status: "failed", message: "Request user is not authenticated." };

  const idResult = requireQueryString(req, "user_id");
  if (!idResult.success) return validationError(idResult.error!);
  const idCheck = validateFields(req.query, [{ path: "user_id", type: "uuid", required: true }]);
  if (!idCheck.success) return validationError(idCheck.error!);

  const result = await removeSharingMember(user, idResult.data!);
  if (!result.ok) return { status: "failed", message: result.error };

  const payload = originTabPayload(req.headers);
  for (const user_id of result.affected_user_ids) {
    emitToUser(user_id, TableName.SharingMembers, payload);
  }
  return { status: "success" };
});
