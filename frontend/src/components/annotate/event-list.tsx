"use client";

import { ListVideo, Pencil, Trash2 } from "lucide-react";
import { useCallback, useEffect, useRef } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { eventColor } from "@/lib/colors";
import { formatTime } from "@/lib/format";
import { formatValue, isEmptyValue, videoFields } from "@/lib/schema";
import { type TimeStore, useTimeSelector } from "@/lib/time-store";
import type { AnnotationEvent, LabelSchema, LabelValue } from "@/lib/types";
import { cn } from "@/lib/utils";

interface Props {
  events: AnnotationEvent[];
  schema: LabelSchema;
  timeStore: TimeStore;
  selectedId: string | null;
  flashId: string | null;
  onSeek: (ev: AnnotationEvent) => void;
  onEdit: (ev: AnnotationEvent) => void;
  onDelete: (ev: AnnotationEvent) => void;
}

/** Chronological log of events for the active video. Assumes `events` is sorted by time. */
export function EventList({ events, schema, timeStore, selectedId, flashId, onSeek, onEdit, onDelete }: Props) {
  const labels = Object.fromEntries(schema.fields.map((f) => [f.key, f.label]));
  const flashRef = useRef<HTMLDivElement>(null);

  // Index of the last event at or before the playhead.
  const selector = useCallback(
    (t: number) => {
      let lo = 0,
        hi = events.length - 1,
        ans = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (events[mid].timestamp <= t + 0.001) {
          ans = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }
      return ans;
    },
    [events],
  );
  const currentIndex = useTimeSelector(timeStore, selector);

  useEffect(() => {
    flashRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [flashId]);

  if (events.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-10 text-center text-sm text-muted-foreground">
        <ListVideo className="size-5" />
        <p>No events yet.</p>
        <p className="text-xs">
          Play the video and press <kbd className="rounded bg-muted px-1 font-sans">Enter</kbd> to capture a timestamp.
        </p>
      </div>
    );
  }

  return (
    <div className="divide-y">
      {events.map((ev, i) => {
        const trueBoxes = Object.entries(ev.checkboxes).filter(([, v]) => v);
        const attrs = Object.entries(ev.attributes).filter(([, v]) => !isEmptyValue(v));
        const selected = ev.id === selectedId;
        return (
          <div
            key={ev.id}
            ref={ev.id === flashId ? flashRef : undefined}
            className={cn(
              "group flex items-center gap-3 px-4 py-2 text-sm transition-colors",
              selected ? "bg-blue-500/10" : i === currentIndex ? "bg-muted/60" : "hover:bg-muted/40",
              ev.id === flashId && "animate-in fade-in-0 slide-in-from-top-1 duration-300",
            )}
          >
            <span className="w-6 shrink-0 text-right font-mono text-[11px] text-muted-foreground tabular-nums">
              {i + 1}
            </span>
            <button
              type="button"
              onClick={() => onSeek(ev)}
              className="shrink-0 rounded px-1.5 py-0.5 font-mono text-xs tabular-nums hover:bg-muted"
              title={`Jump to ${formatTime(ev.timestamp)}${ev.frame != null ? ` (frame ${ev.frame})` : ""}`}
            >
              {formatTime(ev.timestamp)}
            </button>
            <span
              className="size-2 shrink-0 rounded-full"
              style={{ backgroundColor: eventColor(ev.event_name, schema.event_types) }}
            />
            <button
              type="button"
              onClick={() => onEdit(ev)}
              className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 text-left"
            >
              {(ev.event_name || schema.event_types.length > 0) && (
                <span className={cn("font-medium", !ev.event_name && "text-muted-foreground italic")}>
                  {ev.event_name ?? "Unlabeled"}
                </span>
              )}
              {trueBoxes.map(([k]) => (
                <Badge key={k} variant="secondary" className="h-5 rounded font-normal">
                  {labels[k] ?? k}
                </Badge>
              ))}
              {attrs.map(([k, v]) => (
                <Badge key={k} variant="outline" className="h-auto min-h-5 rounded font-normal whitespace-normal">
                  <span className="text-muted-foreground">{labels[k] ?? k}:</span> {formatValue(v)}
                </Badge>
              ))}
              {trueBoxes.length + attrs.length === 0 && !ev.event_name && schema.event_types.length === 0 && (
                <span className="text-muted-foreground italic">No values</span>
              )}
              {ev.note && <span className="truncate text-xs text-muted-foreground">— {ev.note}</span>}
            </button>
            <div className="flex shrink-0 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
              <Button variant="ghost" size="icon-xs" onClick={() => onEdit(ev)} aria-label="Edit event">
                <Pencil />
              </Button>
              <Button variant="ghost" size="icon-xs" onClick={() => onDelete(ev)} aria-label="Delete event">
                <Trash2 />
              </Button>
            </div>
          </div>
        );
      })}
    </div>
  );
}

/** Read-only overview of the whole-video labels saved (or being edited) for this video. */
export function LabelsSummary({ schema, labels }: { schema: LabelSchema; labels: Record<string, LabelValue> }) {
  const fields = videoFields(schema);
  if (fields.length === 0) return null;
  const answered = fields.filter((f) => !isEmptyValue(labels[f.key]));
  return (
    <div className="border-b px-4 py-3">
      {answered.length === 0 ? (
        <p className="py-2 text-sm text-muted-foreground">
          No video labels yet. Pick them in the panel on the right, then Save.
        </p>
      ) : (
        <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
          {fields.map((f) => (
            <div key={f.key} className="contents">
              <dt className="truncate text-muted-foreground">{f.label}</dt>
              <dd className="min-w-0">
                {isEmptyValue(labels[f.key]) ? (
                  <span className="text-muted-foreground/60">—</span>
                ) : (
                  <span className="flex flex-wrap gap-1">
                    {(Array.isArray(labels[f.key]) ? (labels[f.key] as string[]) : [formatValue(labels[f.key])]).map(
                      (v) => (
                        <Badge
                          key={v}
                          variant="secondary"
                          className="h-auto min-h-5 rounded font-normal whitespace-normal"
                        >
                          {v}
                        </Badge>
                      ),
                    )}
                  </span>
                )}
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
