import { InputHTMLAttributes, useRef } from "react";

type Props = InputHTMLAttributes<HTMLInputElement>;

const ToggleInput = ({ defaultChecked, children, style, ...rest }: Props) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const isChecked = inputRef.current === null ? defaultChecked : inputRef.current.checked;
  const classes = ["ToggleInput"];
  if (isChecked) classes.push("checked");
  return (
    <label className={classes.join(" ")}>
      <input
        ref={inputRef}
        type="checkbox"
        defaultChecked={defaultChecked}
        hidden
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
