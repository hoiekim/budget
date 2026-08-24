import { useCallback, useEffect, useState, Dispatch, SetStateAction, useRef } from "react";
import { Dictionary } from "client";

const parseMap = (s: string) => new Map(JSON.parse(s));
const parseDictionary = (s: string) => new Dictionary(JSON.parse(s));
const stringifyMap = (m: Map<unknown, unknown>) => JSON.stringify([...m]);

/**
 * What a key-keyed state must hold after a render, given the key it was
 * last synced to. `null` when the key is unchanged, so the caller leaves
 * its state alone; otherwise the new key and the value read for it.
 *
 * The state IS whatever is stored under `key`, so a caller that swaps
 * keys while mounted must see the new key's value — otherwise the
 * previous key's value stays on screen and the next write carries it
 * into the new slot.
 *
 * Split out of the hook so the decision is exercisable without a
 * rendered-hook harness.
 */
export const nextStoredValue = <T>(
  previousKey: string,
  key: string,
  read: (k: string) => T,
): { key: string; value: T } | null => {
  if (previousKey === key) return null;
  return { key, value: read(key) };
};

export const useLocalStorageState = <T>(key: string, initialValue: T) => {
  const isMap = key.indexOf("map_") === 0;
  const isDictionary = key.indexOf("dictionary_") === 0;
  const parse = isMap ? parseMap : isDictionary ? parseDictionary : JSON.parse;

  const read = (k: string): T => {
    try {
      const item = window.localStorage.getItem(k);
      return item ? parse(item) : initialValue;
    } catch (error) {
      console.error(error);
      return initialValue;
    }
  };

  const [storedValue, setStoredValue] = useState<T>(() => read(key));

  // Assigned during render (React's documented way to reset state on a
  // changed input) rather than in an effect, so the new key's value is
  // never painted a frame late.
  //
  // The previous key is held in state, not a ref, precisely because the
  // app renders under StrictMode on a concurrent root: a ref mutation
  // survives a render React abandons, while the queued state update does
  // not — a ref guard could therefore be marked "already handled" for a
  // render that never committed and never resync at all.
  const [previousKey, setPreviousKey] = useState(key);
  const resync = nextStoredValue(previousKey, key, read);
  if (resync) {
    setPreviousKey(resync.key);
    setStoredValue(resync.value);
  }

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

export const stateMemory = new Map<string, unknown>();

/**
 * Sibling of `useLocalStorageState`, deliberately WITHOUT its
 * key-change resync: no caller today reaches a render where `key`
 * differs from the previous one, because the ids their template-literal
 * keys interpolate (`section_${section_id}_isOpen`,
 * `graph_svgWidth_${memoryKey}`, the `Bar` family) are fixed for the
 * lifetime of the instance that reads them — same-path navigation
 * replaces the list rather than re-pointing a mounted row at another id.
 *
 * That is a property of the current callers, NOT one React enforces:
 * several of them (`Graph`'s line / area / point elements, the `Bar`
 * family) sit under a positional React `key` with the id only in
 * `memoryKey`, so nothing would remount them if an id ever did change
 * under a mounted instance. A caller that varies its key on a mounted
 * component needs `nextStoredValue` wired in here, the way
 * `useLocalStorageState` wires it above.
 */
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

  useEffect(() => {
    return () => {
      if (timeout.current) clearTimeout(timeout.current);
    };
  }, []);

  const debounce = useCallback((callback: () => void, delay = 50) => {
    if (timeout.current) clearTimeout(timeout.current);
    timeout.current = setTimeout(callback, delay);
  }, []);

  return debounce;
};

export const useThrottle = () => {
  const timeout = useRef<NodeJS.Timeout | null>(null);
  const timestamp = useRef<number | null>(null);
  const callbackStack = useRef<(() => void) | null>(null);

  useEffect(() => {
    return () => {
      if (timeout.current) clearTimeout(timeout.current);
      callbackStack.current = null;
    };
  }, []);

  const throttle = useCallback((callback: () => void, threshold = 5000) => {
    callbackStack.current = callback;
    const now = Date.now();
    const latest = timestamp.current;
    const delay = threshold - (now - (latest || 0));
    if (latest && delay > 0) {
      if (timeout.current) clearTimeout(timeout.current);
      timeout.current = setTimeout(() => {
        if (callbackStack.current) callbackStack.current();
      }, delay);
      return;
    }
    timestamp.current = now;
    callbackStack.current();
  }, []);

  return throttle;
};
