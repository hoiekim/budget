import { getInstitution, Route } from "server";
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
    const response = await getInstitution(user, id);
    if (!response) throw new Error("Server failed to get institutions.");

    return {
      status: "success",
      body: new Institution(response),
    };
  }
);
