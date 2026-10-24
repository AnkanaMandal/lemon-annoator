import { useCallback, useSyncExternalStore } from "react";

/**
 * Playback time lives outside React state so the 60 Hz updates only re-render
 * the few components that subscribe to them, not the whole workspace.
 */
export interface TimeStore {
  get(): number;
  set(t: number): void;
  subscribe(fn: () => void): () => void;
}

export function createTimeStore(): TimeStore {
  let time = 0;
  const listeners = new Set<() => void>();
  return {
    get: () => time,
    set(t) {
      if (t === time) return;
      time = t;
      listeners.forEach((l) => l());
    },
    subscribe(fn) {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
  };
}

export function useCurrentTime(store: TimeStore): number {
  return useSyncExternalStore(store.subscribe, store.get, () => 0);
}

/** Re-renders only when the selected (primitive) value changes. */
export function useTimeSelector<T extends string | number | boolean | null>(
  store: TimeStore,
  selector: (t: number) => T,
): T {
  const get = useCallback(() => selector(store.get()), [store, selector]);
  return useSyncExternalStore(store.subscribe, get, get);
}
