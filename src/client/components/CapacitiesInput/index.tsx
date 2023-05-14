import { Dispatch, SetStateAction, ChangeEventHandler, useRef, useEffect } from "react";
import { useAppContext } from "client/lib";
import {
  Capacity,
  ViewDate,
  currencyCodeToSymbol,
  getDateString,
  getDateTimeString,
  sortCapacities,
} from "common";
import CapacityInput from "./CapacityInput";

import "./index.css";

interface Props {
  isInfiniteInput: boolean;
  currencyCode: string;
  defaultCapacities: Capacity[];
  capacitiesInput: Capacity[];
  setCapacitiesInput: Dispatch<SetStateAction<Capacity[]>>;
}

const CapacitiesInput = ({
  isInfiniteInput,
  currencyCode,
  defaultCapacities: _defaultCap,
  capacitiesInput,
  setCapacitiesInput,
}: Props) => {
  const { viewDate } = useAppContext();
  const interval = viewDate.getInterval();
  const defaultCapacities = useRef(_defaultCap.map((c) => c.toInputs().capacityInput));

  useEffect(() => {
    defaultCapacities.current = _defaultCap.map((c) => c.toInputs().capacityInput);
  }, [_defaultCap]);

  const rows = capacitiesInput.sort(sortCapacities.asc).map((capacity, i) => {
    defaultCapacities.current.sort(sortCapacities.asc);
    const defaultValue = defaultCapacities.current[i][interval];

    const { active_from } = capacity;

    const onChangeDate: ChangeEventHandler<HTMLInputElement> = (e) => {
      const newCapacity = new Capacity(capacity);
      const inputDate = new Date(getDateTimeString(e.target.value));
      const dateHelper = new ViewDate(viewDate.getInterval(), inputDate);
      const newActiveFrom = dateHelper.getDateAsStartDate();
      newCapacity.active_from = newActiveFrom;
      setCapacitiesInput((capacities) => {
        const newCapacities = capacities.map((e) => new Capacity(e));
        newCapacities.splice(i, 1, newCapacity);
        defaultCapacities.current = newCapacities;
        return newCapacities;
      });
    };

    const onChangeAmount: ChangeEventHandler<HTMLInputElement> = (e) => {
      const newCapacity = new Capacity(capacity);
      const value = Math.abs(+e.target.value);
      newCapacity[interval] = value;
      setCapacitiesInput((capacities) => {
        const newCapacities = capacities.map((e) => new Capacity(e));
        newCapacities.splice(i, 1, newCapacity);
        defaultCapacities.current = newCapacities;
        return newCapacities;
      });
    };

    const onDelete = () => {
      if (!active_from) return;
      setCapacitiesInput((oldCapacities) => {
        const newCapacities = oldCapacities.map((c) => new Capacity(c));
        newCapacities.splice(i, 1);
        defaultCapacities.current = newCapacities;
        return newCapacities;
      });
    };

    const key = `capacity_${active_from?.getTime()}_${capacity[interval]}`;

    return (
      <tr className="capacityRow" key={key}>
        <td>
          <span>Since</span>
        </td>
        <td>
          <span>
            {active_from ? (
              <input
                type="date"
                value={getDateString(active_from)}
                onChange={onChangeDate}
              />
            ) : (
              <input disabled value={"ever"} />
            )}
          </span>
        </td>
        <td>
          <span>{currencyCodeToSymbol(currencyCode)}</span>
        </td>
        <td>
          <CapacityInput defaultValue={defaultValue} onBlur={onChangeAmount} />
        </td>
        <td>
          <button onClick={onDelete}>-</button>
        </td>
      </tr>
    );
  });

  const onClickAdd = () => {
    setCapacitiesInput((oldCapacities) => {
      const newCapacities = oldCapacities.map((e) => new Capacity(e));
      newCapacities.sort(sortCapacities.asc);

      const latestCapacity = newCapacities[newCapacities.length - 1];
      const dateHelper = new ViewDate(viewDate.getInterval(), latestCapacity.active_from);
      dateHelper.next();
      const active_from = dateHelper.getDateAsStartDate();
      const newCapacity = new Capacity({ ...latestCapacity, active_from });
      newCapacities.push(newCapacity);
      defaultCapacities.current = newCapacities;

      return newCapacities;
    });
  };

  return (
    <div className="CapacitiesInput">
      <div>
        <table>
          <tbody>
            {isInfiniteInput ? (
              <tr>
                <td>
                  <span>Unlimited</span>
                </td>
              </tr>
            ) : (
              rows
            )}
          </tbody>
        </table>
      </div>
      <div>
        <button onClick={onClickAdd}>+</button>
      </div>
    </div>
  );
};

export default CapacitiesInput;
