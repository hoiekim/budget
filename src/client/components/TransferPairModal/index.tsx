import { KeyboardEvent, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon } from "client/components";
import "./index.css";

interface Props {
  onConfirm: () => Promise<void>;
  onReject: () => Promise<void>;
  onClose: () => void;
}

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
      <div className="panel">
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
