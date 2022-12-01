import { DetailedHTMLProps, HTMLAttributes, useState, useEffect, useRef } from "react";

type Props = {
  isEditting: boolean;
  submit?: (value: string, onError?: () => void) => void;
} & DetailedHTMLProps<HTMLAttributes<HTMLInputElement>, HTMLInputElement>;

const CapacityInput = (props: Props) => {
  const { defaultValue, isEditting, submit, className, onClick, onChange, ...rest } =
    props;
  const [value, setValue] = useState(defaultValue);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!isEditting) inputRef.current?.blur();
  }, [isEditting]);

  const onError = () => setValue(defaultValue);

  return (
    <input
      {...rest}
      placeholder="name"
      value={value}
      readOnly={!isEditting}
      className={className + (isEditting ? "" : " readonly")}
      onChange={(e) => {
        const { value } = e.target;
        setValue(value);
        if (submit) submit(value, onError);
        if (onChange) onChange(e);
      }}
      onClick={(e) => {
        isEditting && e.stopPropagation();
        if (onClick) onClick(e);
      }}
    />
  );
};

export default CapacityInput;
