import { useMemoryState } from "client";
import { Data, data as _data } from "common";
import { Dispatch, SetStateAction, useCallback, useRef } from "react";

export const useData = () => {
  const [data, _setData] = useMemoryState<Data>("data", _data);
  const setData: Dispatch<SetStateAction<Data>> = useCallback(
    (nextData) => {
      _setData((oldData) => {
        const newData = nextData instanceof Function ? nextData(oldData) : nextData;
        _data.update(newData);
        return newData;
      });
    },
    [_setData]
  );
  return [data, setData] as const;
};

export const useDebounce = () => {
  const timeout = useRef<NodeJS.Timeout | null>(null);
  const debounce = (callback: () => void, delay = 100) => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(callback, delay);
  };
  return useCallback(debounce, [timeout]);
};
