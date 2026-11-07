import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import {
  Budget,
  Calculations,
  Capacity,
  CapacitySummary,
  Section,
  globalData,
  BudgetDictionary,
  SectionDictionary,
  CategoryDictionary,
} from "client";
import { buildContext, renderWithContext, resetDom } from "test-render";
import BudgetDonut from "./BudgetDonut";

afterEach(() => {
  cleanup();
  globalData.budgets = new BudgetDictionary();
  globalData.sections = new SectionDictionary();
  globalData.categories = new CategoryDictionary();
  resetDom();
});

const DATE = new Date(2026, 0, 15);

/**
 * A budget whose single section allocates its whole capacity, with zero
 * categories underneath (#783): the donut's unallocated figure must be
 * absent. Under the old code the figure measured the budget against its
 * grand-children (categories) instead of its children (sections), so a
 * fully-allocated budget with no categories rendered the whole capacity
 * as unallocated, in the red alert style.
 */
describe("BudgetDonut — unallocated diff (#783)", () => {
  it("shows no unallocated diff when one section allocates the whole budget", () => {
    const budget = new Budget({
      budget_id: "budget-783",
      name: "QA2",
      capacities: [new Capacity({ month: 1000 })],
    });
    const section = new Section({
      section_id: "section-783",
      budget_id: "budget-783",
      name: "S1",
      capacities: [new Capacity({ month: 1000 })],
    });
    globalData.budgets.set(budget.id, budget);
    globalData.sections.set(section.id, section);

    // `capacityData` is what the running app's recalculation fills in:
    // the budget's children_total is Σ sections (1000), its
    // grand_children_total is Σ categories (0 — no categories exist).
    const calculations = new Calculations();
    const budgetSummary = new CapacitySummary();
    budgetSummary.children_total = 1000;
    budgetSummary.grand_children_total = 0;
    calculations.capacityData.set(budget.getActiveCapacity(DATE).id, budgetSummary);
    const sectionSummary = new CapacitySummary();
    sectionSummary.children_total = 0;
    sectionSummary.grand_children_total = 0;
    calculations.capacityData.set(section.getActiveCapacity(DATE).id, sectionSummary);

    const capacityInput = budget.getActiveCapacity(DATE);
    renderWithContext(
      <BudgetDonut
        budgetLike={budget}
        date={DATE}
        isSyncedInput={false}
        capacityInput={capacityInput}
        defaultCapacityInput={capacityInput}
        onChangeAmount={() => {}}
      />,
      buildContext({ calculations }),
    );

    // The breakdown still lists the section that allocates the capacity…
    expect(screen.getByText("S1")).toBeTruthy();
    // …but the donut centre shows no red unallocated diff line. (The
    // breakdown's own per-section adjustment rows live under
    // `.CapacityBreakDown`, not `.centerLabel` — S1 genuinely has no
    // categories decomposing its amount, so its row is expected.)
    expect(document.querySelector(".centerLabel .colored.alert")).toBeNull();
  });
});
