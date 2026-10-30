import { numberToCommaString } from "common";
import {
  useState,
  useEffect,
  useRef,
  ChangeEvent,
  FocusEvent,
  InputHTMLAttributes,
  SetStateAction,
  Dispatch,
} from "react";

type DynamicCapacityInputProps = {
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  maxValue?: number;
  minValue?: number;
  fixed?: number;
  // Applied after the min/max clamps on blur, before both the rendered
  // string and the onBlur payload are derived — so the two can never
  // disagree the way a rounding display and a flooring consumer did.
  // Defaults to identity: no normalization, no behavior change.
  normalize?: (n: number) => number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "defaultValue" | "value">;

// Strip the input's own prefix (e.g. a non-USD currency code like "EUR") plus
// the "$", whitespace and comma separators, so a prefixed display value
// parses back to its number. Stripping only "$" left "EUR 1,234.56" as
// "EUR1234.56", which parses to NaN on focus and posts 0 on blur.
const stripPrefixAndSeparators = (value: string, prefix: string) => {
  const withoutPrefix =
    prefix && value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return withoutPrefix.replace(/[$\s,]/g, "");
};

export const DynamicCapacityInput = (props: DynamicCapacityInputProps) => {
  const {
    value,
    setValue,
    maxValue,
    minValue,
    fixed = 0,
    normalize,
    prefix = "",
    className,
    onClick,
    onKeyDown,
    onChange,
    onFocus,
    onBlur,
    ...rest
  } = props;

  const inputRef = useRef<HTMLInputElement>(null);

  return (
    <input
      {...rest}
      ref={inputRef}
      value={value}
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        if (onClick) onClick(e);
      }}
      onKeyDown={(e) => {
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !/[0-9.-]/.test(e.key))
          e.preventDefault();
        if (onKeyDown) onKeyDown(e);
        if (e.key === "Enter") inputRef.current?.blur();
      }}
      onChange={(e) => {
        setValue(e.target.value);
        if (onChange) onChange(e);
      }}
      onFocus={(e) => {
        setValue((+stripPrefixAndSeparators(e.target.value, prefix)).toString());
        if (onFocus) onFocus(e);
      }}
      onBlur={(e) => {
        const numberizedValue = +stripPrefixAndSeparators(e.target.value, prefix) || 0;
        const maxCappedValue = maxValue != null ? Math.min(maxValue, numberizedValue) : numberizedValue;
        const minCappedValue = minValue != null ? Math.max(minValue, maxCappedValue) : maxCappedValue;
        const normalized = normalize ? normalize(minCappedValue) : minCappedValue;
        const commaString = numberToCommaString(normalized, fixed);
        if (prefix) setValue(prefix + " " + commaString);
        else setValue(commaString);
        if (onBlur) onBlur({ ...e, target: { ...e.target, value: normalized.toString() } });
      }}
    />
  );
};

type CapacityInputProps = { defaultValue: number } & Omit<
  DynamicCapacityInputProps,
  "value" | "setValue"
>;

export const CapacityInput = (props: CapacityInputProps) => {
  const { defaultValue, fixed = 0, prefix = "", ...rest } = props;

  const defaultCapacityString = numberToCapacityString(defaultValue, fixed, prefix);
  const [_value, _setValue] = useState(defaultCapacityString);

  return (
    <DynamicCapacityInput
      value={_value}
      setValue={_setValue}
      fixed={fixed}
      prefix={prefix}
      {...rest}
    />
  );
};

const numberToCapacityString = (n: number, fixed = 0, prefix?: string) => {
  const commaString = numberToCommaString(n, fixed);
  return prefix ? prefix + " " + commaString : commaString;
};

type NumberChangeEvent = Omit<ChangeEvent<HTMLInputElement>, "target"> & {
  target: Omit<EventTarget & HTMLInputElement, "value"> & { value: number };
};
type NumberFocusEvent = Omit<FocusEvent<HTMLInputElement>, "target"> & {
  target: Omit<EventTarget & HTMLInputElement, "value"> & { value: number };
};

type CapacityNumberInputBaseProps = Omit<
  DynamicCapacityInputProps,
  "value" | "setValue" | "onChange" | "onFocus" | "onBlur"
> & {
  onChange?: (e: NumberChangeEvent) => void;
  onFocus?: (e: NumberFocusEvent) => void;
  onBlur?: (e: NumberFocusEvent) => void;
};

type CapacityNumberInputProps = CapacityNumberInputBaseProps &
  ({ value: number; setValue: Dispatch<number> } | { value?: never; setValue?: never });

const toNumberChangeEvent = (e: ChangeEvent<HTMLInputElement>, value: number): NumberChangeEvent =>
  ({ ...e, target: { ...e.target, value } }) as unknown as NumberChangeEvent;

const toNumberFocusEvent = (e: FocusEvent<HTMLInputElement>, value: number): NumberFocusEvent =>
  ({ ...e, target: { ...e.target, value } }) as unknown as NumberFocusEvent;

export const CapacityNumberInput = (props: CapacityNumberInputProps) => {
  const {
    value = 0,
    setValue,
    maxValue,
    minValue,
    fixed = 0,
    normalize,
    prefix = "",
    className,
    onClick,
    onKeyDown,
    onChange,
    onFocus,
    onBlur,
    ...rest
  } = props;

  const inputRef = useRef<HTMLInputElement>(null);
  const isFocused = useRef(false);

  const toDisplayString = (n: number) => {
    const commaString = numberToCommaString(n, fixed);
    return prefix ? prefix + " " + commaString : commaString;
  };

  const [_value, _setValue] = useState(toDisplayString(value));

  useEffect(() => {
    if (!isFocused.current) {
      const commaString = numberToCommaString(value, fixed);
      _setValue(prefix ? prefix + " " + commaString : commaString);
    }
  }, [value, fixed, prefix]);

  return (
    <input
      {...rest}
      ref={inputRef}
      value={_value}
      className={className}
      onClick={(e) => {
        e.stopPropagation();
        if (onClick) onClick(e);
      }}
      onKeyDown={(e) => {
        if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !/[0-9.-]/.test(e.key))
          e.preventDefault();
        if (onKeyDown) onKeyDown(e);
        if (e.key === "Enter") inputRef.current?.blur();
      }}
      onChange={(e) => {
        _setValue(e.target.value);
        const numericValue = +e.target.value.replace(/[$\s,]/g, "");
        if (isNaN(numericValue)) return;
        if (setValue) setValue(numericValue);
        if (onChange) onChange(toNumberChangeEvent(e, numericValue));
      }}
      onFocus={(e) => {
        isFocused.current = true;
        const numericValue = +e.target.value.replace(/[$\s,]/g, "");
        _setValue(numericValue.toString());
        if (onFocus) onFocus(toNumberFocusEvent(e, numericValue));
      }}
      onBlur={(e) => {
        isFocused.current = false;
        const numberizedValue = +e.target.value.replace(/[$\s,]/g, "") || 0;
        const maxCappedValue = maxValue != null ? Math.min(maxValue, numberizedValue) : numberizedValue;
        const minCappedValue = minValue != null ? Math.max(minValue, maxCappedValue) : maxCappedValue;
        const normalized = normalize ? normalize(minCappedValue) : minCappedValue;
        _setValue(toDisplayString(normalized));
        if (setValue) setValue(normalized);
        if (onBlur) onBlur(toNumberFocusEvent(e, normalized));
      }}
    />
  );
};
