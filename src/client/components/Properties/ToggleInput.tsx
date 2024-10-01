import { InputHTMLAttributes, useRef } from "react";

type Props = InputHTMLAttributes<HTMLInputElement>;

const ToggleInput = ({ defaultChecked, checked, children, style, disabled, ...rest }: Props) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const classes = ["ToggleInput"];
  if (checked) classes.push("checked");
  if (disabled) classes.push("disabled");
  return (
    <label className={classes.join(" ")}>
      <input
        ref={inputRef}
        type="checkbox"
        checked={checked}
        hidden
        disabled={disabled}
        {...rest}
      />
      <div className="switch" style={style}>
        <div className="background colored" />
        {children}
      </div>
    </label>
  );
};

export default ToggleInput;
