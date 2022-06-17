import { Institution, getInstitution, Route, GetResponse } from "server";

const getResponse: GetResponse<Institution> = async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const id = req.query.id as string;
  const response = await getInstitution(user, id);
  if (!response) throw new Error("Server failed to get institutions.");

  return {
    status: "success",
    data: response,
  };
};

const route = new Route("GET", "/institution", getResponse);

export default route;
