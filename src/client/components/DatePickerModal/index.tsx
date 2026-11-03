import { getYearMonthString, Interval, parseYearMonthString, ViewDate } from "common";
import { useAppContext } from "client";
import { ChevronLeftIcon, ChevronRightIcon, Modal } from "client/components";
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

  return (
    <Modal
      label="View date"
      title={<>Select&nbsp;View&nbsp;Date</>}
      closeLabel="Close view date"
      onClose={onClose}
      className="DatePickerModal"
    >
      <div className="dateInput">
        {/* Native month picker for both intervals. In year mode
         * the specific month within the year is irrelevant to the
         * calculation surface (`getEndDate` still returns the year's
         * end via `ViewDate.setInterval`), but keeping the same
         * picker widget avoids UI shape change on interval flip. */}
        <input
          id="view-date-picker"
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
    </Modal>
  );
};
