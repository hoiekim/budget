import { numberToCommaString } from "common";
import { useState, useRef, InputHTMLAttributes, useEffect } from "react";

type Props = { defaultValue: number } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "defaultValue"
>;

const CapacityInput = (props: Props) => {
  const {
    defaultValue,
    className,
    onClick,
    onKeyPress,
    onChange,
    onFocus,
    onBlur,
    ...rest
  } = props;

  const defaultValueAsCommaString = numberToCommaString(defaultValue);
  const [_value, _setValue] = useState(defaultValueAsCommaString);

  useEffect(() => {
    _setValue(defaultValueAsCommaString);
  }, [defaultValueAsCommaString]);

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
        const commaString = numberToCommaString(numberizedValue);
        _setValue(commaString);
        if (onBlur) onBlur(e);
      }}
    />
  );
};

export default CapacityInput;
