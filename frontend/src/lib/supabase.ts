import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { useSyncExternalStore } from "react";

/**
 * Supabase is used for sign-in only. All data goes through the Lemon API, which verifies the
 * access token sent with every request.
 */
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
// The older "anon" key works the same way (and is the name Vercel's Supabase integration sets).
const SUPABASE_KEY = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabaseConfigured = Boolean(SUPABASE_URL && SUPABASE_KEY);

let client: SupabaseClient | null = null;

/** Created on first use in the browser (never during server rendering). */
export function supabase(): SupabaseClient {
  if (!client) {
    if (!SUPABASE_URL || !SUPABASE_KEY) throw new Error("Supabase is not configured.");
    client = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return client;
}

/** The signed-in user's access token, refreshed by Supabase when needed. */
export async function accessToken(): Promise<string | null> {
  if (!supabaseConfigured) return null;
  const { data } = await supabase().auth.getSession();
  return data.session?.access_token ?? null;
}

/* ------------------------------------------------------------------ auth state ---------------------- */

export type AuthState =
  | { status: "loading" | "signed-out" | "unconfigured" }
  | { status: "signed-in"; userId: string; email: string; name: string };

const LOADING: AuthState = { status: "loading" };
let state: AuthState = LOADING;
let started = false;
const listeners = new Set<() => void>();

function set(next: AuthState) {
  // Keep the same object while the user is unchanged (token refreshes), so nothing re-renders.
  if (next.status === "signed-in" && state.status === "signed-in" && state.userId === next.userId) return;
  if (next.status !== "signed-in" && state.status === next.status) return;
  state = next;
  listeners.forEach((l) => l());
}

function start() {
  if (started) return;
  started = true;
  if (!supabaseConfigured) {
    state = { status: "unconfigured" };
    return;
  }
  // Fires INITIAL_SESSION right away, then on every sign-in / sign-out.
  supabase().auth.onAuthStateChange((_event, session) => {
    const user = session?.user;
    if (!user) return set({ status: "signed-out" });
    const meta = user.user_metadata ?? {};
    const email = user.email ?? "";
    set({
      status: "signed-in",
      userId: user.id,
      email,
      name: String(meta.full_name ?? meta.name ?? email.split("@")[0] ?? "You"),
    });
  });
}

const authStore = {
  subscribe(fn: () => void) {
    start();
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
  get: () => state,
};

export function useAuth(): AuthState {
  return useSyncExternalStore(authStore.subscribe, authStore.get, () => LOADING);
}

export async function signOut() {
  if (supabaseConfigured) await supabase().auth.signOut();
}
