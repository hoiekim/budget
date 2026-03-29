import { Route, unpairTransactions } from "server";

export interface TransferDeleteResponse {
  removed: number;
}

export const deleteTransferRoute = new Route<TransferDeleteResponse>(
  "DELETE",
  "/transfers/:id",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const transfer_pair_id = (req.params as Record<string, string>)["id"];
    if (!transfer_pair_id) {
      return {
        status: "failed",
        message: "Transfer pair ID is required.",
      };
    }

    const result = await unpairTransactions(user, transfer_pair_id);

    if (!result) {
      return {
        status: "failed",
        message: "Failed to remove transfer pairing.",
      };
    }

    return {
      status: "success",
      body: { removed: result.removed },
    };
  },
);
