import { useState, useEffect } from "react";

/**
 * Returns a debounced version of the given value.
 * The debounced value only updates after the specified delay (ms)
 * has elapsed since the last change to the input value.
 */
export function useDebouncedValue<T>(value: T, delay: number): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timer);
  }, [value, delay]);

  return debounced;
}
