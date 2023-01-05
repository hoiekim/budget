import { useState, useEffect, useRef, InputHTMLAttributes } from "react";

type Props = { isEditing: boolean } & InputHTMLAttributes<HTMLInputElement>;

const CapacityInput = (props: Props) => {
  const { isEditing, defaultValue, className, onClick, onChange, ...rest } = props;
  const [_value, _setValue] = useState(defaultValue || "");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing) inputRef.current?.blur();
  }, [isEditing]);

  return (
    <input
      {...rest}
      placeholder="name"
      value={_value}
      readOnly={!isEditing}
      className={className + (isEditing ? "" : " readonly")}
      onChange={(e) => {
        _setValue(e.target.value);
        if (onChange) onChange(e);
      }}
      onClick={(e) => {
        isEditing && e.stopPropagation();
        if (onClick) onClick(e);
      }}
    />
  );
};

export default CapacityInput;
