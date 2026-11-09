import { afterEach, describe, expect, it } from "bun:test";
import { cleanup, screen } from "@testing-library/react";
import { Data, Item } from "client";
import { ItemProvider, ItemStatus } from "common";
import { buildContext, renderWithContext, resetDom } from "test-render";
import { ConnectionProperties } from ".";

afterEach(() => {
  cleanup();
  resetDom();
});

/**
 * `MANUAL` keeps the render free of the Plaid Link button; the "Last
 * Updated" row is identical for every provider.
 */
const renderConnection = (updated?: string) => {
  const item = new Item({
    item_id: "item-785",
    status: ItemStatus.OK,
    provider: ItemProvider.MANUAL,
    updated,
  });
  renderWithContext(<ConnectionProperties item={item} />, buildContext({ data: new Data() }));
};

describe("ConnectionProperties — Last Updated (#785)", () => {
  it("formats a full ISO timestamp as a readable date", () => {
    // The exact value from the issue's repro (a Postgres timestamptz).
    renderConnection("2026-09-04T01:00:04.017909-07:00");

    expect(screen.getByText("Sep 4, 2026")).toBeTruthy();
    expect(screen.queryByText("2026-09-04T01:00:04.017909-07:00")).toBeNull();
  });

  it("formats a bare YYYY-MM-DD date on the local day", () => {
    // The documented shape of `Item.updated` (the sync writes `end_date`).
    // `new Date` on a bare date reads it as UTC midnight, which renders as
    // the previous day in US timezones — the `LocalDate` parse keeps it
    // on Sep 4.
    renderConnection("2026-09-04");

    expect(screen.getByText("Sep 4, 2026")).toBeTruthy();
    expect(screen.queryByText("2026-09-04")).toBeNull();
  });

  it("shows Unknown when there is no timestamp", () => {
    renderConnection(undefined);

    // The Status row reads "Ok", so "Unknown" can only be the Last
    // Updated row.
    expect(screen.getAllByText("Unknown")).toHaveLength(1);
  });

  it("shows Unknown, never Invalid Date, for an unparseable timestamp", () => {
    renderConnection("garbage");

    expect(screen.getAllByText("Unknown")).toHaveLength(1);
    expect(screen.queryByText("garbage")).toBeNull();
    expect(screen.queryByText("Invalid Date")).toBeNull();
  });
});
