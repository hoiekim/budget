import { KeyboardEvent, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "client/components";
import "./index.css";

interface Props {
  /** A write is open for this recurring. Both actions are inert while set. */
  busy: boolean;
  /** Display name of the recurring being confirmed. */
  merchantName: string;
  onConfirm: () => void;
  onDismiss: () => void;
  onClose: () => void;
}

const FOCUSABLE =
  'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])';

/**
 * Confirm / dismiss dialog for a suggested recurring, opened from the
 * `Recurring` chip on a transactions row — mirrors `TransferPairModal`.
 *
 * Both outcomes are named buttons here rather than affordances on the row
 * itself: dismissing writes `status='dismissed'`, which the detection
 * engine reads as a permanent per-merchant denylist, so it must not be one
 * click away from a resting transactions list.
 *
 * Presentational: `busy` and the decision to close on a landed write both
 * belong to the owner, which outlives this component's dismissal.
 */
export const RecurringModal = ({ busy, merchantName, onConfirm, onDismiss, onClose }: Props) => {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape closes the modal — matches TransferPairModal's dismissal shape.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock scroll on both `html` and `body` while open.
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

  // Move focus into the panel on mount.
  useEffect(() => {
    panelRef.current?.focus();
  }, []);

  // Keep Tab inside the panel.
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
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClose();
    }
  };

  return createPortal(
    <div
      className="RecurringModal"
      role="dialog"
      aria-modal="true"
      aria-label="Recurring suggestion"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onBackdropKeyDown}
      tabIndex={-1}
    >
      <div className="panel" ref={panelRef} tabIndex={-1} onKeyDown={onPanelKeyDown}>
        <div className="header">
          <div>Recurring</div>
          <button className="closeButton" onClick={onClose} aria-label="Close recurring suggestion">
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="message">
          “{merchantName}” is auto-detected as a recurring transaction
        </div>
        <div className="actions">
          <button className="confirmButton" aria-disabled={busy} onClick={onConfirm}>
            Confirm
          </button>
          <button className="rejectButton" aria-disabled={busy} onClick={onDismiss}>
            Dismiss
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
};
