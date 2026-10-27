import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { Budget, BudgetData, BudgetHistory, Calculations, Capacity } from "client";
import { buildContext, renderWithContext, resetDom } from "test-render";
import { useBudgetGraph } from "./hooks";

afterEach(() => {
  cleanup();
  resetDom();
});

const Probe = ({ budget }: { budget: Budget }) => {
  const { graphData } = useBudgetGraph(budget);
  const sequences = (graphData.lines || []).map((line) => line.sequence);
  return <div data-testid="sequences">{JSON.stringify(sequences)}</div>;
};

describe("useBudgetGraph", () => {
  it("plots an income budget's earning line as a positive magnitude, not a clamped zero", () => {
    // An income budget's stored amounts are negative; the graph's capacity
    // line already normalizes with the income sign, and the spending
    // series must be normalized the same way or the negative clamp below
    // flattens every period to the baseline (budget#822).
    const budget = new Budget({
      budget_id: "income-budget",
      name: "Salary",
      capacities: [new Capacity({ month: -500 })],
    });
    const history = new BudgetHistory();
    history.set(new Date(2025, 10, 15), { sorted_amount: -300, unsorted_amount: -100 });
    history.set(new Date(2025, 11, 15), { sorted_amount: -300, unsorted_amount: -100 });
    history.set(new Date(2026, 0, 15), { sorted_amount: -300, unsorted_amount: -100 });
    const budgetData = new BudgetData();
    budgetData.set(budget.id, history);
    const calculations = new Calculations({ budgetData });

    renderWithContext(<Probe budget={budget} />, buildContext({ calculations }));

    const sequences = JSON.parse(screen.getByTestId("sequences").textContent || "[]") as unknown[][];
    // lines[0] is the capacity line, lines[1] the spending/earning line.
    expect(sequences).toHaveLength(2);
    expect(sequences[0]).toContain(500);
    expect(sequences[1]).toContain(400);
    expect(sequences[1]).not.toContain(0);
  });

  it("leaves an expense budget's spending line unchanged", () => {
    const budget = new Budget({
      budget_id: "expense-budget",
      name: "Groceries",
      capacities: [new Capacity({ month: 500 })],
    });
    const history = new BudgetHistory();
    history.set(new Date(2025, 10, 15), { sorted_amount: 300, unsorted_amount: 100 });
    history.set(new Date(2025, 11, 15), { sorted_amount: 300, unsorted_amount: 100 });
    history.set(new Date(2026, 0, 15), { sorted_amount: 300, unsorted_amount: 100 });
    const budgetData = new BudgetData();
    budgetData.set(budget.id, history);
    const calculations = new Calculations({ budgetData });

    renderWithContext(<Probe budget={budget} />, buildContext({ calculations }));

    const sequences = JSON.parse(screen.getByTestId("sequences").textContent || "[]") as unknown[][];
    expect(sequences).toHaveLength(2);
    expect(sequences[0]).toContain(500);
    expect(sequences[1]).toContain(400);
  });
});
