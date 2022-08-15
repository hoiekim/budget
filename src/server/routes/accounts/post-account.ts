import { Route, updateAccounts } from "server";

export interface AccountPostResponse {
  account_id: string;
}

export const postAccountRoute = new Route<AccountPostResponse>(
  "POST",
  "/account",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        info: "Request user is not authenticated.",
      };
    }

    try {
      const response = await updateAccounts(user, [req.body]);
      const account_id = response[0].update?._id || "";
      return { status: "success", data: { account_id } };
    } catch (error: any) {
      console.error(`Failed to update an account: ${req.body.account_id}`);
      throw new Error(error);
    }
  }
);
