import { plaidClient, Route, searchInstitutionById, upsertInstitutions } from "server";
import { Institution } from "common";

export type InstitutionGetResponse = Institution;

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

    const id = req.query.id as string;
    const storedInstitution = await searchInstitutionById(user, id);
    if (storedInstitution) {
      return { status: "success", body: storedInstitution };
    } else {
      const newInstitution = await plaidClient.getInstitution(user, id);
      if (!newInstitution) throw new Error("Server failed to get institutions.");
      upsertInstitutions(user, [newInstitution]).catch(console.error);
      return { status: "success", body: newInstitution };
    }
  }
);
