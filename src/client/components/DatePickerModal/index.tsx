import { KeyboardEvent, useEffect } from "react";
import { Interval, ViewDate } from "common";
import { useAppContext } from "client";
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
  const dateLabel = viewDate.toString(
    interval === "year" ? undefined : { year: "numeric", month: "long" },
  );

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

  // Escape closes the modal — matches PageFilterTitle's dismissal shape.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const onBackdropKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
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
      onClick={onClose}
      onKeyDown={onBackdropKeyDown}
      tabIndex={-1}
    >
      <div className="panel" onClick={(e) => e.stopPropagation()}>
        <div className="header">
          <h3>View&nbsp;Date</h3>
          <button className="closeButton" onClick={onClose} aria-label="Close view date">
            ✕
          </button>
        </div>
        <div className="dateLabel">{dateLabel}</div>
        <div className="stepper">
          <button onClick={onPrev} aria-label="Previous period">
            ◀
          </button>
          <button className="currentButton" onClick={onCurrent}>
            Current
          </button>
          <button onClick={onNext} aria-label="Next period">
            ▶
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
