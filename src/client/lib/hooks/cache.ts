import { Dictionary } from "common";
import { useCallback, useState, Dispatch, SetStateAction } from "react";

const parseMap = (s: string) => new Map(JSON.parse(s));
const parseDictionary = (s: string) => new Dictionary(JSON.parse(s));
const stringifyMap = (m: any) => JSON.stringify([...m]);

export const useLocalStorage = <T>(key: string, initialValue: T) => {
  const isMap = key.indexOf("map_") === 0;
  const isDictionary = key.indexOf("dictionary_") === 0;
  const parse = isMap ? parseMap : isDictionary ? parseDictionary : JSON.parse;

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
      const stringify = isMap || isDictionary ? stringifyMap : JSON.stringify;
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
    [setStoredValue, key, isMap, isDictionary]
  );

  return [storedValue, setValue] as const;
};

export const stateMemory = new Map<string, any>();

export const useMemoryState = <T>(key: string | undefined, initialValue: T) => {
  const [state, _setState] = useState<T>(() => {
    if (key && stateMemory.has(key)) return stateMemory.get(key) as T;
    else return initialValue instanceof Function ? initialValue() : initialValue;
  });

  const setState: Dispatch<SetStateAction<T>> = useCallback(
    (nextState) => {
      _setState((oldState) => {
        const newState = nextState instanceof Function ? nextState(oldState) : nextState;
        if (key) stateMemory.set(key, newState);
        return newState;
      });
    },
    [key]
  );

  return [state, setState] as const;
};
