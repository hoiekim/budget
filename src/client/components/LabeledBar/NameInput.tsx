import { DetailedHTMLProps, HTMLAttributes, useState, useEffect, useRef } from "react";

type Props = {
  isEditing: boolean;
  submit?: (value: string, onError?: () => void) => void;
} & DetailedHTMLProps<HTMLAttributes<HTMLInputElement>, HTMLInputElement>;

const CapacityInput = (props: Props) => {
  const { defaultValue, isEditing, submit, className, onClick, onChange, ...rest } =
    props;
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditing) inputRef.current?.blur();
  }, [isEditing]);

  const onError = () => setValue(defaultValue);

  return (
    <input
      {...rest}
      placeholder="name"
      value={value}
      readOnly={!isEditing}
      className={className + (isEditing ? "" : " readonly")}
      onChange={(e) => {
        const { value } = e.target;
        setValue(value);
        if (submit) submit(value, onError);
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
