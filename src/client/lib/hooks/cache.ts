import { useCallback, useState, Dispatch, SetStateAction, useRef } from "react";
import { Dictionary } from "client";

const parseMap = (s: string) => new Map(JSON.parse(s));
const parseDictionary = (s: string) => new Dictionary(JSON.parse(s));
const stringifyMap = (m: any) => JSON.stringify([...m]);

export const useLocalStorageState = <T>(key: string, initialValue: T) => {
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
    [setStoredValue, key, isMap, isDictionary],
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
    [key],
  );

  return [state, setState] as const;
};

export const useDebounce = () => {
  const timeout = useRef<NodeJS.Timeout | null>(null);
  const debounce = (callback: () => void, delay = 50) => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(callback, delay);
  };
  return useCallback(debounce, [timeout]);
};

export const useThrottle = () => {
  const timeout = useRef<NodeJS.Timeout | null>(null);
  const timestamp = useRef<number | null>(null);
  const callbackStack = useRef<(() => void) | null>(null);
  const throttle = (callback: () => void, threshold = 5000) => {
    callbackStack.current = callback;
    const now = Date.now();
    const latest = timestamp.current;
    const delay = threshold - (now - (latest || 0));
    if (latest && delay > 0) {
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(callbackStack.current, delay);
      return;
    }
    timestamp.current = now;
    callbackStack.current();
  };
  return useCallback(throttle, [timestamp]);
};
