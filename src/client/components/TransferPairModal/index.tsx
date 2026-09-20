import { KeyboardEvent, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "client/components";
import "./index.css";

interface Props {
  onConfirm: () => Promise<void>;
  onReject: () => Promise<void>;
  onClose: () => void;
}

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Confirm / reject dialog for a suggested transfer pair, opened from the
 * `Transfer` chip on a transactions row.
 *
 * Both outcomes are named buttons here rather than affordances on the row
 * itself: rejecting writes `status='rejected'`, which the detection engine
 * reads as a permanent per-pair denylist, so it must not be one click away
 * from a resting transactions list.
 *
 *     This transaction pair is auto-detected as a transfer
 *     [Confirm]  [Reject]
 */
export const TransferPairModal = ({ onConfirm, onReject, onClose }: Props) => {
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);

  const run = (action: () => Promise<void>) => async () => {
    if (busy) return;
    setBusy(true);
    try {
      await action();
      onClose();
    } finally {
      setBusy(false);
    }
  };

  // Escape closes the modal — matches DatePickerModal's dismissal shape.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock scroll on both `html` and `body` while open: `<html>` is this app's
  // scroll root, so `body { overflow: hidden }` alone leaves the transactions
  // list scrolling behind the backdrop.
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
  // the end of `<body>`, so focus left on the opening chip sits behind every
  // node in the page.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Keep Tab inside the panel — with the overlay portalled last in `<body>`,
  // tabbing off the final button walks into the page the backdrop covers.
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
    // Confirm / Reject must not be read as a backdrop activation.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClose();
    }
  };

  // Portalled to `<body>`: the transactions list renders inside
  // `div.Router > div.currentPage`, whose `z-index: 510` opens a stacking
  // context the overlay cannot escape, leaving it painted under the
  // `z-index: 800` header.
  return createPortal(
    <div
      className="TransferPairModal"
      role="dialog"
      aria-modal="true"
      aria-label="Transfer suggestion"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onBackdropKeyDown}
      tabIndex={-1}
    >
      <div className="panel" ref={panelRef} tabIndex={-1} onKeyDown={onPanelKeyDown}>
        <div className="header">
          <div>Transfer</div>
          <button className="closeButton" onClick={onClose} aria-label="Close transfer suggestion">
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="message">This transaction pair is auto-detected as a transfer</div>
        <div className="actions">
          <button className="confirmButton" disabled={busy} onClick={run(onConfirm)}>
            Confirm
          </button>
          <button className="rejectButton" disabled={busy} onClick={run(onReject)}>
            Reject
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
