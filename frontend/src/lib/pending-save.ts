/**
 * Unsaved annotation work, tracked outside React effects.
 *
 * Next.js keeps a hidden route mounted (React <Activity>) but runs its effect cleanups, so
 * effect-based guards switch off as soon as the user opens another tab of the app. This module
 * keeps the workspace's "save my edits" function and the tab-close warning alive regardless.
 */
type Saver = () => Promise<unknown>;

let current: { projectId: string; save: Saver } | null = null;
let listening = false;

function onBeforeUnload(e: BeforeUnloadEvent) {
  if (current) e.preventDefault(); // browser shows its "Leave site?" prompt
}

export const pendingSave = {
  /** Register (or clear, with `save = null`) the project's unsaved-work saver. */
  register(projectId: string, save: Saver | null) {
    if (save) current = { projectId, save };
    else if (current?.projectId === projectId) current = null;
    if (!listening && typeof window !== "undefined") {
      window.addEventListener("beforeunload", onBeforeUnload);
      listening = true;
    }
  },
  /** Save pending edits for this project, if any (used before exporting). */
  async flush(projectId: string) {
    if (current?.projectId === projectId) await current.save();
  },
};
