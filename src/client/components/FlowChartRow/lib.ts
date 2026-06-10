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
  Transaction,
  TransactionDictionary,
} from "client";

export interface SankeyData {
  graphData: SankeyColumn[];
  tableData: { income: number; expense: number };
}

/**
 * Internal accumulator: signed sum per (section_id / budget_id) before
 * partitioning into income vs expense. Sign convention follows Plaid /
 * `transactions.amount` — positive = debit (money out, expense),
 * negative = credit (money in, income). After all transactions are
 * processed we partition by net sign so a section whose debits and
 * credits cancel (Transfers) doesn't double-count on both sides of
 * the chart.
 */
interface SignedRow {
  id: string;
  name: string;
  signedAmount: number;
  next?: string;
}

export const getSankeyData = (
  accounts: Account[],
  transactions: TransactionDictionary,
  investmentTransactions: InvestmentTransactionDictionary,
  budgets: BudgetDictionary,
  sections: SectionDictionary,
  categories: CategoryDictionary,
  viewDate: ViewDate,
): SankeyData => {
  const sectionTotals = new Map<string, SignedRow>();
  const budgetTotals = new Map<string, SignedRow>();

  const processTransaction = (t: Transaction | InvestmentTransaction) => {
    const isInvestment = t instanceof InvestmentTransaction;
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
    const amount = isInvestment ? -(t.price * t.quantity) : t.amount;
    if (amount === 0) return;

    const prevSection = sectionTotals.get(section_id);
    sectionTotals.set(section_id, {
      id: section_id,
      name: section?.name || "Unsorted",
      signedAmount: (prevSection?.signedAmount || 0) + amount,
      next: budget_id,
    });

    const prevBudget = budgetTotals.get(budget_id);
    budgetTotals.set(budget_id, {
      id: budget_id,
      name: budgetName,
      signedAmount: (prevBudget?.signedAmount || 0) + amount,
    });
  };

  transactions.forEach(processTransaction);
  investmentTransactions.forEach(processTransaction);

  // Partition by net sign. A section/budget whose debits and credits
  // perfectly cancel (e.g. self-transfers labeled to the Transfers
  // section) nets to 0 and drops out entirely — matching the Budget
  // page's `sorted_amount` aggregation. Magnitude on the chart is the
  // absolute net, so partial offsets (a refund inside a Shopping
  // section) reduce the bar to the remaining net spending.
  const incomeBudgets = new Map<string, SankeyRow>();
  const incomeSections = new Map<string, SankeyRow>();
  const expenseBudgets = new Map<string, SankeyRow>();
  const expenseSections = new Map<string, SankeyRow>();

  let income = 0;
  let expense = 0;

  sectionTotals.forEach((row) => {
    if (row.signedAmount < 0) {
      const abs = -row.signedAmount;
      incomeSections.set(row.id, { id: row.id, name: row.name, amount: abs, next: row.next });
    } else if (row.signedAmount > 0) {
      expenseSections.set(row.id, {
        id: row.id,
        name: row.name,
        amount: row.signedAmount,
        next: row.next,
      });
    }
  });

  budgetTotals.forEach((row) => {
    if (row.signedAmount < 0) {
      const abs = -row.signedAmount;
      income += abs;
      incomeBudgets.set(row.id, { id: row.id, name: row.name, amount: abs, next: "Total" });
    } else if (row.signedAmount > 0) {
      expense += row.signedAmount;
      expenseBudgets.set(row.id, {
        id: row.id,
        name: row.name,
        amount: row.signedAmount,
        next: "Total",
      });
    }
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
