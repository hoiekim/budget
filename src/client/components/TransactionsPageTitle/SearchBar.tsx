import { useDebounce } from "client";
import { ChangeEventHandler, CSSProperties, useRef, useState } from "react";

interface SearchBarProps {
  onChange: (value: string) => void;
  style?: CSSProperties;
}

export const SearchBar = ({ onChange, style }: SearchBarProps) => {
  const debouncer = useDebounce();
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const onChangeInput: ChangeEventHandler<HTMLInputElement> = (e) => {
    setValue(e.target.value);
    debouncer(() => onChange(e.target.value), 300);
  };

  const onClickButton = () => {
    if (value) {
      setValue("");
      onChange("");
    } else {
      inputRef.current?.focus();
    }
  };

  const classes = ["SearchBar"];
  if (value) classes.push("active");
  return (
    <div className={classes.join(" ")} style={style}>
      <input
        ref={inputRef}
        type="text"
        value={value}
        placeholder="Search"
        onChange={onChangeInput}
      />
      <button onClick={onClickButton}>
        <span className={"rotate270deg"}>{value ? "✕" : "⌕"}</span>
      </button>
    </div>
  );
};
