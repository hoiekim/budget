import { LocalDate, MAX_FLOAT, ViewDate } from "common";
import {
  TransactionFamilies,
  BudgetData,
  CapacityData,
  Transaction,
  TransactionDictionary,
  TransferDictionary,
  SplitTransactionDictionary,
  SectionDictionary,
  CategoryDictionary,
  AccountDictionary,
  BudgetDictionary,
  Budget,
  Section,
  Category,
} from "client";

interface GetBudgetDataResult {
  transactionFamilies: TransactionFamilies;
  budgetData: BudgetData;
}

export const getBudgetData = (
  transactions: TransactionDictionary,
  splitTransactions: SplitTransactionDictionary,
  accounts: AccountDictionary,
  budgets: BudgetDictionary,
  sections: SectionDictionary,
  categories: CategoryDictionary,
  // All transfer pairs (suggested + confirmed), keyed by pair_id with
  // a transaction_id pivot. Halves of a CONFIRMED pair are skipped
  // entirely from budget aggregation — a transfer is internal
  // movement between the user's own accounts, not real spending or
  // income. The two halves would otherwise inflate both the spent
  // column on the source-account budget and the income column on the
  // destination's. Suggested pairs still aggregate normally —
  // they're heuristic proposals the user hasn't confirmed. Required
  // (no default): the caller threads `data.transfers` through, which
  // is itself defaulted to an empty `TransferDictionary` on `Data`.
  transfers: TransferDictionary,
  // True only while a cold sync is still streaming history in — months
  // older than what's already loaded have no spending in memory yet, so
  // accruing their capacity would overstate the rollover.
  isColdSync = false,
): GetBudgetDataResult => {
  const budgetData = new BudgetData();

  const transactionFamilies = new TransactionFamilies();

  splitTransactions.forEach((splitTransaction) => {
    const { transaction_id } = splitTransaction;
    const transaction = transactions.get(transaction_id);
    if (!transaction) return;
    if (transfers.byTransactionId.hasConfirmed(transaction_id)) return;
    transactionFamilies.add(transaction_id, splitTransaction);
  });

  const processTransaction = (transaction: Transaction) => {
    const { transaction_id, authorized_date, date, account_id, label, amount } = transaction;
    if (transfers.byTransactionId.hasConfirmed(transaction_id)) return;
    const transactionDate = new LocalDate(authorized_date || date);
    const account = accounts.get(account_id);
    if (!account || account.hide) return;

    const childrenAmountTotal = transactionFamilies.getChildrenAmountTotal(transaction_id);
    const amountAfterSplit = amount - childrenAmountTotal;

    const { budget_id, category_id, category_confidence } = label;

    const nextMonthDate = new ViewDate("month", transactionDate).next().getEndDate();

    // "Unsorted" for the purposes of budget bar graphs / counts is any
    // transaction the user hasn't confirmed. That bundles three states:
    //   - genuinely unlabeled (category_id null, confidence null)
    //   - explicitly rejected (category_id null, confidence 0)
    //   - auto-suggested but unreviewed (category_id set, 0 < confidence < 1)
    // The unsorted-count and the unsorted-amount-bar reflect "needs my
    // review", not just "literally lacking a category", so the gate is
    // `confidence !== 1`.
    // A row only counts toward the sorted/category bucket if it's
    // confirmed AND has a category_id; the latter guards against a
    // malformed `confidence=1 AND category_id=null` row falling into the
    // sorted-amount path below where `categories.get(null)` would skip it
    // entirely (contributing to neither bucket).
    const isConfirmed = category_confidence === 1 && !!category_id;

    // Calculates unsorted transactions amount for budgets
    if (!isConfirmed) {
      const budgetId = budget_id || account.label.budget_id;
      if (!budgetId) return;

      const parentBudget = budgets.get(budgetId);
      if (!parentBudget) return;
      budgetData.add(parentBudget.id, transactionDate, {
        unsorted_amount: amountAfterSplit,
        number_of_unsorted_items: 1,
      });
      if (
        parentBudget.roll_over &&
        parentBudget.roll_over_start_date &&
        new LocalDate(parentBudget.roll_over_start_date) <= transactionDate
      ) {
        budgetData.add(parentBudget.id, nextMonthDate, {
          rolled_over_amount: amountAfterSplit,
        });
      }

      return;
    }

    // Calcuates sorted transactions amount for categories
    const parentCategory = categories.get(category_id);
    if (!parentCategory) return;
    budgetData.add(parentCategory.id, transactionDate, {
      sorted_amount: amountAfterSplit,
    });
    if (
      parentCategory.roll_over &&
      parentCategory.roll_over_start_date &&
      new LocalDate(parentCategory.roll_over_start_date) <= transactionDate
    ) {
      budgetData.add(parentCategory.id, nextMonthDate, {
        rolled_over_amount: amountAfterSplit,
      });
    }

    // Calcuates sorted transactions amount for sections
    const parentSection = sections.get(parentCategory.section_id);
    if (!parentSection) return;
    budgetData.add(parentSection.id, transactionDate, {
      sorted_amount: amountAfterSplit,
    });
    if (
      parentSection.roll_over &&
      parentSection.roll_over_start_date &&
      new LocalDate(parentSection.roll_over_start_date) <= transactionDate
    ) {
      budgetData.add(parentSection.id, nextMonthDate, {
        rolled_over_amount: amountAfterSplit,
      });
    }

    // Calcuates sorted transactions amount for budgets
    const parentBudget = budgets.get(parentSection.budget_id);
    if (!parentBudget) return;
    budgetData.add(parentBudget.id, transactionDate, {
      sorted_amount: amountAfterSplit,
    });
    if (
      parentBudget.roll_over &&
      parentBudget.roll_over_start_date &&
      new LocalDate(parentBudget.roll_over_start_date) <= transactionDate
    ) {
      budgetData.add(parentBudget.id, nextMonthDate, {
        rolled_over_amount: amountAfterSplit,
      });
    }
  };

  transactions.forEach(processTransaction);
  splitTransactions.forEach((st) => {
    // Guard at the SPLIT pass on the PARENT's transaction_id, not on
    // the synthetic Transaction's `transaction_id` (which is the
    // split's own id per `SplitTransaction.toTransaction()` — so the
    // in-`processTransaction` guard on line ~51 would never fire for
    // splits even when their parent is a confirmed transfer).
    if (transfers.byTransactionId.hasConfirmed(st.transaction_id)) return;
    const transaction = st.toTransaction();
    processTransaction(transaction);
  });

  const endDate = new ViewDate("month");

  // During a cold sync the loaded `transactions` aren't "the last N months
  // of history" — the delta-by-cursor fetch keys on `updated`, so Stage 2
  // can include back-edited rows from years ago whose `date` predates the
  // recent window. Two effects need suppressing:
  //   1. `processTransaction` above already carried each transaction's
  //      amount forward into the next month's `rolled_over_amount`.
  //   2. The accrual loop below would walk from `roll_over_start_date`,
  //      accruing capacity for every month against the sparse spending.
  // Both produce a misleading figure until Stage 4 commits the full
  // history. Clear any rolled-over amounts that `processTransaction`
  // wrote and skip the accrual loop. Rollover shows as $0 until cold
  // settles (~3 s on prod-clone data). Warm syncs keep
  // `isColdSync=false` so steady-state values are byte-identical.
  if (isColdSync) {
    budgetData.forEach((history) => {
      Object.values(history.getData()).forEach((summary) => {
        summary.rolled_over_amount = 0;
      });
    });
    return { transactionFamilies, budgetData };
  }

  // Accrue the per-month capacity carry-forward for EVERY rollover-enabled
  // budget-like, not just the ones a confirmed transaction happened to
  // touch. Iterating `budgetData`'s existing keys would skip any budget-like
  // with no confirmed (sorted) transactions in the window — its history was
  // never created by `processTransaction`, so its accrual never ran and the
  // bar rendered "+ 0 rolled" despite a real capacity and a years-old
  // `roll_over_start_date`. Driving the walk over the budget/section/category
  // dictionaries makes the carry independent of transaction presence:
  // `budgetData.get(id)` auto-creates the history for untouched rows, while
  // touched rows keep the spending `processTransaction` already deposited
  // (the walk only adds the capacity carry on top of it).
  const accrueRollover = (budgetLike: Budget | Section | Category) => {
    const { roll_over, roll_over_start_date } = budgetLike;
    if (!roll_over || !roll_over_start_date) return;
    const history = budgetData.get(budgetLike.id);
    const startDate = new ViewDate("month", roll_over_start_date).next();
    while (startDate.getEndDate() <= endDate.getEndDate()) {
      const previousDate = startDate.clone().previous();
      const previousSummary = history.get(previousDate.getEndDate());
      // Use the children-aware derived amount: for is_synced rows the
      // stored capacity.month is just advisory cache, so subtracting it
      // would silently drift the rollover carry each month.
      const previousAmount = budgetLike.getActiveAmount(previousDate.getEndDate(), "month");
      history.add(startDate.getEndDate(), {
        rolled_over_amount: previousSummary.rolled_over_amount - previousAmount,
      });
      startDate.next();
    }
  };

  budgets.forEach(accrueRollover);
  sections.forEach(accrueRollover);
  categories.forEach(accrueRollover);

  return { transactionFamilies, budgetData };
};

