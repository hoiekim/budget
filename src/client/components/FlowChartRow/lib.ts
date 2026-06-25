import { InvestmentTransactionType } from "plaid";

import { LocalDate, ViewDate } from "common";
import {
  Account,
  BudgetDictionary,
  CategoryDictionary,
  InvestmentTransaction,
  InvestmentTransactionDictionary,
  Line,
  Point,
  SectionDictionary,
  SplitTransactionDictionary,
  Transaction,
  TransactionDictionary,
  TransactionFamilies,
  TransferDictionary,
} from "client";

export interface SankeyData {
  graphData: SankeyColumn[];
  tableData: { income: number; expense: number };
}

export const getSankeyData = (
  accounts: Account[],
  transactions: TransactionDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
  // Split children re-label money to a different budget/category than
  // their parent. The Sankey must mirror the Budgets page
  // (`getBudgetData`): subtract each parent's children-amount-total
  // from the parent's flow contribution, then attribute each child
  // under its OWN label. Without this the parent budget gets the full
  // amount and the child's budget gets nothing — the two views
  // disagree about where the money flowed.
  splitTransactions: SplitTransactionDictionary,
  budgets: BudgetDictionary,
  sections: SectionDictionary,
  categories: CategoryDictionary,
  viewDate: ViewDate,
  // All transfer pairs (suggested + confirmed), keyed by pair_id with
  // a transaction_id pivot. Halves of a CONFIRMED pair are skipped —
  // a transfer is internal movement between the user's own accounts,
  // not flow in or out of total wealth. Without this skip the Sankey
  // would inflate both the income column (destination-side credit)
  // AND the expense column (source-side debit) by the same amount.
  // Suggested pairs still aggregate normally. Required (no default):
  // the caller threads `data.transfers` through, which is itself
  // defaulted to an empty `TransferDictionary` on `Data`.
  transfers: TransferDictionary,
): SankeyData => {
  const incomeBudgets = new Map<string, SankeyRow>();
  const incomeSections = new Map<string, SankeyRow>();
  const expenseBudgets = new Map<string, SankeyRow>();
  const expenseSections = new Map<string, SankeyRow>();

  let income = 0;
  let expense = 0;

  // Group split children under their parent so the parent's flow
  // contribution can be reduced by what the children re-attribute.
  // Skip splits whose parent transaction is absent or is a confirmed
  // transfer half (the whole family is excluded in that case).
  const transactionFamilies = new TransactionFamilies();
  splitTransactions.forEach((splitTransaction) => {
    const { transaction_id } = splitTransaction;
    if (!transactions.get(transaction_id)) return;
    if (transfers.byTransactionId.hasConfirmed(transaction_id)) return;
    transactionFamilies.add(transaction_id, splitTransaction);
  });

  const processTransaction = (t: Transaction | InvestmentTransaction) => {
    const isInvestment = t instanceof InvestmentTransaction;
    if (!isInvestment && transfers.byTransactionId.hasConfirmed(t.transaction_id)) {
      return;
    }
    const authorized_date = !isInvestment ? t.authorized_date : undefined;
    const transactionDate = new LocalDate(authorized_date || t.date);
    if (!viewDate.has(transactionDate)) return;
    const account = accounts.find((a) => a.id === t.account_id);
    if (!account) return;
    const budget_id = t.label.budget_id || account.label.budget_id || "Unknown";
    const budget = budgets.get(budget_id);
    const budgetName = budget?.name || "Others";
    const category_id = t.label.category_id;
    const category = category_id && categories.get(category_id);
    const section_id = (category && category.section_id) || `${budget_id}_Unknown`;
    const section = sections.get(section_id);
    // For an investment, only buy/sell rows are external cash flow; derive
    // their polarity from the transaction TYPE (a buy is cash out → expense /
    // positive amount, a sell is cash in → income / negative amount) rather
    // than from the stored sign of `quantity`, so it stays correct even if
    // Plaid emits a buy with a negative quantity. Every other type — `cash`,
    // `fee`, `dividend`, `transfer` — is skipped, matching benchmark.ts
    // (which counts only `Buy`/`Sell` at lib/hooks/calculation/benchmark.ts).
    // Skipping `transfer` matters: those carry a nonzero `price * quantity`
    // (internal movement, not external flow) and would otherwise inflate a
    // column. Including dividends/fees as flow is deferred per Closes #499.
    //
    // For a regular parent transaction, subtract its split children's total
    // so only the un-split remainder is attributed to the parent's label.
    // Synthetic split transactions (from `toTransaction()`) carry the
    // split's own id, which keys no family, so their amount is unchanged.
    let amount: number;
    if (isInvestment) {
      if (t.type !== InvestmentTransactionType.Buy && t.type !== InvestmentTransactionType.Sell) {
        return;
      }
      const magnitude = Math.abs(t.price * t.quantity);
      amount = t.type === InvestmentTransactionType.Buy ? magnitude : -magnitude;
    } else {
      amount = t.amount - transactionFamilies.getChildrenAmountTotal(t.transaction_id);
    }
    if (amount < 0) {
      income -= amount;
      incomeSections.set(section_id, {
        id: section_id,
        name: section?.name || "Unsorted",
        amount: (incomeSections.get(section_id)?.amount || 0) - amount,
        next: budget_id,
      });
      incomeBudgets.set(budget_id, {
        id: budget_id,
        name: budgetName,
        amount: (incomeBudgets.get(budget_id)?.amount || 0) - amount,
        next: "Total",
      });
    } else if (amount > 0) {
      expense += amount;
      expenseSections.set(section_id, {
        id: section_id,
        name: section?.name || "Unsorted",
        amount: (expenseSections.get(section_id)?.amount || 0) + amount,
        next: budget_id,
      });
      expenseBudgets.set(budget_id, {
        id: budget_id,
        name: budgetName,
        amount: (expenseBudgets.get(budget_id)?.amount || 0) + amount,
        next: "Total",
      });
    }
  };

  transactions.forEach(processTransaction);
  investmentTransactions.forEach(processTransaction);
  splitTransactions.forEach((st) => {
    // Guard on the PARENT's transaction_id — `toTransaction()` rewrites
    // the synthetic transaction's id to the split's own id, so the
    // in-`processTransaction` confirmed-transfer guard would never fire
    // for a split even when its parent is a confirmed transfer half.
    if (transfers.byTransactionId.hasConfirmed(st.transaction_id)) return;
    processTransaction(st.toTransaction());
  });

  const total = Math.max(income, expense);

  const intersectionBudgets = new Map<string, number>();
  incomeBudgets.forEach((v, k) => expenseBudgets.has(k) && intersectionBudgets.set(k, v.amount));

  const column1 = Array.from(incomeSections.values()).sort((a, b) => {
    const isAIntersection = !!a.next && intersectionBudgets.has(a.next);
    const isBIntersection = !!b.next && intersectionBudgets.has(b.next);
    if (isAIntersection !== isBIntersection) return +isBIntersection - +isAIntersection;
    if (isAIntersection && isBIntersection) {
      const intersectionBudgetDiff =
        intersectionBudgets.get(b.next!)! - intersectionBudgets.get(a.next!)!;
      if (intersectionBudgetDiff) return intersectionBudgetDiff;
    }
    const budgetA = a.next && incomeBudgets.get(a.next);
    const budgetB = b.next && incomeBudgets.get(b.next);
    if (!budgetA || !budgetB) return b.amount - a.amount;
    return budgetB.amount - budgetA.amount || b.amount - a.amount;
  });

  const column2 = Array.from(incomeBudgets.values()).sort((a, b) => {
    const isAIntersection = intersectionBudgets.has(a.id);
    const isBIntersection = intersectionBudgets.has(b.id);
    if (isAIntersection !== isBIntersection) return +isBIntersection - +isAIntersection;
    if (isAIntersection && isBIntersection) {
      const intersectionBudgetDiff =
        intersectionBudgets.get(b.id!)! - intersectionBudgets.get(a.id!)!;
      if (intersectionBudgetDiff) return intersectionBudgetDiff;
    }
    return b.amount - a.amount;
  });

  const column3: SankeyColumn = total
    ? [
        { id: "padding", name: "", amount: 0 },
        { id: "Total", name: "", amount: total },
      ]
    : [];

  const column4 = Array.from(expenseBudgets.values()).sort((a, b) => {
    const isAIntersection = intersectionBudgets.has(a.id);
    const isBIntersection = intersectionBudgets.has(b.id);
    if (isAIntersection !== isBIntersection) return +isBIntersection - +isAIntersection;
    if (isAIntersection && isBIntersection) {
      const intersectionBudgetDiff =
        intersectionBudgets.get(b.id!)! - intersectionBudgets.get(a.id!)!;
      if (intersectionBudgetDiff) return intersectionBudgetDiff;
    }
    return b.amount - a.amount;
  });

  const column5 = Array.from(expenseSections.values()).sort((a, b) => {
    const isAIntersection = !!a.next && intersectionBudgets.has(a.next);
    const isBIntersection = !!b.next && intersectionBudgets.has(b.next);
    if (isAIntersection !== isBIntersection) return +isBIntersection - +isAIntersection;
    if (isAIntersection && isBIntersection) {
      const intersectionBudgetDiff =
        intersectionBudgets.get(b.next!)! - intersectionBudgets.get(a.next!)!;
      if (intersectionBudgetDiff) return intersectionBudgetDiff;
    }
    const budgetA = a.next && expenseBudgets.get(a.next);
    const budgetB = b.next && expenseBudgets.get(b.next);
    if (!budgetA || !budgetB) return b.amount - a.amount;
    return budgetB.amount - budgetA.amount || b.amount - a.amount;
  });

  if (income < expense) {
    column1.push({
      id: "Deficit",
      name: "Deficit",
      amount: expense - income,
      color: "#f43",
      next: "Deficit",
      priority: 1,
    });
    column2.push({
      id: "Deficit",
      name: "",
      amount: expense - income,
      color: "#f43",
      next: "Total",
    });
  }

  if (income > expense) {
    column4.push({
      id: "Surplus",
      name: "",
      amount: income - expense,
      color: "#097",
      next: "Total",
    });
    column5.push({
      id: "Surplus",
      name: "Surplus",
      amount: income - expense,
      color: "#097",
      next: "Surplus",
      priority: 1,
    });
  }

  return {
    graphData: [column1, column2, column3, column4, column5],
    tableData: { income, expense },
  };
};

