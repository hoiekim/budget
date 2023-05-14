import { InputHTMLAttributes, useRef } from "react";

type Props = InputHTMLAttributes<HTMLInputElement>;

const ToggleInput = ({ defaultChecked, checked, children, style, ...rest }: Props) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const classes = ["ToggleInput"];
  if (checked) classes.push("checked");
  return (
    <label className={classes.join(" ")}>
      <input ref={inputRef} type="checkbox" checked={checked} hidden {...rest} />
      <div className="switch" style={style}>
        <div className="background colored" />
        {children}
      </div>
    </label>
  );
};

export default ToggleInput;
