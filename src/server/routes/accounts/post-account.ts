import { Route, upsertAccounts } from "server";

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
    const response = await upsertAccounts(user, [req.body]);
    const updateResponse = response[0].update;
    if (!updateResponse) throw new Error("Unknown error during account upsert");
    if (updateResponse.error) throw new Error(updateResponse.error.reason);
    const account_id = updateResponse._id;
    if (!account_id) throw new Error("Account ID is missing after upsert");
    return { status: "success", body: { account_id } };
  } catch (error: any) {
    console.error(`Failed to update an account: ${req.body.account_id}`);
    throw new Error(error);
  }
});
