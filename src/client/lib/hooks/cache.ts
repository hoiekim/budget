import { useState, Dispatch, SetStateAction } from "react";

export const useLocalStorage = <T>(key: string, initialValue: T) => {
  const isMap = key.indexOf("map_") === 0;
  const parse = isMap ? (s: string) => new Map(JSON.parse(s)) : JSON.parse;
  const stringify = isMap ? (m: any) => JSON.stringify([...m]) : JSON.stringify;

  const [storedValue, setStoredValue] = useState(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? parse(item) : initialValue;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  const setValue = (value: any | ((val: any) => any)) => {
    try {
      const valueToStore = value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, stringify(valueToStore));
    } catch (error) {
      console.error(error);
    }
  };

  return [storedValue as T, setValue as Dispatch<SetStateAction<T>>] as const;
};
