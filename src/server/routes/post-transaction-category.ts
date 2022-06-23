import { Route, GetResponse, updateTransaction } from "server";

const getResponse: GetResponse = async (req) => {
  const { transaction_id, category } = req.body as {
    transaction_id: string;
    category: string[];
  };

  updateTransaction({
    transaction_id,
    category: category
      .flatMap((e) => e.split(","))
      .map((e) => e.replace(/^\s+|\s+$|\s+(?=\s)/g, "")),
  });

  return { status: "success" };
};

const route = new Route("POST", "/transaction-category", getResponse);

export default route;
