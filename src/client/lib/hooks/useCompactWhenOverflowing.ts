import { RefObject, useEffect, useLayoutEffect, useState } from "react";

const contentWidth = (element: HTMLElement): number => {
  const style = getComputedStyle(element);
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return element.clientWidth - padding;
};

/**
 * True once `ref`'s element is wider than its parent's content box, so the
 * caller can switch to a narrower rendering. A window resize resets it, so the
 * full rendering is measured again at the new width.
 */
export const useCompactWhenOverflowing = (ref: RefObject<HTMLElement>): boolean => {
  const [compact, setCompact] = useState(false);

  useLayoutEffect(() => {
    if (compact) return;
    const element = ref.current;
    const parent = element?.parentElement;
    if (element && parent && element.scrollWidth > contentWidth(parent)) setCompact(true);
  });

  useEffect(() => {
    const reset = () => setCompact(false);
    window.addEventListener("resize", reset);
    return () => window.removeEventListener("resize", reset);
  }, []);

  return compact;
};
