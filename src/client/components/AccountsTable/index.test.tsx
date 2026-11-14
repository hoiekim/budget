import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { PATH } from "client";
import { buildContext, buildRouter, renderWithContext, resetDom } from "test-render";
import { AccountsTable } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

describe("AccountsTable — empty state", () => {
  it("offers a Connect Accounts button that routes to Configuration (#788)", async () => {
    const { router, calls } = buildRouter(PATH.ACCOUNTS);

    renderWithContext(<AccountsTable donutData={[]} />, buildContext({ router }));

    // The placeholder's "this button" must resolve to a control on the
    // page — before this fix the empty state rendered the text with no
    // button at all.
    const button = screen.getByRole("button", { name: /^Connect.Accounts$/ });
    expect(button).toBeDefined();
    expect(screen.getByText(/You don't have any connected accounts/)).toBeDefined();

    await act(async () => {
      fireEvent.click(button);
    });
    expect(calls.go).toHaveLength(1);
    expect(calls.go[0].path).toBe(PATH.CONFIG);
  });
});
