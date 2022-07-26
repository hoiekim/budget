import {
  Transaction,
  getTransactions,
  Route,
  GetResponse,
  searchTransactions,
  indexTransactions,
  updateItems,
  TransactionsResponse,
} from "server";

const getResponse: GetResponse<TransactionsResponse> = async (req, res) => {
  const { user } = req.session;
  if (!user) {
    return {
      status: "failed",
      info: "Request user is not authenticated.",
    };
  }

  const map = new Map<string, Transaction>();

  const earlyResponse = await searchTransactions(user);
  if (!earlyResponse) {
    throw new Error("Server failed to get middlestream transactions data.");
  }

  res.write(
    JSON.stringify({
      status: "streaming",
      data: { errors: [], transactions: earlyResponse },
    })
  );
  res.write("\n");

  earlyResponse.forEach((e) => map.set(e.transaction_id, e));

  const lateResponse = await getTransactions(user);
  if (!lateResponse) {
    throw new Error("Server failed to get upstream transactions data.");
  }

  updateItems(user);

  const moreResponse = lateResponse.transactions.filter(
    (e) => !map.has(e.transaction_id)
  );
  res.write(
    JSON.stringify({
      status: "success",
      data: { errors: lateResponse.errors, transactions: moreResponse },
    })
  );
  res.write("\n");

  indexTransactions(user, moreResponse);
};

const route = new Route("GET", "/transactions-stream", getResponse);

export default route;
