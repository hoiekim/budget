import { useEffect, useState } from "react";

const Cover = () => {
  const [colorScheme, setColorScheme] = useState("dark");
  useEffect(() => {
    const listener = (event: MediaQueryListEvent) => {
      setColorScheme(event.matches ? "dark" : "light");
    };
    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", listener);
    return () => {
      window
        .matchMedia("(prefers-color-scheme: dark)")
        .removeEventListener("change", listener);
    };
  }, []);
  const classes = ["Cover", colorScheme];
  return <div className={classes.join(" ")} />;
};

export default Cover;
