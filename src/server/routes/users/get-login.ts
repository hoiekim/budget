import { Route, GetResponse, MaskedUser, version } from "server";

export interface getLoginResponse {
  user?: MaskedUser;
  app: { version: string };
}

const getResponse: GetResponse<getLoginResponse> = async (req) => {
  const { user } = req.session;
  return {
    status: "success",
    data: { user, app: { version } },
    info: user ? undefined : "Not logged in.",
  };
};

const route = new Route("GET", "/login", getResponse);

export default route;
