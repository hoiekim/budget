import { Route, pairTransactions } from "server";

export interface TransferPairPostBody {
  transaction_id_a: string;
  transaction_id_b: string;
  confirm?: boolean;
}

export interface TransferPairPostResponse {
  transfer_pair_id: string;
}

export const postTransferPairRoute = new Route<TransferPairPostResponse>(
  "POST",
  "/transfers/pair",
  async (req) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        message: "Request user is not authenticated.",
      };
    }

    const body = req.body as Partial<TransferPairPostBody>;
    const { transaction_id_a, transaction_id_b, confirm } = body;

    if (!transaction_id_a || !transaction_id_b) {
      return {
        status: "failed",
        message: "transaction_id_a and transaction_id_b are required.",
      };
    }

    if (transaction_id_a === transaction_id_b) {
      return {
        status: "failed",
        message: "Cannot pair a transaction with itself.",
      };
    }

    const result = await pairTransactions(user, transaction_id_a, transaction_id_b, confirm ?? false);

    if (!result) {
      return {
        status: "failed",
        message: "Failed to pair transactions. Verify both transaction IDs belong to your account.",
      };
    }

    return {
      status: "success",
      body: { transfer_pair_id: result.transfer_pair_id },
    };
  },
);
