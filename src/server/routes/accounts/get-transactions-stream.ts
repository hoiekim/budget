import {
  getTransactions,
  getInvestmentTransactions,
  Route,
  searchTransactions,
  upsertTransactions,
  deleteTransactions,
  upsertInvestmentTransactions,
  deleteInvestmentTransactions,
  searchItems,
  upsertItems,
  Item,
  Transaction,
  PartialTransaction,
  RemovedTransaction,
  appendTimeString,
  StreamingStatus,
  InvestmentTransaction,
  PartialInvestmentTransaction,
  RemovedInvestmentTransaction,
} from "server";

const TWO_WEEKS = 1000 * 60 * 60 * 24 * 14;

export interface TransactionsStreamGetResponse {
  items?: Item[];
  transactions?: {
    added?: Transaction[];
    removed?: RemovedTransaction[];
    modified?: PartialTransaction[];
  };
  investmentTransactions?: {
    added?: InvestmentTransaction[];
    removed?: RemovedInvestmentTransaction[];
    modified?: PartialInvestmentTransaction[];
  };
}

export const getTransactionsStreamRoute = new Route<TransactionsStreamGetResponse>(
  "GET",
  "/transactions-stream",
  async (req, res, stream) => {
    const { user } = req.session;
    if (!user) {
      return {
        status: "failed",
        info: "Request user is not authenticated.",
      };
    }

    const status = new StreamingStatus(3);

    const getTransactionsFromElasticsearch = searchTransactions(user)
      .then((r) => {
        const { transactions, investment_transactions } = r;
        const data: TransactionsStreamGetResponse = {
          transactions: { added: transactions },
          investmentTransactions: { added: investment_transactions },
        };
        stream({ status: status.get(), data });

        return r;
      })
      .catch((err) => {
        console.error(err);
        stream({ status: status.get() && "error" });
      });

    const promisedItems = searchItems(user);

    const getTransactionsFromPlaid = promisedItems
      .then((r) => getTransactions(user, r))
      .then(async (data) => {
        await getTransactionsFromElasticsearch;

        const { items, added, removed, modified } = data;

        const fillDateStrings = (e: typeof added[0]) => {
          const result = { ...e };
          const { authorized_date, date } = e;
          if (authorized_date) result.authorized_date = appendTimeString(authorized_date);
          if (date) result.date = appendTimeString(date);
          return result;
        };

        const filledAdded = added.map(fillDateStrings).map((e) => {
          return { ...e, label: {} };
        });

        const filledModified = modified.map(fillDateStrings);

        const filledData: TransactionsStreamGetResponse = {
          items,
          transactions: {
            added: filledAdded,
            removed,
            modified: filledModified,
          },
        };

        stream({ status: status.get(), data: filledData });

        const updateJobs = [
          upsertTransactions(user, [...filledAdded, ...filledModified]),
          deleteTransactions(user, removed),
        ];

        const partialItems = items.map(({ item_id, cursor }) => ({ item_id, cursor }));
        Promise.all(updateJobs).then(() => upsertItems(user, partialItems));

        return null;
      })
      .catch((err) => {
        console.error(err);
        stream({ status: status.get() && "error" });
      });

    const getInvestmentTransactionsFromPlaid = promisedItems
      .then((r) => getInvestmentTransactions(user, r))
      .then(async (data) => {
        const { items, investmentTransactions } = data;

        const fillDateStrings = (e: typeof investmentTransactions[0]) => {
          const result = { ...e };
          const { date } = e;
          if (date) result.date = appendTimeString(date);
          return result;
        };

        const filledInvestments = investmentTransactions.map(fillDateStrings);

        const addedMap = new Map(
          filledInvestments.map((e) => [e.investment_transaction_id, e])
        );

        const ingestedTrasactions = await getTransactionsFromElasticsearch;
        const ingestedData = ingestedTrasactions?.investment_transactions || [];

        const removed: RemovedInvestmentTransaction[] = [];
        const modified: InvestmentTransaction[] = [];

        ingestedData.forEach((e) => {
          const age = new Date().getTime() - new Date(e.date).getTime();
          if (age > TWO_WEEKS) return;

          const { investment_transaction_id } = e;

          const found = investmentTransactions.find((f) => {
            return investment_transaction_id === f.investment_transaction_id;
          });

          if (!found) removed.push({ investment_transaction_id });
          else {
            modified.push(e);
            addedMap.delete(e.investment_transaction_id);
          }
        });

        const filledData: TransactionsStreamGetResponse = {
          items,
          investmentTransactions: {
            added: Array.from(addedMap.values()),
            removed,
            modified,
          },
        };

        const updateJobs = [
          upsertInvestmentTransactions(user, [...filledInvestments, ...modified]),
          deleteInvestmentTransactions(user, removed),
        ];

        const partialItems = items.map(({ item_id, updated }) => ({ item_id, updated }));
        Promise.all(updateJobs).then(() => upsertItems(user, partialItems));

        stream({ status: status.get(), data: filledData });
      })
      .catch((err) => {
        console.error(err);
        stream({ status: status.get() && "error" });
      });

    await Promise.all([
      getTransactionsFromElasticsearch,
      getTransactionsFromPlaid,
      getInvestmentTransactionsFromPlaid,
    ]);
  }
);
