import { Route, updateAccounts } from "server";

export interface AccountPostResponse {
  account_id: string;
}

export const postAccountRoute = new Route<AccountPostResponse>("POST", "/account", async (req) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      message: "Request user is not authenticated.",
    };
  }

  try {
    const response = await updateAccounts(user, [req.body]);
    const result = response[0];
    if (!result || result.status >= 400) {
      throw new Error("Unknown error during account upsert");
    }
    const account_id = result.update._id;
    if (!account_id) throw new Error("Account ID is missing after upsert");
    return { status: "success", body: { account_id } };
  } catch (error: any) {
    console.error(`Failed to update an account: ${req.body.account_id}`);
    throw new Error(error);
  }
});
