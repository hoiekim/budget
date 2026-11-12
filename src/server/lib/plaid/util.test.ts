import { describe, expect, it, mock, beforeEach } from "bun:test";
import { PlaidErrorType, Products } from "plaid";
import type { JSONItem } from "common";
import type { MaskedUser } from "server";
import { handlePlaidSyncError } from "./util";

const mockUpsertItems = mock(() => Promise.resolve());
const mockUpdateItemStatus = mock(() => Promise.resolve());

beforeEach(() => {
  mockUpsertItems.mockClear();
  mockUpdateItemStatus.mockClear();
});

const user = {} as unknown as MaskedUser;
const makeItem = (overrides: Partial<JSONItem> = {}): JSONItem =>
  ({
    item_id: "item-1",
    available_products: [Products.Investments, Products.Transactions],
    ...overrides,
  }) as unknown as JSONItem;

const plaidFailure = (error_code: string, error_type: string = PlaidErrorType.ApiError) => {
  const error = new Error(error_code) as Error & {
    response: { data: { error_code: string; error_type: string } };
  };
  error.response = { data: { error_code, error_type } };
  return error;
};

const baseOpts = (item: JSONItem) => ({
  user,
  item,
  logLabel: "accounts",
  updateItemStatusFn: mockUpdateItemStatus,
  upsertItemsFn: mockUpsertItems,
});

describe("handlePlaidSyncError", () => {
  it("recovers from PRODUCTS_NOT_SUPPORTED when the caller opts in", () => {
    const item = makeItem();
    const { plaidError, outcome } = handlePlaidSyncError(
      plaidFailure("PRODUCTS_NOT_SUPPORTED"),
      {
        ...baseOpts(item),
        unsupportedMessage: "Holdings not supported for item",
      },
    );

    expect(outcome).toBe("unsupported");
    expect(plaidError?.error_code).toBe("PRODUCTS_NOT_SUPPORTED");
    expect(mockUpsertItems).toHaveBeenCalledTimes(1);
    const written = mockUpsertItems.mock.calls[0][1] as JSONItem[];
    expect(written[0].available_products).toEqual([Products.Transactions]);
    expect(mockUpdateItemStatus).not.toHaveBeenCalled();
  });

  it("treats PRODUCTS_NOT_SUPPORTED as a plain failure when the caller does not opt in", () => {
    const item = makeItem();
    const { outcome } = handlePlaidSyncError(
      plaidFailure("PRODUCTS_NOT_SUPPORTED"),
      baseOpts(item),
    );

    expect(outcome).toBe("failed");
    expect(mockUpsertItems).not.toHaveBeenCalled();
  });

  it("stays silent on ignorable codes", () => {
    const item = makeItem();
    const { plaidError, outcome } = handlePlaidSyncError(
      plaidFailure("NO_INVESTMENT_ACCOUNTS"),
      baseOpts(item),
    );

    expect(outcome).toBe("ignorable");
    expect(plaidError?.error_code).toBe("NO_INVESTMENT_ACCOUNTS");
    expect(mockUpsertItems).not.toHaveBeenCalled();
    expect(mockUpdateItemStatus).not.toHaveBeenCalled();
  });

  it("escalates an ItemError failure to BAD", () => {
    const item = makeItem();
    const { outcome } = handlePlaidSyncError(
      plaidFailure("INTERNAL_SERVER_ERROR", PlaidErrorType.ItemError),
      baseOpts(item),
    );

    expect(outcome).toBe("failed");
    expect(mockUpdateItemStatus).toHaveBeenCalledTimes(1);
    expect(mockUpdateItemStatus.mock.calls[0].slice(1)).toEqual([
      "item-1",
      "bad",
      "INTERNAL_SERVER_ERROR",
    ]);
  });

  it("does not escalate a non-ItemError failure", () => {
    const item = makeItem();
    const { outcome } = handlePlaidSyncError(
      plaidFailure("INTERNAL_SERVER_ERROR"),
      baseOpts(item),
    );

    expect(outcome).toBe("failed");
    expect(mockUpdateItemStatus).not.toHaveBeenCalled();
  });

  it("escalates ITEM_LOGIN_REQUIRED when the caller warns on it", () => {
    const item = makeItem();
    const { outcome } = handlePlaidSyncError(
      plaidFailure("ITEM_LOGIN_REQUIRED", PlaidErrorType.ItemError),
      { ...baseOpts(item), warnOnLoginRequired: true },
    );

    expect(outcome).toBe("failed");
    expect(mockUpdateItemStatus).toHaveBeenCalledTimes(1);
  });

  it("reports a transport error as failed with no plaidError", () => {
    const item = makeItem();
    const { plaidError, outcome } = handlePlaidSyncError(
      new Error("socket hangup"),
      baseOpts(item),
    );

    expect(outcome).toBe("failed");
    expect(plaidError).toBeUndefined();
    expect(mockUpdateItemStatus).not.toHaveBeenCalled();
  });
});
