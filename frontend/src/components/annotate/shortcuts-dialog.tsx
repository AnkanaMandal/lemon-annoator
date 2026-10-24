"use client";

import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Kbd, KbdGroup } from "@/components/ui/kbd";

const GROUPS: { title: string; items: [string[], string][] }[] = [
  {
    title: "Playback",
    items: [
      [["Space"], "Play / pause"],
      [["K"], "Play / pause"],
      [["←"], "Previous frame"],
      [["→"], "Next frame"],
      [["⇧", "←"], "Back 1 second"],
      [["⇧", "→"], "Forward 1 second"],
      [["J"], "Back (skip interval)"],
      [["L"], "Forward (skip interval)"],
      [["["], "Slower"],
      [["]"], "Faster"],
    ],
  },
  {
    title: "Tagging",
    items: [
      [["Enter"], "Capture timestamp / update event"],
      [["M"], "Capture timestamp"],
      [["1–9"], "Toggle checkbox"],
      [["⇧", "1–9"], "Set event type"],
      [["⇧", "0"], "Clear event type"],
      [["Esc"], "Cancel editing"],
      [["Del"], "Delete event being edited"],
    ],
  },
  {
    title: "Queue",
    items: [
      [["Ctrl", "S"], "Save"],
      [["Ctrl", "Enter"], "Save & Next"],
      [["Alt", "↓"], "Next video"],
      [["Alt", "↑"], "Previous video"],
      [["Q"], "Show / hide queue"],
      [["T"], "Show / hide tag panel"],
      [["?"], "Show shortcuts"],
    ],
  },
];

export function ShortcutsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>Shortcuts are paused while you type in a text field.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-6 sm:grid-cols-3">
          {GROUPS.map((g) => (
            <div key={g.title} className="space-y-2">
              <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{g.title}</h3>
              <ul className="space-y-1.5">
                {g.items.map(([keys, label]) => (
                  <li key={label + keys.join()} className="flex items-center justify-between gap-2 text-sm">
                    <span>{label}</span>
                    <KbdGroup>
                      {keys.map((k) => (
                        <Kbd key={k}>{k}</Kbd>
                      ))}
                    </KbdGroup>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}
