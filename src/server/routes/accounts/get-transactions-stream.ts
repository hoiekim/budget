import {
  getTransactions,
  Route,
  GetResponse,
  searchTransactions,
  indexTransactions,
  updateTransactions,
  deleteTransactions,
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

  const earlyRequest = searchTransactions(user).then((transactions) => {
    const data = { errors: [], added: transactions, removed: [], modified: [] };
    res.write(JSON.stringify({ status: "streaming", data }) + "\n");
    return null;
  });

  const lateRequest = getTransactions(user)
    .then(async (data) => {
      await earlyRequest;

      const { added, removed, modified } = data;

      console.info(
        "Plaid responded with " +
          `${added.length} added, ` +
          `${modified.length} modified and ` +
          `${removed.length} removed transactions data.`
      );

      const filledAdded = added.map((e) => ({ ...e, labels: [] }));
      const filledData = { ...data, added: filledAdded };
      res.write(JSON.stringify({ status: "success", data: filledData }) + "\n");

      const updateJobs = [
        indexTransactions(user, filledAdded),
        updateTransactions(user, modified),
        deleteTransactions(user, removed),
      ];

      Promise.all(updateJobs).then(() => updateItems(user));

      return null;
    })
    .catch(console.error);

  await Promise.all([earlyRequest, lateRequest]);
};

const route = new Route("GET", "/transactions-stream", getResponse);

export default route;
