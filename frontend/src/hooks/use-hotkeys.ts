"use client";

import { useEffect, useRef } from "react";

export type HotkeyHandler = (e: KeyboardEvent) => boolean | void;

function isTypingTarget(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  if (el.isContentEditable) return true;
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) {
    return !["checkbox", "radio", "button", "submit", "range", "color"].includes(el.type);
  }
  return false;
}

/** A Radix menu, select or dialog is open: let it own the keyboard. */
function overlayOpen(): boolean {
  return Boolean(
    document.querySelector(
      '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], [role="listbox"], [role="menu"][data-state="open"]',
    ),
  );
}

/** Native activation for focused buttons/links, except checkbox-like controls. */
function isActivatable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const role = el.getAttribute("role");
  if (role === "checkbox" || role === "switch") return false;
  return el.tagName === "A" || el.tagName === "BUTTON" || role === "combobox" || role === "button";
}

/**
 * Global keyboard shortcuts for the workspace.
 * `handler` returns `false` to signal "not handled" (default is handled → preventDefault).
 * `allowInInputs` lets e.g. Ctrl+S work while typing a note.
 */
export function useHotkeys(
  handler: HotkeyHandler,
  opts: { enabled?: boolean; allowInInputs?: (e: KeyboardEvent) => boolean } = {},
) {
  const handlerRef = useRef(handler);
  const optsRef = useRef(opts);
  useEffect(() => {
    handlerRef.current = handler;
    optsRef.current = opts;
  });

  useEffect(() => {
    let suppressSpaceUp = false;

    const onKeyDown = (e: KeyboardEvent) => {
      const { enabled = true, allowInInputs } = optsRef.current;
      if (!enabled || e.isComposing || overlayOpen()) return;
      if (isTypingTarget(e.target)) {
        if (!allowInInputs?.(e)) return;
      } else if ((e.key === "Enter" || e.key === " ") && isActivatable(e.target) && !e.ctrlKey && !e.metaKey) {
        return;
      }
      const handled = handlerRef.current(e);
      if (handled !== false) {
        e.preventDefault();
        e.stopPropagation();
        // Stop a focused checkbox from toggling on keyup when Space means play/pause.
        if (e.key === " ") suppressSpaceUp = true;
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === " " && suppressSpaceUp) {
        e.preventDefault();
        suppressSpaceUp = false;
      }
    };

    // A button or link clicked with the mouse keeps keyboard focus, and Enter/Space would then
    // re-activate it instead of reaching the shortcuts. Hand focus back to the page after clicks
    // (anywhere, including the navbar) and when this view is shown again.
    const releaseFocus = (el: Element | null) => {
      if (!(el instanceof HTMLElement) || el.closest('[role="dialog"], [role="alertdialog"], [role="menu"]')) return;
      if (
        el.matches("a, button, [role=checkbox], [role=switch], [role=tab]") &&
        !el.matches("[role=combobox], [aria-haspopup]")
      ) {
        el.blur();
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      if (e.pointerType !== "mouse" || !(e.target instanceof Element)) return;
      const el = e.target.closest("a, button, [role=checkbox], [role=switch], [role=tab]");
      setTimeout(() => releaseFocus(el), 0);
    };
    releaseFocus(document.activeElement);

    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    document.addEventListener("pointerup", onPointerUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      document.removeEventListener("pointerup", onPointerUp, true);
    };
  }, []);
}
