import { ViewDate } from "common";
import {
  Account,
  BudgetDictionary,
  CategoryDictionary,
  Line,
  Point,
  SectionDictionary,
  TransactionDictionary,
} from "client";

export interface SankeyData {
  graphData: SankeyColumn[];
  tableData: { income: number; expense: number };
}

export const getSankeyData = (
  accounts: Account[],
  transactions: TransactionDictionary,
  budgets: BudgetDictionary,
  sections: SectionDictionary,
  categories: CategoryDictionary,
  viewDate: ViewDate,
): SankeyData => {
  const incomeBudgets = new Map<string, SankeyRow>();
  const incomeSections = new Map<string, SankeyRow>();
  const expenseBudgets = new Map<string, SankeyRow>();
  const expenseSections = new Map<string, SankeyRow>();

  let income = 0;
  let expense = 0;

  transactions.forEach((t) => {
    const transactionDate = new Date(t.authorized_date || t.date);
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
    if (t.amount < 0) {
      income -= t.amount;
      incomeSections.set(section_id, {
        id: section_id,
        name: section?.name || "Unsorted",
        amount: (incomeSections.get(section_id)?.amount || 0) - t.amount,
        next: budget_id,
      });
      incomeBudgets.set(budget_id, {
        id: budget_id,
        name: budgetName,
        amount: (incomeBudgets.get(budget_id)?.amount || 0) - t.amount,
        next: "Total",
      });
    } else if (t.amount > 0) {
      expense += t.amount;
      expenseSections.set(section_id, {
        id: section_id,
        name: section?.name || "Unsorted",
        amount: (expenseSections.get(section_id)?.amount || 0) + t.amount,
        next: budget_id,
      });
      expenseBudgets.set(budget_id, {
        id: budget_id,
        name: budgetName,
        amount: (expenseBudgets.get(budget_id)?.amount || 0) + t.amount,
        next: "Total",
      });
    }
  });

  const total = Math.max(income, expense);

  const column1 = Array.from(incomeSections.values()).sort((a, b) => {
    const budgetA = a.next && incomeBudgets.get(a.next);
    const budgetB = b.next && incomeBudgets.get(b.next);
    if (!budgetA || !budgetB) return b.amount - a.amount;
    return budgetB.amount - budgetA.amount || b.amount - a.amount;
  });
  const column2 = Array.from(incomeBudgets.values()).sort((a, b) => b.amount - a.amount);
  const column3: SankeyColumn = total
    ? [
        { id: "padding", name: "", amount: 0 },
        { id: "Total", name: "", amount: total },
      ]
    : [];
  const column4 = Array.from(expenseBudgets.values()).sort((a, b) => b.amount - a.amount);
  const column5 = Array.from(expenseSections.values()).sort((a, b) => {
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
}

export type SankeyColumn = SankeyRow[];

export const getVerticalLines = (column: SankeyColumn, numberOfMargins: number): Line[] => {
  const margin = 0.03;
  const maxHeight = 1 - numberOfMargins * margin;
  let total = column.reduce((acc, { amount }) => acc + amount, 0);
  let yOffset = 1;
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
