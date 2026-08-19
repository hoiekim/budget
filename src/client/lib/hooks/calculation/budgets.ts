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
  // Halves of a CONFIRMED transfer pair are skipped from budget aggregation
  // — a transfer is internal movement between the user's own accounts, not
  // spending or income. Suggested pairs still aggregate normally.
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

    const { budget_id, category_id } = label;

    const nextMonthDate = new ViewDate("month", transactionDate).next().getEndDate();

    // "Unsorted" means any transaction the user hasn't confirmed —
    // `confidence !== 1` — bundling unlabeled, rejected, and auto-suggested-
    // but-unreviewed. A row only counts toward the sorted/category bucket if
    // it's confirmed AND has a category_id; the second half guards against a
    // malformed `confidence=1 AND category_id=null` row silently dropping out
    // of both buckets when `categories.get(null)` returns undefined.
    const isConfirmed = label.isConfirmed();

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

    // Calcuates sorted transactions amount for categories.
    // isConfirmed() is true only when category_id is present (it routes the
    // malformed confidence=1/category_id=null row into the unsorted branch
    // above), so this lookup always has a key — the guard makes that explicit.
    if (!category_id) return;
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

  // During a cold sync the loaded `transactions` aren't "the last N months of
  // history" — the delta-by-cursor fetch keys on `updated`, so Stage 2 can
  // include back-edited rows from years ago whose `date` predates the recent
  // window. Rollover shows as $0 until cold settles: clear any rolled-over
  // amounts `processTransaction` wrote and skip the accrual loop. Warm syncs
  // keep `isColdSync=false` so steady-state values are byte-identical.
  if (isColdSync) {
    budgetData.forEach((history) => {
      Object.values(history.getData()).forEach((summary) => {
        summary.rolled_over_amount = 0;
      });
    });
    return { transactionFamilies, budgetData };
  }

  // Accrue the per-month capacity carry-forward for EVERY rollover-enabled
  // budget-like, not just the ones a confirmed transaction touched. Driving
  // the walk over the budget/section/category dictionaries (rather than
  // `budgetData`'s existing keys) makes the carry independent of transaction
  // presence — a budget-like with zero confirmed transactions still gets its
  // accrual.
  //
  // Accrue one month PAST the current month T so `rolled_over(T+1)` is the
  // authoritative recurrence `rolled_over(T) + S(T) - C(T)` in the stored
  // history. `getRolledOver` seeds its future projection directly from that
  // bucket.
  const accrualEnd = endDate.clone().next();

  const accrueRollover = (budgetLike: Budget | Section | Category) => {
    const { roll_over, roll_over_start_date } = budgetLike;
    if (!roll_over || !roll_over_start_date) return;
    const history = budgetData.get(budgetLike.id);
    const startDate = new ViewDate("month", roll_over_start_date).next();
    while (startDate.getEndDate() <= accrualEnd.getEndDate()) {
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
