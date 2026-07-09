import { KeyboardEvent, useEffect } from "react";
import { getYearMonthString, Interval, parseYearMonthString, ViewDate } from "common";
import { useAppContext } from "client";
import { ChevronLeftIcon, ChevronRightIcon, CloseIcon } from "client/components";
import "./index.css";

interface Props {
  onClose: () => void;
}

/**
 * Modal wrapping the view-date controls: current-period label, prev /
 * current / next stepper, and month/year interval selector. Opened by
 * the button rendered in `Header`.
 *
 * Structure:
 *
 *     View Date
 *     [Jul 2026]
 *     [<] [Current] [>]
 *     Interval: [month] v
 *
 * The Current button calls `resetViewDate()` to REMOVE the URL param
 * rather than writing today's period. See the `resetViewDate` doc in
 * `context.ts` for the "bookmark clean" rationale.
 */
export const DatePickerModal = ({ onClose }: Props) => {
  const { viewDate, setViewDate, resetViewDate } = useAppContext();
  const interval = viewDate.getInterval();
  const monthInputValue = getYearMonthString(viewDate.getEndDate());

  const onPrev = () => setViewDate((v) => v.clone().previous());
  const onNext = () => setViewDate((v) => v.clone().next());
  const onCurrent = () => resetViewDate();
  const onChangeInterval = (next: Interval) => {
    setViewDate((v) => {
      const clone = new ViewDate(v.getInterval(), v.getEndDate());
      clone.setInterval(next);
      return clone;
    });
  };
  const onChangeMonthInput = (value: string) => {
    const date = parseYearMonthString(value);
    if (!date) return;
    setViewDate((v) => new ViewDate(v.getInterval(), date));
  };

  // Escape closes the modal — matches PageFilterTitle's dismissal shape.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Lock scroll while the modal is open — otherwise the underlying
  // page (Dashboard chart rows, Budgets list, etc.) still scrolls
  // behind the backdrop, which reads as broken modal semantics. Have
  // to lock BOTH `html` and `body`: in this app's CSS shape, `<html>`
  // is the scroll root, so `body { overflow: hidden }` alone doesn't
  // stop user wheel/touch scrolling. Restore both previous values on
  // unmount so the app-level styles aren't permanently overridden.
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
    // Only handle Enter/Space when the backdrop ITSELF is the target
    // (activation of the outer div's keyboard "button" affordance).
    // Reviewoie #624 caught the earlier version treating bubbled events
    // as backdrop activations — Enter on Prev/Current/Next inside the
    // panel called preventDefault + onClose, breaking keyboard operation
    // of every control in the modal.
    if (e.target !== e.currentTarget) return;
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      onClose();
    }
  };

  return (
    <div
      className="DatePickerModal"
      role="dialog"
      aria-modal="true"
      aria-label="View date"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      onKeyDown={onBackdropKeyDown}
      tabIndex={-1}
    >
      <div className="panel">
        <div className="header">
          <h3>View&nbsp;Date</h3>
          <button className="closeButton" onClick={onClose} aria-label="Close view date">
            <CloseIcon size={14} />
          </button>
        </div>
        <div className="dateInput">
          {/* Native month picker for both intervals. In year mode
           * the specific month within the year is irrelevant to the
           * calculation surface (`getEndDate` still returns the year's
           * end via `ViewDate.setInterval`), but keeping the same
           * picker widget avoids UI shape change on interval flip. */}
          <input
            type="month"
            aria-label={interval === "year" ? "Year (month ignored)" : "Month"}
            value={monthInputValue}
            onChange={(e) => onChangeMonthInput(e.target.value)}
          />
        </div>
        <div className="stepper">
          <button onClick={onPrev} aria-label="Previous period">
            <ChevronLeftIcon size={14} />
          </button>
          <button className="currentButton" onClick={onCurrent}>
            Current
          </button>
          <button onClick={onNext} aria-label="Next period">
            <ChevronRightIcon size={14} />
          </button>
        </div>
        <div className="intervalRow">
          <label htmlFor="interval-select">Interval</label>
          <select
            id="interval-select"
            value={interval}
            onChange={(e) => onChangeInterval(e.target.value as Interval)}
          >
            <option value="month">Month</option>
            <option value="year">Year</option>
          </select>
        </div>
      </div>
    </div>
  );
};
