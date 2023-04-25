import { InputHTMLAttributes, useRef } from "react";

interface Option {
  id: string;
  label: string;
}

type Props = InputHTMLAttributes<HTMLInputElement> & {
  name: string;
  options: Option[];
  defaultCheckedOptionId: string;
  checkedOptionId: string;
};

const RadioInputs = ({
  name,
  options,
  defaultCheckedOptionId,
  checkedOptionId,
  children,
  style,
  ...rest
}: Props) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const inputs = options.map(({ id, label }) => {
    const defaultChecked = defaultCheckedOptionId === id;
    const checked = checkedOptionId === id;
    return (
      <div className="option row" key={id}>
        <label htmlFor={id}>{label}</label>
        <input
          ref={inputRef}
          type="radio"
          name={name}
          id={id}
          defaultChecked={defaultChecked}
          hidden
          {...rest}
        />
        {checked && <div className="checkMark colored">✓</div>}
      </div>
    );
  });
  return <div className="RadioInputs">{inputs}</div>;
};

export default RadioInputs;
