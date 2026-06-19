import { LocalDate, MAX_FLOAT, ViewDate } from "common";
import {
  TransactionFamilies,
  BudgetData,
  CapacityData,
  Transaction,
  TransactionDictionary,
  SplitTransactionDictionary,
  SectionDictionary,
  CategoryDictionary,
  AccountDictionary,
  BudgetDictionary,
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
  // Confirmed-transfer transaction ids — skipped entirely from budget
  // aggregation because a transfer is internal movement between the
  // user's own accounts, not real spending or income. The two halves
  // of the pair would otherwise inflate both the spent column on the
  // source-account budget and the income column on the destination's.
  // Defaults to an empty set so existing callers (and tests) keep the
  // pre-PR behavior. See PR #490's TransferRow / TransferProperties
  // for the pair-detection side.
  confirmedTransferTxIds: ReadonlySet<string> = new Set(),
): GetBudgetDataResult => {
  const budgetData = new BudgetData();

  const transactionFamilies = new TransactionFamilies();

  splitTransactions.forEach((splitTransaction) => {
    const { transaction_id } = splitTransaction;
    const transaction = transactions.get(transaction_id);
    if (!transaction) return;
    if (confirmedTransferTxIds.has(transaction_id)) return;
    transactionFamilies.add(transaction_id, splitTransaction);
  });

  const processTransaction = (transaction: Transaction) => {
    const { transaction_id, authorized_date, date, account_id, label, amount } = transaction;
    if (confirmedTransferTxIds.has(transaction_id)) return;
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
    if (confirmedTransferTxIds.has(st.transaction_id)) return;
    const transaction = st.toTransaction();
    processTransaction(transaction);
  });

  const endDate = new ViewDate("month");
  budgetData.forEach((history, budgetLikeId) => {
    const budgetLike =
      budgets.get(budgetLikeId) || sections.get(budgetLikeId) || categories.get(budgetLikeId);
    if (!budgetLike) return;
    const { roll_over, roll_over_start_date } = budgetLike;
    if (!roll_over || !roll_over_start_date) return;
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
  });

  return { transactionFamilies, budgetData };
};

const oldestDate = new Date(0);

export const getCapacityData = (
  budgets: BudgetDictionary,
  sections: SectionDictionary,
  categories: CategoryDictionary,
) => {
  const capacityData = new CapacityData();

  sections.forEach((section) => {
    const budget = budgets.get(section.budget_id);
    if (!budget) return;
    section.capacities.forEach((capacity) => {
      const { active_from } = capacity;
      // For is_synced sections the stored `capacity.month` is just the
      // advisory cache — sum the section's derived amount at this period
      // so downstream consumers (BudgetDonut, isChildrenSynced legacy
      // fallthrough) see the live total, not the stale cache.
      const periodDate = active_from || oldestDate;
      const capacityAmount = capacity.is_synced
        ? capacity.getActiveAmount(periodDate, "month", section.getChildren())
        : capacity.month;
      const isInfinite = Math.abs(capacityAmount) === MAX_FLOAT;
      const budgetCapacity = budget.getActiveCapacity(periodDate);
      if (isInfinite) {
        const override = MAX_FLOAT * (capacityAmount > 0 ? 1 : -1);
        capacityData.get(budgetCapacity.id).children_total = override;
      } else {
        capacityData.get(budgetCapacity.id).children_total += capacityAmount;
      }
    });
  });

  categories.forEach((category) => {
    const section = sections.get(category.section_id);
    if (!section) return;
    const budget = budgets.get(section.budget_id);
    if (!budget) return;
    category.capacities.forEach((capacity) => {
      const { active_from } = capacity;
      const capacityAmount = capacity.month;
      const isInfinite = Math.abs(capacityAmount) === MAX_FLOAT;
      const sectionCapacity = section.getActiveCapacity(active_from || oldestDate);
      const budgetCapacity = budget.getActiveCapacity(active_from || oldestDate);
      if (isInfinite) {
        const override = MAX_FLOAT * (capacityAmount > 0 ? 1 : -1);
        capacityData.get(sectionCapacity.id).children_total = override;
        capacityData.get(budgetCapacity.id).grand_children_total = override;
      } else {
        capacityData.get(sectionCapacity.id).children_total += capacityAmount;
        capacityData.get(budgetCapacity.id).grand_children_total += capacityAmount;
      }
    });
  });

  return capacityData;
};
