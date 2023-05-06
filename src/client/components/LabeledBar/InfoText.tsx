import { useAppContext } from "client";
import { currencyCodeToSymbol, numberToCommaString } from "common";
import { Dispatch, SetStateAction } from "react";
import CapacityInput from "./CapacityInput";

interface Props {
  dataId: string;
  isEditingThis: boolean;
  isIncome: boolean;
  isInfinite: boolean;
  isInfiniteInput: boolean;
  capacityInput: number;
  setCapacityInput: Dispatch<SetStateAction<number>>;
  iso_currency_code: string;
  total: number;
  leftover: number;
  roll_over: boolean;
  rolled_over_amount?: number;
}

const InfoText = ({
  dataId,
  isEditingThis,
  isIncome,
  isInfinite,
  isInfiniteInput,
  capacityInput,
  setCapacityInput,
  iso_currency_code,
  total,
  leftover,
  roll_over,
  rolled_over_amount,
}: Props) => {
  const { viewDate } = useAppContext();
  const interval = viewDate.getInterval();

  const CurrencySymbolSpan = <span>{currencyCodeToSymbol(iso_currency_code)}</span>;
  return (
    <div className="InfoText">
      {isEditingThis ? (
        <div className="fullLength editing">
          <table>
            <tbody>
              <tr>
                {isInfiniteInput ? (
                  <td>
                    <span>Unlimited</span>
                  </td>
                ) : (
                  <>
                    <td>{CurrencySymbolSpan}</td>
                    <td>
                      <CapacityInput
                        key={`${dataId}_${interval}`}
                        defaultValue={capacityInput}
                        isEditing={isEditingThis}
                        onChange={(e) => setCapacityInput(Math.abs(+e.target.value))}
                      />
                    </td>
                  </>
                )}
              </tr>
            </tbody>
          </table>
        </div>
      ) : (
        <>
          <div className={isInfinite ? "fullLength" : undefined}>
            <table>
              <tbody>
                <tr>
                  <td>{CurrencySymbolSpan}</td>
                  <td>
                    <span className="currentTotal">
                      {numberToCommaString(Math.abs(total))}
                    </span>
                  </td>
                  <td>
                    <span>{total >= 0 ? "spent" : "gained"}</span>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          {!isInfinite && (
            <div>
              <table>
                <tbody>
                  <tr>
                    <td>{CurrencySymbolSpan}</td>
                    <td>
                      <span className="currentTotal">
                        {numberToCommaString(Math.abs(leftover))}
                      </span>
                    </td>
                    <td style={{ textAlign: "left" }}>
                      <span>
                        {(isIncome ? leftover < 0 : 0 <= leftover) ? "left" : "over"}
                      </span>
                    </td>
                  </tr>
                  {roll_over && rolled_over_amount !== undefined && (
                    <tr>
                      <td>
                        <span>{rolled_over_amount <= 0 ? "+" : "-"}</span>
                        {CurrencySymbolSpan}
                      </td>
                      <td>
                        <span className="currentTotal">
                          {numberToCommaString(Math.abs(rolled_over_amount))}
                        </span>
                      </td>
                      <td>
                        <span>rolled</span>
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
};

export default InfoText;
