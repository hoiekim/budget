import { numberToCommaString } from "common";
import { useState, useRef, InputHTMLAttributes, SetStateAction, Dispatch } from "react";

type DynamicCapacityInputProps = {
  value: string;
  setValue: Dispatch<SetStateAction<string>>;
  maxValue?: number;
  minValue?: number;
  fixed?: number;
} & Omit<InputHTMLAttributes<HTMLInputElement>, "defaultValue" | "value">;

export const DynamicCapacityInput = (props: DynamicCapacityInputProps) => {
  const {
    value,
    setValue,
    maxValue,
    minValue,
    fixed = 0,
    prefix = "",
    className,
    onClick,
    onKeyPress,
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
      onKeyPress={(e) => {
        if (!/[0-9.-]/.test(e.key)) e.preventDefault();
        if (onKeyPress) onKeyPress(e);
        if (e.key === "Enter") inputRef.current?.blur();
      }}
      onChange={(e) => {
        setValue(e.target.value);
        if (onChange) onChange(e);
      }}
      onFocus={(e) => {
        setValue((+e.target.value.replace(/[$\s,]/g, "")).toString());
        if (onFocus) onFocus(e);
      }}
      onBlur={(e) => {
        const numberizedValue = +e.target.value.replace(/[$\s,]/g, "") || 0;
        const maxCappedValue = maxValue ? Math.min(maxValue, numberizedValue) : numberizedValue;
        const minCappedValue = minValue ? Math.max(minValue, maxCappedValue) : maxCappedValue;
        const commaString = numberToCommaString(minCappedValue, fixed);
        if (prefix) setValue(prefix + " " + commaString);
        else setValue(commaString);
        if (onBlur) onBlur({ ...e, target: { ...e.target, value: minCappedValue.toString() } });
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

  const defaultValueAsCommaString = numberToCommaString(defaultValue, fixed);
  const prefixedDefaultValue = prefix
    ? prefix + " " + defaultValueAsCommaString
    : defaultValueAsCommaString;
  const [_value, _setValue] = useState(prefixedDefaultValue);

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
