import { numberToCommaString } from "common";
import { useState, useRef, InputHTMLAttributes } from "react";

type Props = { defaultValue: number; fixed?: number } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "defaultValue"
>;

export const CapacityInput = (props: Props) => {
  const {
    defaultValue,
    fixed = 0,
    className,
    onClick,
    onKeyPress,
    onChange,
    onFocus,
    onBlur,
    ...rest
  } = props;

  const defaultValueAsCommaString = numberToCommaString(defaultValue, fixed);
  const [_value, _setValue] = useState(defaultValueAsCommaString);

  const inputRef = useRef<HTMLInputElement>(null);

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
      onKeyPress={(e) => {
        if (!/[0-9.-]/.test(e.key)) e.preventDefault();
        if (onKeyPress) onKeyPress(e);
        if (e.key === "Enter") inputRef.current?.blur();
      }}
      onChange={(e) => {
        _setValue(e.target.value);
        if (onChange) onChange(e);
      }}
      onFocus={(e) => {
        _setValue((+e.target.value.replace(/,/g, "")).toString());
        if (onFocus) onFocus(e);
      }}
      onBlur={(e) => {
        const numberizedValue = +e.target.value.replace(/,/g, "") || 0;
        const commaString = numberToCommaString(numberizedValue, fixed);
        _setValue(commaString);
        if (onBlur) onBlur(e);
      }}
    />
  );
};
