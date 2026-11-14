import { KeyboardEvent, ReactNode, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "client/components";
import "./index.css";

interface Props {
  /** Accessible name for the dialog. */
  label: string;
  /** Header title. */
  title: ReactNode;
  /** Accessible name for the header close button. */
  closeLabel: string;
  onClose: () => void;
  /** Extra class on the backdrop, for per-modal panel styling. */
  className?: string;
  children: ReactNode;
}

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Shared modal shell: backdrop, dismissal, scroll lock, focus management,
 * and header. Callers supply only their body and actions — and a
 * `className` when their panel needs its own sizing (the backdrop carries
 * it, so `div.<ClassName> > div.panel` selectors keep working).
 *
 * Portalled to `<body>` unconditionally: some callers render inside
 * `div.Router > div.currentPage`, whose `z-index: 510` opens a stacking
 * context the overlay cannot escape, leaving it painted under the
 * `z-index: 800` header.
 */
export const Modal = ({ label, title, closeLabel, onClose, className, children }: Props) => {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes the modal.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock scroll on both `html` and `body` while open: `<html>` is this app's
  // scroll root, so `body { overflow: hidden }` alone leaves the page
  // scrolling behind the backdrop.
  useEffect(() => {
    const html = document.documentElement;
    const prevHtml = html.style.overflow;
    const prevBody = document.body.style.overflow;
    html.style.overflow = "hidden";
    document.body.style.overflow = "hidden";
    return () => {
      html.style.overflow = prevHtml;
      document.body.style.overflow = prevBody;
    };
  }, []);

  // Move focus into the panel on mount. `aria-modal="true"` declares the rest
  // of the document inert to assistive tech, and the overlay is portalled to
  // the end of `<body>`, so focus left on the opener sits behind every node
  // in the page.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Keep Tab inside the panel — with the overlay portalled last in `<body>`,
  // tabbing off the final control walks into the page the backdrop covers.
  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== "Tab") return;
    const panel = panelRef.current;
    if (!panel) return;
    const focusables = Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE));
    if (!focusables.length) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || active === panel)) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && active === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const onBackdropKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    // Only when the backdrop ITSELF is the target — a bubbled Enter from
    // a control inside the panel must not be read as a backdrop activation.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClose();
    }
  };

  return createPortal(
    <div
      className={className ? `Modal ${className}` : "Modal"}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onBackdropKeyDown}
      tabIndex={-1}
    >
      <div className="panel" ref={panelRef} tabIndex={-1} onKeyDown={onPanelKeyDown}>
        <div className="header">
          <div>{title}</div>
          <button className="closeButton" onClick={onClose} aria-label={closeLabel}>
            <CloseIcon size={14} />
          </button>
        </div>
        {children}
      </div>
    </div>,
    document.body,
  );
};
