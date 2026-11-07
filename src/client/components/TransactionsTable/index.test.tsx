import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { buildContext, renderWithContext, resetDom } from "test-render";
import { TransactionsTable } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

describe("TransactionsTable — empty state", () => {
  it("explains an empty period instead of rendering a bare list (#788)", () => {
    renderWithContext(<TransactionsTable transactions={[]} />, buildContext());

    // Before this fix an empty period rendered only the sort header row
    // over nothing, indistinguishable from a failed load.
    expect(screen.getByText("No transactions in this period.")).toBeDefined();
  });
});
