import { ReactNode } from "react";
import { currencyCodeToSymbol, LocalDate, numberToCommaString } from "common";

interface Props {
  /** ISO date string or any Date-parseable value. Rendered as
   *  `M/D` in en-US locale — every list row uses this shape. */
  date: string;
  /** Absolute value drives the display; `amountSign="auto"` prepends
   *  "+ " when this is negative (app convention: negative = incoming). */
  amount: number;
  /** ISO 4217 code, or `""` for unknown. */
  isoCurrency: string;
  /** `"auto"` prepends "+ " when `amount < 0`; `"none"` renders the
   *  absolute value with no sign prefix (transfer bundles). Defaults
   *  to `"auto"`. */
  amountSign?: "auto" | "none";
  /** Extra class on the `.amount` cell (e.g. `"transferAmount"`). */
  amountClassName?: string;
  /** Click handler on the whole info block — navigates to the detail
   *  page in every caller today. */
  onClickInfo?: () => void;
  /** Contents of the middle `.merchant_name` cell — each row type
   *  arranges its own bigText/smallText stack (merchant + account,
   *  name + account + institution, "Transfer" + from→to, …). */
  children: ReactNode;
}

/**
 * Shared header block for every list-view transaction row:
 * date · name/subline stack · amount. Wraps the three-column
 * `.transactionInfo` scaffold that `TransactionRow`,
 * `InvestmentTransactionRow`, and `TransferRow` all rendered inline.
 * The row-specific chrome (label controls, transfer controls, empty)
 * sits outside this primitive as a sibling of `.transactionInfo`
 * inside `.TransactionRow`.
 */
export const TransactionRowInfo = ({
  date,
  amount,
  isoCurrency,
  amountSign = "auto",
  amountClassName,
  onClickInfo,
  children,
}: Props) => {
  const amountClasses = ["amount", amountClassName].filter(Boolean).join(" ");
  return (
    <div className="transactionInfo" onClick={onClickInfo}>
      <div className="authorized_date bigText">
        {new LocalDate(date).toLocaleString("en-US", {
          month: "numeric",
          day: "numeric",
        })}
      </div>
      <div className="merchant_name">{children}</div>
      <div className={amountClasses}>
        {amountSign === "auto" && amount < 0 && <>+&nbsp;</>}
        {currencyCodeToSymbol(isoCurrency)}&nbsp;
        {numberToCommaString(Math.abs(amount))}
      </div>
    </div>
  );
};
