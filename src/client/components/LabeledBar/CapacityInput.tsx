import { numberToCommaString } from "client";
import { DetailedHTMLProps, HTMLAttributes, useState, useEffect, useRef } from "react";

type Props = {
  isEditing: boolean;
  submit?: (value: string, onError?: () => void) => void;
} & DetailedHTMLProps<HTMLAttributes<HTMLInputElement>, HTMLInputElement>;

const CapacityInput = (props: Props) => {
  const {
    defaultValue,
    isEditing,
    submit,
    className,
    onClick,
    onKeyPress,
    onChange,
    onFocus,
    onBlur,
    ...rest
  } = props;

  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing) inputRef.current?.blur();
  }, [isEditing]);

  const onError = () => setValue(defaultValue);

  return (
    <input
      {...rest}
      ref={inputRef}
      value={value}
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
        const { value } = e.target;
        setValue(value);
        if (submit) submit(value, onError);
        if (onChange) onChange(e);
      }}
      onFocus={(e) => {
        const { target } = e;
        if (!isEditing) return target.blur();
        setValue(target.value.replace(/,/g, ""));
        if (onFocus) onFocus(e);
      }}
      onBlur={(e) => {
        const { value } = e.target;
        const numberizedValue = +value.replace(/,/g, "") || 0;
        const commaString = numberToCommaString(numberizedValue);
        setValue(commaString);
        if (onBlur) onBlur(e);
      }}
    />
  );
};

export default CapacityInput;