export interface SankeyRow {
  id: string;
  name: string;
  amount: number;
  next?: string;
  color?: string;
  priority?: number;
}

export type SankeyColumn = SankeyRow[];

export const getVerticalLines = (column: SankeyColumn, numberOfMargins: number): Line[] => {
  const margin = 0.03;
  const numberOfMarginsInThisColumn = column.length - 1;
  const unusedNumberOfMargins = numberOfMargins - numberOfMarginsInThisColumn;
  const numberOfExtraMarginsOntheTop = unusedNumberOfMargins / 2;
  const maxHeight = 1 - numberOfMargins * margin;
  const total = column.reduce((acc, { amount }) => acc + amount, 0);
  let yOffset = 1 - numberOfExtraMarginsOntheTop * margin;
  const result: { start: number; end: number }[] = [];
  column.forEach(({ amount }) => {
    const height = (amount / total) * maxHeight;
    result.push({ start: yOffset, end: Math.max(yOffset - height, 0) });
    yOffset -= height + margin;
  });
  return result;
};

export const getLinkPathData = (
  sourceLines: Line[],
  targetLine: Line,
  sourceOffset: number,
  targetOffset: number,
  height: number,
): string[] => {
  const targetLineLength = targetLine.start - targetLine.end;
  let targetOffsetTop = (1 - targetLine.start) * height;
  return sourceLines.map((sourceLine) => {
    const sourceLineLength = sourceLine.start - sourceLine.end;
    const scaleFactor = sourceLineLength / targetLineLength;
    const scaledSourceLine: Line = {
      start: (1 - sourceLine.start) * height,
      end: (1 - sourceLine.end) * height,
    };
    const scaledTargetLine: Line = {
      start: targetOffsetTop,
      end: targetLineLength * height * scaleFactor + targetOffsetTop,
    };
    const offsetMid = (sourceOffset + targetOffset) / 2;

    // a--b
    // |  c--d
    // |     |
    // h--g  |
    //    f--e
    const a: Point = [sourceOffset, scaledSourceLine.start];
    const b: Point = [offsetMid, scaledSourceLine.start];
    const c: Point = [offsetMid, scaledTargetLine.start];
    const d: Point = [targetOffset, scaledTargetLine.start];
    const e: Point = [targetOffset, scaledTargetLine.end];
    const f: Point = [offsetMid, scaledTargetLine.end];
    const g: Point = [offsetMid, scaledSourceLine.end];
    const h: Point = [sourceOffset, scaledSourceLine.end];

    targetOffsetTop = scaledTargetLine.end;

    return [
      // move to a
      `M${a[0]},${a[1]}`,
      // draw cubic bezier curve from a through b and c to d
      `C${b[0]},${b[1]},${c[0]},${c[1]},${d[0]},${d[1]}`,
      // draw straight line to e
      `L${e[0]},${e[1]}`,
      // draw cubic bezier curve from e through f and g to h
      `C${f[0]},${f[1]},${g[0]},${g[1]},${h[0]},${h[1]}`,
      // draw straight line to a
      `L${a[0]},${a[1]}`,
    ].join(" ");
  });
};
