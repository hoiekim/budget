import { describe, expect, it } from "bun:test";
import { InvestmentTransactionType } from "plaid";
import { mintInvestmentTransactionRequest } from "./useTransactionEntry";

// The mint stores the row it is asked for, so the type has to travel with the
// request. Nothing downstream can recover it: the server sees a quantity and
// a price, and deciding direction from those is the inference this whole
// change exists to remove.
describe("the request a mint is asked with", () => {
  const account_id = "acc-1";

  it("names a sale when the caller is reconciling shares away", () => {
    const { params, canonical } = mintInvestmentTransactionRequest({
      account_id,
      quantity: -5,
      price: 30,
    });

    expect(params.type).toBe(InvestmentTransactionType.Sell);
    expect(canonical.type).toBe(InvestmentTransactionType.Sell);
  });

  it("names a purchase for shares arriving", () => {
    const { params } = mintInvestmentTransactionRequest({
      account_id,
      quantity: 4,
      price: 25,
    });

    expect(params.type).toBe(InvestmentTransactionType.Buy);
  });

  it("names one even when the caller supplies no quantity at all", () => {
    const { params } = mintInvestmentTransactionRequest({ account_id });

    expect(params.type).toBe(InvestmentTransactionType.Buy);
  });

  // The row the caller shows immediately and the row the mint stores are the
  // same row, so they are built from one reconciliation rather than two.
  it("hands back the same values it asked for, so the optimistic copy agrees", () => {
    const { params, canonical } = mintInvestmentTransactionRequest({
      account_id,
      quantity: -5,
      price: 30,
    });

    expect(Number(params.quantity)).toBe(canonical.quantity);
    expect(canonical.amount).toBeCloseTo(canonical.price * canonical.quantity, 2);
    expect(canonical.amount).toBeCloseTo(-150, 2);
  });

  it("rounds a quantity that floating-point subtraction left noisy", () => {
    const { params } = mintInvestmentTransactionRequest({
      account_id,
      quantity: 0.6232000000000539,
    });

    expect(params.quantity).toBe("0.6232");
  });
});
