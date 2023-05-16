import { useCallback, useState, Dispatch, SetStateAction } from "react";

export const useLocalStorage = <T>(key: string, initialValue: T) => {
  const isMap = key.indexOf("map_") === 0;
  const parse = isMap ? (s: string) => new Map(JSON.parse(s)) : JSON.parse;

  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? parse(item) : initialValue;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  const setValue: Dispatch<SetStateAction<T>> = useCallback(
    (value) => {
      const stringify = isMap ? (m: any) => JSON.stringify([...m]) : JSON.stringify;
      try {
        setStoredValue((oldValue: T) => {
          const valueToStore = value instanceof Function ? value(oldValue) : value;
          window.localStorage.setItem(key, stringify(valueToStore));
          return valueToStore;
        });
      } catch (error) {
        console.error(error);
      }
    },
    [setStoredValue, key, isMap]
  );

  return [storedValue, setValue] as const;
};

export const stateMemory = new Map<string, any>();

export const useMemoryState = <T>(key: string, initialValue: T) => {
  const [state, _setState] = useState<T>(() => {
    if (stateMemory.has(key)) return stateMemory.get(key) as T;
    else return initialValue instanceof Function ? initialValue() : initialValue;
  });

  const setState: Dispatch<SetStateAction<T>> = useCallback(
    (nextState) => {
      _setState((oldState) => {
        const newState = nextState instanceof Function ? nextState(oldState) : nextState;
        stateMemory.set(key, newState);
        return newState;
      });
    },
    [key]
  );

  return [state, setState] as const;
};
