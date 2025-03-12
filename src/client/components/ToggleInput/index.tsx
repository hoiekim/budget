import { ChangeEventHandler, InputHTMLAttributes, useRef, useState } from "react";
import "./index.css";

type Props = InputHTMLAttributes<HTMLInputElement>;

export const ToggleInput = ({
  defaultChecked,
  checked: _checked,
  children,
  style,
  disabled,
  onChange: _onChange,
  ...rest
}: Props) => {
  const [__checked, __setChecked] = useState(defaultChecked || false);
  const inputRef = useRef<HTMLInputElement>(null);

  const checked = _checked !== undefined ? _checked : __checked;

  const onChange: ChangeEventHandler<HTMLInputElement> = (e) => {
    __setChecked(e.target.checked);
    if (_onChange) _onChange(e);
  };

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
        onChange={onChange}
        {...rest}
      />
      <div className="switch" style={style}>
        <div className="background colored" />
        {children}
      </div>
    </label>
  );
};
