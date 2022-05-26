import { getInstitutions, Route, GetResponse } from "lib";

const getResponse: GetResponse = async (req) => {
  if (req.session.user?.username !== "admin") {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const id = req.query.id as string;
  const response = await getInstitutions(id);
  if (!response) throw new Error("Server failed to get institutions.");

  return {
    status: "success",
    data: response,
  };
};

const route = new Route("GET", "/institutions", getResponse);

export default route;
