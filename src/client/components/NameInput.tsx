import { useState, useEffect, InputHTMLAttributes } from "react";

const CapacityInput = (props: InputHTMLAttributes<HTMLInputElement>) => {
  const { defaultValue, className, onClick, onChange, ...rest } = props;
  const [_value, _setValue] = useState(defaultValue || "");

  useEffect(() => {
    if (defaultValue) _setValue(defaultValue);
  }, [defaultValue]);

  return (
    <input
      {...rest}
      placeholder="name"
      value={_value}
      className={className}
      onChange={(e) => {
        _setValue(e.target.value);
        if (onChange) onChange(e);
      }}
      onClick={(e) => {
        e.stopPropagation();
        if (onClick) onClick(e);
      }}
    />
  );
};

export default CapacityInput;
