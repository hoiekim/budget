import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { renderWithContext, resetDom, buildContext } from "test-render";
import { DynamicCapacityInput } from "./CapacityInput";

afterEach(() => {
  cleanup();
  resetDom();
});

// Controlled wrapper: mirrors how AccountProperties drives the input.
const Wrapper = ({
  initial,
  prefix,
  onBlurValue,
}: {
  initial: string;
  prefix: string;
  onBlurValue?: (v: string) => void;
}) => {
  const [value, setValue] = useState(initial);
  return (
    <DynamicCapacityInput
      value={value}
      setValue={setValue}
      prefix={prefix}
      fixed={2}
      onBlur={(e) => onBlurValue?.(e.target.value)}
    />
  );
};

const renderInput = (initial: string, prefix: string, onBlurValue?: (v: string) => void) =>
  renderWithContext(
    <Wrapper initial={initial} prefix={prefix} onBlurValue={onBlurValue} />,
    buildContext(),
  );

describe("DynamicCapacityInput with a non-USD prefix", () => {
  it("focus strips the prefix instead of producing NaN", () => {
    renderInput("EUR 1,234.56", "EUR");
    const input = screen.getByDisplayValue("EUR 1,234.56") as HTMLInputElement;
    act(() => {
      fireEvent.focus(input);
    });
    expect(input.value).toBe("1234.56");
  });

  it("blur re-applies the prefix and reports the number, not 0", () => {
    const seen: string[] = [];
    renderInput("EUR 1,234.56", "EUR", (v) => seen.push(v));
    const input = screen.getByDisplayValue("EUR 1,234.56") as HTMLInputElement;
    act(() => {
      fireEvent.focus(input);
    });
    act(() => {
      fireEvent.blur(input);
    });
    expect(input.value).toBe("EUR 1,234.56");
    expect(seen).toEqual(["1234.56"]);
  });

  it("keeps the existing $ behavior for USD-prefixed values", () => {
    renderInput("$ 1,234.56", "$");
    const input = screen.getByDisplayValue("$ 1,234.56") as HTMLInputElement;
    act(() => {
      fireEvent.focus(input);
    });
    expect(input.value).toBe("1234.56");
  });
});
