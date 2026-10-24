"use client";

import { useSyncExternalStore } from "react";

const subscribe = () => () => {};

/**
 * False on the server and during hydration, true afterwards (and immediately on client-side
 * navigations). Query data can already be cached when a streamed section hydrates (another part of
 * the page fetched it first); rendering it before hydration finishes would not match the server
 * HTML, so data-driven UI waits for this.
 */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}
