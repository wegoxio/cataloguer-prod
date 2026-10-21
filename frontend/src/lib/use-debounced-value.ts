'use client';

import { useEffect, useState } from 'react';

/**
 * Returns the value only after it stopped changing for `delay` ms —
 * search inputs use it so typing doesn't fire one request per keystroke.
 */
export function useDebouncedValue<T>(value: T, delay = 350): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}
