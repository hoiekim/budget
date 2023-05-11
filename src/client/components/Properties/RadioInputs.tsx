import { InputHTMLAttributes } from "react";

interface Option {
  id: string;
  label: string;
}

type Props = InputHTMLAttributes<HTMLInputElement> & {
  name: string;
  options: Option[];
  checkedOptionId: string;
};

const RadioInputs = ({
  name,
  options,
  checkedOptionId,
  children,
  style,
  ...rest
}: Props) => {
  const inputs = options.map(({ id, label }) => {
    const checked = checkedOptionId === id;
    return (
      <div className="option row" key={id}>
        <label htmlFor={id}>{label}</label>
        <input type="radio" name={name} id={id} hidden checked={checked} {...rest} />
        {checked && <div className="checkMark colored">✓</div>}
      </div>
    );
  });
  return <div className="RadioInputs">{inputs}</div>;
};

export default RadioInputs;
