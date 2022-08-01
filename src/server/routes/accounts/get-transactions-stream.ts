import {
  getTransactions,
  deleteTransactions,
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

  const dependency = searchTransactions(user).then((transactions) => {
    const data = { errors: [], added: transactions, removed: [], modified: [] };
    res.write(JSON.stringify({ status: "streaming", data }) + "\n");
  });

  await getTransactions(user).then(async (data) => {
    await dependency;

    res.write(JSON.stringify({ status: "success", data }) + "\n");

    const { added, removed, modified } = data;
    console.info(
      "Plaid responded with " +
        `${added.length} added, ` +
        `${modified.length} modified and ` +
        `${removed.length} removed transactions data.`
    );

    const updateJobs = [
      indexTransactions(user, [...added, ...modified]),
      deleteTransactions(user, removed),
    ];

    Promise.all(updateJobs).then(() => updateItems(user));
  });
};

const route = new Route("GET", "/transactions-stream", getResponse);

export default route;
