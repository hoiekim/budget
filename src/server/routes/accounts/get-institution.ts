import { plaid, Route, getInstitution, upsertInstitutions, requireQueryString, validationError } from "server";
import { JSONInstitution } from "common";

export type InstitutionGetResponse = JSONInstitution;

export const getInstitutionRoute = new Route<InstitutionGetResponse>(
  "GET",
  "/institution",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const idResult = requireQueryString(req, "id");
    if (!idResult.success) return validationError(idResult.error!);

    const storedInstitution = await getInstitution(idResult.data!);
    if (storedInstitution) {
      return { status: "success", body: storedInstitution };
    } else {
      const newInstitution = await plaid.getInstitution(user, idResult.data!);
      if (!newInstitution) throw new Error("Server failed to get institutions.");
      upsertInstitutions([newInstitution]).catch(console.error);
      return { status: "success", body: newInstitution };
    }
  },
);
