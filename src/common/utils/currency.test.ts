import { describe, expect, test } from "bun:test";
import { currencyCodeToSymbol } from "./index";

describe("currencyCodeToSymbol", () => {
  test("USD renders as $", () => {
    expect(currencyCodeToSymbol("USD")).toBe("$");
  });

  test("missing codes render as $ — one default for every surface", () => {
    expect(currencyCodeToSymbol(null)).toBe("$");
    expect(currencyCodeToSymbol(undefined)).toBe("$");
    expect(currencyCodeToSymbol("")).toBe("$");
  });

  test("non-USD codes render as themselves", () => {
    expect(currencyCodeToSymbol("EUR")).toBe("EUR");
    expect(currencyCodeToSymbol("JPY")).toBe("JPY");
  });
});
