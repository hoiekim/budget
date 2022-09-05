import { useEffect, useState } from "react";

const mediaQueryColorScheme = "(prefers-color-scheme: dark)";
const mediaQueryList = window.matchMedia(mediaQueryColorScheme);
const { matches, addEventListener, removeEventListener } = mediaQueryList;

const Cover = () => {
  const [colorScheme, setColorScheme] = useState(matches ? "dark" : "light");
  useEffect(() => {
    const listener = (event: MediaQueryListEvent) => {
      setColorScheme(event.matches ? "dark" : "light");
    };
    addEventListener("change", listener);
    return () => {
      removeEventListener("change", listener);
    };
  }, []);
  const subtractCoverClasses = ["subtract", colorScheme];
  const offsetCoverClasses = ["offset", colorScheme];
  return (
    <div className="Cover">
      <div className={subtractCoverClasses.join(" ")} />
      <div className={offsetCoverClasses.join(" ")} />
    </div>
  );
};

export default Cover;
