import { getInstitution, Route, GetResponse } from "lib";
import { Institution } from "plaid";

const getResponse: GetResponse<Institution> = async (req) => {
  if (!req.session.user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const id = req.query.id as string;
  const response = await getInstitution(id);
  if (!response) throw new Error("Server failed to get institutions.");

  return {
    status: "success",
    data: response,
  };
};

const route = new Route("GET", "/institution", getResponse);

export default route;
