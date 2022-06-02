import { useState, createContext } from "react";
import { ContextType } from "lib";

export const useLocalStorage = <T>(key: string, initialValue: T) => {
  const [storedValue, setStoredValue] = useState(() => {
    try {
      const item = window.localStorage.getItem(key);
      return item ? JSON.parse(item) : initialValue;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  });

  const setValue = (value: any | ((val: any) => any)) => {
    try {
      const valueToStore =
        value instanceof Function ? value(storedValue) : value;
      setStoredValue(valueToStore);
      window.localStorage.setItem(key, JSON.stringify(valueToStore));
    } catch (error) {
      console.error(error);
    }
  };

  return [
    storedValue as T,
    setValue as React.Dispatch<React.SetStateAction<T>>,
  ] as const;
};

export const Context = createContext<ContextType>({} as ContextType);
