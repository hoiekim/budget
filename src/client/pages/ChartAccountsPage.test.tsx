// Run with: bun test --preload ./scripts/test-preload.ts index.test.tsx
import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import {
  Account,
  Chart,
  ContextType,
  Data,
  PATH,
  ProjectionChartConfiguration,
} from "client";
import { ChartType } from "common";
import { buildContext, buildRouter, renderWithContext, resetDom, stubFetch } from "test-render";
import { ChartAccountsPage } from "./ChartAccountsPage";

let fetchStub: ReturnType<typeof stubFetch> | undefined;

afterEach(() => {
  // `cleanup()` first: unmount effects run inside it, and a request one of
  // them fires has to land on the stub rather than escape to a real one.
  cleanup();
  fetchStub?.restore();
  fetchStub = undefined;
  resetDom();
});

const CHART_ID = "chart-1";
const VISIBLE_ID = "acc-visible";
const HIDDEN_ID = "acc-hidden";
const DELETED_ID = "acc-deleted";

/**
 * A projection chart whose stored `account_ids` reference one visible
 * account, one hidden account, and one account that no longer exists —
 * the shape that used to brick the dashboard (#881).
 */
const buildData = () => {
  const data = new Data();
  data.accounts.set(
    VISIBLE_ID,
    new Account({ account_id: VISIBLE_ID, name: "Checking", hide: false } as never),
  );
  data.accounts.set(
    HIDDEN_ID,
    new Account({ account_id: HIDDEN_ID, name: "Old savings", hide: true } as never),
  );
  data.charts.set(
    CHART_ID,
    new Chart({
      chart_id: CHART_ID,
      name: "Retirement",
      type: ChartType.PROJECTION,
      configuration: new ProjectionChartConfiguration({
        account_ids: [VISIBLE_ID, HIDDEN_ID, DELETED_ID],
      }),
    }),
  );
  return data;
};

/** `setData` in the running app is a `useState` setter — apply the updater and keep the result. */
const buildStore = (data: Data) => {
  const store = { data };
  const setData: ContextType["setData"] = (action) => {
    store.data = typeof action === "function" ? action(store.data) : action;
  };
  return { store, setData };
};

const renderPage = (data: Data, setData: ContextType["setData"]) => {
  const { router } = buildRouter(
    PATH.CHART_ACCOUNTS,
    new URLSearchParams({ chart_id: CHART_ID }),
  );
  fetchStub = stubFetch([{ path: "/api/chart", response: { status: "success" } }]);
  renderWithContext(<ChartAccountsPage />, buildContext({ data, setData, router }));
};

const toggleInRow = (label: string) => {
  const row = screen.getByText(label).closest(".row");
  return row?.querySelector('input[type="checkbox"]') as HTMLInputElement;
};

const storedAccountIds = (store: { data: Data }) =>
  (
    store.data.charts.get(CHART_ID)?.configuration as ProjectionChartConfiguration
  ).account_ids;

describe("ChartAccountsPage — stale account ids", () => {
  it("surfaces a deleted account's id as a removable Missing account row", () => {
    const { store, setData } = buildStore(buildData());
    renderPage(store.data, setData);

    const toggle = toggleInRow("Missing account");
    expect(toggle).not.toBeNull();
    // the row lists the system note where visible rows list the account type
    expect(toggleInRow("Missing account")?.closest(".row")?.textContent).toContain(
      "account not found",
    );
  });

  it("surfaces a hidden account's stale id with its name so it can be removed", () => {
    const { store, setData } = buildStore(buildData());
    renderPage(store.data, setData);

    const toggle = toggleInRow("Old savings");
    expect(toggle).not.toBeNull();
    expect(toggle?.closest(".row")?.textContent).toContain("hidden");
    // the hidden account is not listed among the selectable accounts
    expect(screen.getAllByText("Old savings")).toHaveLength(1);
  });

  it("keeps visible accounts' rows exactly as before", () => {
    const { store, setData } = buildStore(buildData());
    renderPage(store.data, setData);

    const toggle = toggleInRow("Checking");
    expect(toggle).not.toBeNull();
    expect(toggle?.checked).toBe(true);
    expect(toggle?.closest(".row")?.textContent).not.toContain("Missing account");
  });

  it("removes the stale id when its row is toggled off", async () => {
    const { store, setData } = buildStore(buildData());
    renderPage(store.data, setData);

    await act(async () => {
      fireEvent.click(toggleInRow("Missing account"));
    });

    expect(storedAccountIds(store)).toEqual([VISIBLE_ID, HIDDEN_ID]);
    expect(fetchStub?.calls.requests.map((r) => r.url)).toEqual(["/api/chart"]);
  });

  it("removes the hidden account's stale id when its row is toggled off", async () => {
    const { store, setData } = buildStore(buildData());
    renderPage(store.data, setData);

    await act(async () => {
      fireEvent.click(toggleInRow("Old savings"));
    });

    expect(storedAccountIds(store)).toEqual([VISIBLE_ID, DELETED_ID]);
  });

  it("toggling a visible account off keeps the stale ids intact", async () => {
    const { store, setData } = buildStore(buildData());
    renderPage(store.data, setData);

    await act(async () => {
      fireEvent.click(toggleInRow("Checking"));
    });

    expect(storedAccountIds(store)).toEqual([HIDDEN_ID, DELETED_ID]);
  });
});
