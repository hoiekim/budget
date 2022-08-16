import { useState, Dispatch, SetStateAction } from "react";

export const useLocalStorage = <T>(key: string, initialValue: T) => {
  const isMap = key.indexOf("map_") === 0;
  const parse = isMap ? (s: string) => new Map(JSON.parse(s)) : JSON.parse;
  const stringify = isMap ? (m: any) => JSON.stringify([...m]) : JSON.stringify;

  const [storedValue, setStoredValue] = useState<T>(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? parse(item) : initialValue;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  const setValue: Dispatch<SetStateAction<T>> = (value) => {
    try {
      setStoredValue((oldValue: T) => {
        const valueToStore = value instanceof Function ? value(oldValue) : value;
        window.localStorage.setItem(key, stringify(valueToStore));
        return valueToStore;
      });
    } catch (error) {
      console.error(error);
    }
  };

  return [storedValue, setValue] as const;
};
