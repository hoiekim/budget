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
  PartialTransaction,
  PartialInvestmentTransaction,
  getOldestTransactionDate,
} from "server";
import {
  Transaction,
  RemovedTransaction,
  InvestmentTransaction,
  RemovedInvestmentTransaction,
  getDateTimeString,
  Item,
  TWO_WEEKS,
  SplitTransaction,
  ViewDate,
  sleep,
} from "common";

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
  splitTransactions?: {
    added: SplitTransaction[];
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
        message: "Request user is not authenticated.",
      };
    }

    type TransactionsData = {
      transactions: Transaction[];
      investment_transactions: InvestmentTransaction[];
      split_transactions: SplitTransaction[];
    };

    const getTransactionsFromElasticsearch = new Promise<TransactionsData>(async (res, rej) => {
      let currentMonth = new ViewDate("month");
      const oldestDate = await getOldestTransactionDate(user);
      const result: TransactionsData = {
        transactions: [],
        investment_transactions: [],
        split_transactions: [],
      };
      while (oldestDate < currentMonth.getEndDate()) {
        await searchTransactions(user, currentMonth.getEndDate())
          .then((r) => {
            const { transactions, investment_transactions, split_transactions } = r;
            stream({
              status: "streaming",
              body: {
                transactions: { added: transactions },
                investmentTransactions: { added: investment_transactions },
                splitTransactions: { added: split_transactions },
              },
            });

            result.transactions = result.transactions.concat(transactions);
            result.investment_transactions =
              result.investment_transactions.concat(investment_transactions);
            result.split_transactions = result.split_transactions.concat(split_transactions);

            return r;
          })
          .catch((err) => {
            console.error(err);
            stream({ status: "error" });
          });

        currentMonth.previous();
        await sleep(50);
      }
      return res(result);
    });

    const promisedItems = searchItems(user);

    const getTransactionsFromPlaid = promisedItems
      .then((r) => getTransactions(user, r))
      .then(async (r) => {
        const ingestedTrasactions = await getTransactionsFromElasticsearch;
        const ingestedData = ingestedTrasactions?.transactions || [];

        const { items, added, removed, modified } = r;

        const modelize = (e: (typeof added)[0]) => {
          const result = new Transaction(e);
          const { authorized_date: auth_date, date } = e;
          if (auth_date) result.authorized_date = getDateTimeString(auth_date);
          if (date) result.date = getDateTimeString(date);
          const existing = ingestedData.find((f) => {
            const idMatches = e.transaction_id === f.transaction_id;
            const accountMatches = e.account_id === f.account_id;
            const nameMatches = e.name === f.name;
            const amountMatches = e.amount === f.amount;
            return idMatches || (accountMatches && nameMatches && amountMatches);
          });
          if (existing) result.label = existing.label;
          return result;
        };

        const modeledAdded = added.map(modelize);
        const modeledModified = modified.map(modelize);
        const modeledRemoved = removed.filter(({ transaction_id }) => {
          return ![...added, ...modified].find((e) => {
            return e.transaction_id === transaction_id;
          });
        });

        const adjustedData: TransactionsStreamGetResponse = {
          items,
          transactions: {
            added: modeledAdded,
            removed: modeledRemoved,
            modified: modeledModified,
          },
        };

        stream({ status: "streaming", body: adjustedData });

        const updateJobs = [
          upsertTransactions(user, [...modeledAdded, ...modeledModified]),
          deleteTransactions(user, removed),
        ];

        const partialItems = items.map(({ item_id, cursor }) => ({ item_id, cursor }));
        Promise.all(updateJobs)
          .then(() => upsertItems(user, partialItems))
          .catch((err) => {
            console.error(
              "Error occured during puting Plaid transanctions data into Elasticsearch"
            );
            console.error(err);
          });

        return null;
      })
      .catch((err) => {
        console.error(err);
        stream({ status: "error" });
      });

    const getInvestmentTransactionsFromPlaid = promisedItems
      .then((r) => getInvestmentTransactions(user, r))
      .then(async (r) => {
        const { items, investmentTransactions } = r;

        const fillDateStrings = (e: (typeof investmentTransactions)[0]) => {
          const result = { ...e };
          const { date } = e;
          if (date) result.date = getDateTimeString(date);
          return result;
        };

        const filledInvestments = investmentTransactions.map(fillDateStrings);

        const addedMap = new Map(
          filledInvestments.map((e) => [e.investment_transaction_id, new InvestmentTransaction(e)])
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

        stream({ status: "streaming", body: filledData });
      })
      .catch((err) => {
        console.error(err);
        stream({ status: "error" });
      });

    await Promise.all([
      getTransactionsFromElasticsearch,
      getTransactionsFromPlaid,
      getInvestmentTransactionsFromPlaid,
    ]);

    stream({ status: "success" });
  }
);
