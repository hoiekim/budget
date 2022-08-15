import { Route, updateAccountLabels } from "server";

export interface AccountLabelPostResponse {
  account_id: string;
}

export const postAccountLabelRoute = new Route<AccountLabelPostResponse>(
  "POST",
  "/account-label",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        info: "Request user is not authenticated.",
      };
    }

    try {
      const response = await updateAccountLabels(user, [req.body]);
      const account_id = response[0].update?._id || "";
      return { status: "success", data: { account_id } };
    } catch (error: any) {
      console.error(`Failed to update an account: ${req.body.account_id}`);
      throw new Error(error);
    }
  }
);
