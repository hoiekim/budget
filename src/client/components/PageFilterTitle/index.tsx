import { KeyboardEvent, ReactNode, useEffect, useRef, useState } from "react";
import { ChevronDownIcon } from "client/components";
import "./index.css";

interface Props {
  /** Text or fragment shown inside the trigger button. */
  label: ReactNode;
  /** When set, the dropdown includes a sticky-close row with this label. */
  dropdownLabel?: ReactNode;
  /** aria-label on the sticky-close row (defaults to `"Close"`). Set this
   * when `dropdownLabel` reads awkwardly as `"Close <dropdownLabel>"`. */
  closeAriaLabel?: string;
  /** Extra class on the outer `<h2>` for per-page overrides (z-index / height). */
  className?: string;
  /** The dropdown options (typically `<button>` elements). */
  children: ReactNode;
}

/**
 * Page-title heading with an embedded dropdown filter. Extracted from
 * `TransactionsPageTitle` so other list pages (e.g. `AccountsPage`) can
 * reuse the same trigger-button + dropdown chrome.
 *
 * Owns: isOpen state, buttonRef, selectBoxRef, touch-outside dismissal,
 * mouse-leave dismissal, keyboard Escape/Enter/Space dismissal on the
 * dropdown label. Consumer only supplies `label`, an optional
 * `dropdownLabel`, and the option buttons as children.
 */
export const PageFilterTitle = ({
  label,
  dropdownLabel,
  closeAriaLabel = "Close",
  className,
  children,
}: Props) => {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const selectBoxRef = useRef<HTMLDivElement>(null);

  const toggle = () => setIsOpen(!isOpen);
  const close = () => setIsOpen(false);

  useEffect(() => {
    if (!isOpen) return;
    const handleTouchOutside: EventListener = (event) => {
      const node = event.target as Node;
      const isOutsideSelectBox = !selectBoxRef.current || !selectBoxRef.current.contains(node);
      const isOutsideButton = !buttonRef.current || !buttonRef.current.contains(node);
      if (isOutsideSelectBox && isOutsideButton) close();
    };
    document.addEventListener("touchstart", handleTouchOutside);
    return () => document.removeEventListener("touchstart", handleTouchOutside);
  }, [isOpen]);

  const onLabelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " " || e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <h2 className={"PageTitle PageFilterTitle sticky" + (className ? " " + className : "")}>
      <button onClick={toggle} ref={buttonRef}>
        <span>{label}</span>
        <ChevronDownIcon size={15} />
      </button>
      {isOpen && (
        <div ref={selectBoxRef} className="select" onMouseLeave={close}>
          {dropdownLabel && (
            <div
              className="selectLabel"
              onClick={close}
              onKeyDown={onLabelKeyDown}
              role="button"
              tabIndex={0}
              aria-label={closeAriaLabel}
            >
              <span>{dropdownLabel}</span>
              <button className="closeButton" aria-hidden="true">
                ✕
              </button>
            </div>
          )}
          <div className="options">{children}</div>
        </div>
      )}
    </h2>
  );
};
