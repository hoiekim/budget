import { afterEach, describe, expect, it } from "bun:test";
import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { useState } from "react";
import { renderWithContext, resetDom, buildContext } from "test-render";
import { DynamicCapacityInput, CapacityNumberInput } from "./CapacityInput";

afterEach(() => {
  cleanup();
  resetDom();
});

// Controlled wrapper: mirrors how AccountProperties drives the input.
const Wrapper = ({
  initial,
  prefix,
  fixed = 2,
  normalize,
  onBlurValue,
}: {
  initial: string;
  prefix: string;
  fixed?: number;
  normalize?: (n: number) => number;
  onBlurValue?: (v: string) => void;
}) => {
  const [value, setValue] = useState(initial);
  return (
    <DynamicCapacityInput
      value={value}
      setValue={setValue}
      prefix={prefix}
      fixed={fixed}
      normalize={normalize}
      onBlur={(e) => onBlurValue?.(e.target.value)}
    />
  );
};

const renderInput = (
  initial: string,
  prefix: string,
  onBlurValue?: (v: string) => void,
  opts?: { fixed?: number; normalize?: (n: number) => number },
) =>
  renderWithContext(
    <Wrapper initial={initial} prefix={prefix} onBlurValue={onBlurValue} {...opts} />,
    buildContext(),
  );

const blurInput = (input: HTMLInputElement) => {
  act(() => {
    fireEvent.focus(input);
  });
  act(() => {
    fireEvent.blur(input);
  });
};

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
});

describe("DynamicCapacityInput with normalize", () => {
  // The budget capacity rule: floor + abs, as CapacitiesInput passes it.
  const normalize = (n: number) => Math.floor(Math.abs(n));

  it("blurs a fractional entry to the value that will be persisted", () => {
    const seen: string[] = [];
    renderInput("1234.56", "", (v) => seen.push(v), { fixed: 0, normalize });
    const input = screen.getByDisplayValue("1234.56") as HTMLInputElement;
    blurInput(input);
    expect(input.value).toBe("1,234");
    expect(seen).toEqual(["1234"]);
  });

  it("blurs a negative entry to the sign-stripped value that will be persisted", () => {
    const seen: string[] = [];
    renderInput("-500", "", (v) => seen.push(v), { fixed: 0, normalize });
    const input = screen.getByDisplayValue("-500") as HTMLInputElement;
    blurInput(input);
    expect(input.value).toBe("500");
    expect(seen).toEqual(["500"]);
  });
});

describe("CapacityNumberInput with normalize", () => {
  it("blurs a fractional entry to the normalized display and value", () => {
    const setValues: number[] = [];
    const blurValues: number[] = [];
    renderWithContext(
      <CapacityNumberInput
        value={0}
        setValue={(n) => setValues.push(n)}
        fixed={0}
        normalize={(n) => Math.floor(Math.abs(n))}
        onBlur={(e) => blurValues.push(e.target.value)}
      />,
      buildContext(),
    );
    const input = screen.getByDisplayValue("0") as HTMLInputElement;
    act(() => {
      fireEvent.change(input, { target: { value: "1234.56" } });
    });
    blurInput(input);
    expect(input.value).toBe("1,234");
    expect(setValues[setValues.length - 1]).toBe(1234);
    expect(blurValues).toEqual([1234]);
  });
});

describe("DynamicCapacityInput with a non-USD prefix", () => {
  it("keeps the existing $ behavior for USD-prefixed values", () => {
    renderInput("$ 1,234.56", "$");
    const input = screen.getByDisplayValue("$ 1,234.56") as HTMLInputElement;
    act(() => {
      fireEvent.focus(input);
    });
    expect(input.value).toBe("1234.56");
  });
});