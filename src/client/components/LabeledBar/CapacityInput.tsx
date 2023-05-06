import { numberToCommaString } from "common";
import { useState, useEffect, useRef, InputHTMLAttributes } from "react";

type Props = { defaultValue: number; isEditing: boolean } & Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "defaultValue"
>;

const CapacityInput = (props: Props) => {
  const {
    defaultValue,
    isEditing,
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

  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing) inputRef.current?.blur();
  }, [isEditing]);

  return (
    <input
      {...rest}
      ref={inputRef}
      value={_value}
      readOnly={!isEditing}
      className={className + (isEditing ? "" : " readonly")}
      onClick={(e) => {
        isEditing && e.stopPropagation();
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
        if (!isEditing) return e.target.blur();
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