const oldestDate = new Date(0);

/**
 * Point-in-time capacity aggregation, keyed by parent capacity version.
 *
 * Each parent capacity version renders its own `BudgetDonut` at
 * `date = capacity.active_from` (see `CapacitiesInput`), and that donut's
 * child slices read `child.getActiveAmount(date)`. So each bucket must hold
 * the sum of its children's amount **active at that same date**: a child
 * versioned more granularly than its parent (e.g. a section bumped for a new
 * period while the budget keeps one "All past" capacity) contributes only its
 * version active at the parent's `active_from`, never the sum of its historical
 * versions — otherwise the donut's center number drifts off its own ring.
 */
export const getCapacityData = (
  budgets: BudgetDictionary,
  sections: SectionDictionary,
  categories: CategoryDictionary,
) => {
  const capacityData = new CapacityData();

  // Sum each child's amount active at `date`. A single infinite child
  // (±MAX_FLOAT) poisons the whole bucket to the sentinel, matching the
  // BudgetDonut's `isChildrenInfinite` guard and Capacity.getActiveAmount.
  // getActiveAmount already resolves synced children to their derived sum and
  // non-synced children to the stored `month` of the version active at `date`.
  const sumActiveAt = (children: (Section | Category)[], date: Date): number => {
    let total = 0;
    for (const child of children) {
      const amount = child.getActiveAmount(date, "month");
      if (Math.abs(amount) === MAX_FLOAT) return amount > 0 ? MAX_FLOAT : -MAX_FLOAT;
      total += amount;
    }
    return total;
  };

  // Group children by parent once (O(sections + categories)) so the aggregation
  // loops below don't re-scan the full collections per parent.
  const sectionsByBudget = new Map<string, Section[]>();
  sections.forEach((section) => {
    const list = sectionsByBudget.get(section.budget_id);
    if (list) list.push(section);
    else sectionsByBudget.set(section.budget_id, [section]);
  });
  const categoriesBySection = new Map<string, Category[]>();
  categories.forEach((category) => {
    const list = categoriesBySection.get(category.section_id);
    if (list) list.push(category);
    else categoriesBySection.set(category.section_id, [category]);
  });

  budgets.forEach((budget) => {
    const budgetSections = sectionsByBudget.get(budget.id) || [];
    const budgetCategories = budgetSections.flatMap(
      (s) => categoriesBySection.get(s.id) || [],
    );
    budget.capacities.forEach((capacity) => {
      const date = capacity.active_from || oldestDate;
      const summary = capacityData.get(capacity.id);
      summary.children_total = sumActiveAt(budgetSections, date);
      summary.grand_children_total = sumActiveAt(budgetCategories, date);
    });
  });

  sections.forEach((section) => {
    const sectionCategories = categoriesBySection.get(section.id) || [];
    section.capacities.forEach((capacity) => {
      const date = capacity.active_from || oldestDate;
      capacityData.get(capacity.id).children_total = sumActiveAt(sectionCategories, date);
    });
  });

  return capacityData;
};
