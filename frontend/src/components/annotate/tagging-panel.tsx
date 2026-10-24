"use client";

import { Clock, Crosshair, PanelRightClose, Pencil, Save, SkipForward, Trash2, X } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { eventColor } from "@/lib/colors";
import { formatRelative, formatTime, frameAt } from "@/lib/format";
import {
  type DraftValues,
  draftValue,
  eventFields,
  hasEventSection,
  hotkeyTargets,
  missingRequired,
  missingRequiredLabels,
  setDraftValue,
  toggledValue,
  videoFields,
} from "@/lib/schema";
import { type TimeStore, useCurrentTime } from "@/lib/time-store";
import type { AnnotationEvent, LabelSchema, LabelValue, SchemaField } from "@/lib/types";
import { cn } from "@/lib/utils";

const NONE = "__none";

export interface PanelPrefs {
  pauseOnCapture: boolean;
  keepValues: boolean;
}

interface Props {
  schema: LabelSchema;
  fps: number;
  timeStore: TimeStore;
  /** Whole-video answers (saved with the video). */
  labels: Record<string, LabelValue>;
  onLabelsChange: (labels: Record<string, LabelValue>) => void;
  /** Per-timestamp values, recorded on Capture. */
  draft: DraftValues;
  onDraftChange: (draft: DraftValues) => void;
  editing: { event: AnnotationEvent; index: number } | null;
  prefs: PanelPrefs;
  onPrefsChange: (prefs: PanelPrefs) => void;
  disabled: boolean;
  onCapture: () => void;
  onUpdate: () => void;
  onRetime: () => void;
  onCancelEdit: () => void;
  onDelete: () => void;
  // footer
  dirty: boolean;
  saving: boolean;
  status: "not_started" | "in_progress" | "completed";
  savedAt: string | null;
  eventCount: number;
  onSave: () => void;
  onSaveNext: () => void;
  /** Collapses the panel to a slim rail (desktop layout only). */
  onCollapse?: () => void;
  /** Highlight required per-timestamp fields that are still empty (after a blocked capture). */
  showRequiredErrors: boolean;
  /** Highlight required whole-video fields that are still empty (after a blocked Save & Next). */
  showRequiredLabelErrors: boolean;
}

export function TaggingPanel(props: Props) {
  const { schema, draft, onDraftChange, labels, onLabelsChange, editing, disabled, prefs } = props;
  const hotkeys = new Map(hotkeyTargets(schema).map((t, i) => [`${t.field.key}::${t.option ?? ""}`, i] as const));
  const hotkey = (f: SchemaField) => (option?: string) => hotkeys.get(`${f.key}::${option ?? ""}`);
  const missing = new Set(
    [
      ...(props.showRequiredErrors ? missingRequired(schema, draft) : []),
      ...(props.showRequiredLabelErrors ? missingRequiredLabels(schema, labels) : []),
    ].map((f) => f.key),
  );
  const videoLevel = videoFields(schema);
  const eventLevel = eventFields(schema);
  const withEvents = hasEventSection(schema);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center justify-between gap-2 border-b px-4 py-3">
        {editing ? (
          <div className="flex items-center gap-2 text-sm font-medium">
            <Pencil className="size-3.5 text-blue-500" />
            Editing event #{editing.index + 1}
            <span className="font-mono text-xs font-normal text-muted-foreground">
              @ {formatTime(editing.event.timestamp)}
            </span>
          </div>
        ) : (
          <h2 className="text-sm font-medium">Labels</h2>
        )}
        <div className="flex items-center gap-1.5">
          <LiveTime timeStore={props.timeStore} fps={props.fps} />
          {props.onCollapse && (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={props.onCollapse}
                  aria-label="Hide tag panel"
                  className="hidden lg:inline-flex"
                >
                  <PanelRightClose />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Hide tag panel (T)</TooltipContent>
            </Tooltip>
          )}
        </div>
      </div>

      <div className={cn("min-h-0 flex-1 overflow-y-auto", disabled && "pointer-events-none opacity-50")}>
        {/* Whole-video labels: saved with the video, no capture needed */}
        {videoLevel.length > 0 && !editing && (
          <section className="space-y-5 p-4" aria-label="Video labels">
            <SectionHeading title="Video labels" hint="Saved for the whole video" />
            {videoLevel.map((f) => (
              <FieldInput
                key={f.key}
                field={f}
                value={labels[f.key] ?? null}
                onChange={(v) => onLabelsChange({ ...labels, [f.key]: v })}
                hotkey={hotkey(f)}
                missing={missing.has(f.key)}
              />
            ))}
          </section>
        )}

        {/* Per-timestamp values: recorded with every capture */}
        {withEvents && (
          <section
            className={cn("space-y-5 p-4", videoLevel.length > 0 && !editing && "border-t")}
            aria-label="Timestamp event"
          >
            {videoLevel.length > 0 && !editing && (
              <SectionHeading title="Timestamp event" hint="Recorded with each capture" />
            )}

            {schema.event_types.length > 0 && (
              <div className="space-y-2">
                <Label className="flex items-center justify-between">
                  Event type
                  <span className="text-[11px] font-normal text-muted-foreground">
                    <Kbd>⇧</Kbd> + number
                  </span>
                </Label>
                <Select
                  value={draft.event_name ?? NONE}
                  onValueChange={(v) => onDraftChange({ ...draft, event_name: v === NONE ? null : v })}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select event type" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>
                      <span className="text-muted-foreground">Unlabeled</span>
                    </SelectItem>
                    {schema.event_types.map((t, i) => (
                      <SelectItem key={t} value={t}>
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: eventColor(t, schema.event_types) }}
                        />
                        {t}
                        {i < 9 && (
                          <span className="ml-auto pl-4 font-mono text-[10px] text-muted-foreground">⇧{i + 1}</span>
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            {eventLevel.map((f) => (
              <FieldInput
                key={f.key}
                field={f}
                value={draftValue(draft, f)}
                onChange={(v) => onDraftChange(setDraftValue(draft, f, v))}
                hotkey={hotkey(f)}
                missing={missing.has(f.key)}
              />
            ))}

            <div className="space-y-2">
              <Label htmlFor="note">
                Note <span className="font-normal text-muted-foreground">(optional)</span>
              </Label>
              <Textarea
                id="note"
                rows={2}
                value={draft.note}
                onChange={(e) => onDraftChange({ ...draft, note: e.target.value })}
                placeholder="Anything worth remembering…"
                className="resize-none"
              />
            </div>

            <div className="grid gap-2.5 rounded-lg border border-dashed p-3">
              <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                Pause video on capture
                <Switch
                  size="sm"
                  checked={prefs.pauseOnCapture}
                  onCheckedChange={(v) => props.onPrefsChange({ ...prefs, pauseOnCapture: v })}
                />
              </label>
              <label className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                Keep values after capture
                <Switch
                  size="sm"
                  checked={prefs.keepValues}
                  onCheckedChange={(v) => props.onPrefsChange({ ...prefs, keepValues: v })}
                />
              </label>
            </div>
          </section>
        )}

        {videoLevel.length === 0 && !withEvents && (
          <p className="p-6 text-center text-sm text-muted-foreground">
            No labels defined yet. Add them in <strong>Settings → Label schema</strong>.
          </p>
        )}
      </div>

      <Separator />
      <div className="space-y-2.5 p-4">
        {/* Capture / update stay pinned here so they're reachable however long the schema is. */}
        {editing ? (
          <div className="grid gap-2">
            <Button size="lg" onClick={props.onUpdate} disabled={disabled} className="w-full">
              <Save /> Update event
              <Kbd className="ml-auto bg-primary-foreground/15 text-primary-foreground">↵</Kbd>
            </Button>
            <div className="grid grid-cols-3 gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={props.onRetime}
                title="Move this event to the current playhead"
              >
                <Clock /> Retime
              </Button>
              <Button variant="outline" size="sm" onClick={props.onCancelEdit}>
                <X /> Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={props.onDelete}>
                <Trash2 /> Delete
              </Button>
            </div>
          </div>
        ) : (
          withEvents && (
            <Button size="lg" onClick={props.onCapture} disabled={disabled} className="h-11 w-full text-[15px]">
              <Crosshair /> Capture Current Timestamp
              <Kbd className="ml-auto bg-primary-foreground/15 text-primary-foreground">↵</Kbd>
            </Button>
          )
        )}
        <div className="flex items-center justify-between text-xs">
          <StatusLine dirty={props.dirty} status={props.status} savedAt={props.savedAt} />
          {withEvents && <span className="text-muted-foreground tabular-nums">{props.eventCount} events</span>}
        </div>
        <div className="grid grid-cols-[auto_1fr] gap-2">
          <Button variant="outline" onClick={props.onSave} disabled={disabled || props.saving} title="Save (Ctrl+S)">
            <Save /> Save
          </Button>
          <Button
            onClick={props.onSaveNext}
            disabled={disabled || props.saving}
            className="bg-emerald-600 text-white hover:bg-emerald-600/90 dark:bg-emerald-600 dark:hover:bg-emerald-500"
          >
            {props.saving ? <Spinner /> : <SkipForward />} Save &amp; Next
            <KbdGroup className="ml-auto hidden xl:inline-flex">
              <Kbd className="bg-white/15 text-white">Ctrl</Kbd>
              <Kbd className="bg-white/15 text-white">↵</Kbd>
            </KbdGroup>
          </Button>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ title, hint }: { title: string; hint: string }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">{title}</h3>
      <span className="text-[11px] text-muted-foreground">{hint}</span>
    </div>
  );
}

function FieldInput({
  field: f,
  value,
  onChange,
  hotkey,
  missing,
}: {
  field: SchemaField;
  value: LabelValue;
  onChange: (value: LabelValue) => void;
  hotkey: (option?: string) => number | undefined;
  missing: boolean;
}) {
  const id = `${f.scope}-${f.key}`;
  const heading = (
    <span className={cn("flex items-center gap-1", missing && "text-destructive")}>
      {f.label}
      {f.required && (
        <span className="text-destructive" aria-label="required">
          *
        </span>
      )}
    </span>
  );

  if (f.type === "checkbox") {
    const checked = Boolean(value);
    const k = hotkey();
    return (
      <label
        htmlFor={id}
        className={cn(
          "flex cursor-pointer items-center gap-3 rounded-md border px-3 py-2 text-sm transition-colors",
          checked ? "border-primary/50 bg-primary/5" : "bg-card hover:bg-muted/60",
        )}
      >
        <Checkbox id={id} checked={checked} onCheckedChange={(v) => onChange(v === true)} />
        <span className="flex-1">{f.label}</span>
        {k !== undefined && k < 9 && <Kbd>{k + 1}</Kbd>}
      </label>
    );
  }

  if (f.type === "choices") {
    const selected = new Set(Array.isArray(value) ? value : typeof value === "string" && value ? [value] : []);
    return (
      <fieldset className="space-y-1.5">
        <legend className="mb-1.5 flex w-full items-baseline justify-between gap-2 text-sm font-medium">
          {heading}
          <span className={cn("text-[11px] font-normal", missing ? "text-destructive" : "text-muted-foreground")}>
            {missing ? "Required" : f.multiple ? "Select any" : "Select one"}
          </span>
        </legend>
        <div className={cn("grid gap-0.5 rounded-lg", missing && "ring-1 ring-destructive/50")}>
          {f.options.map((option) => {
            const isOn = selected.has(option);
            const k = hotkey(option);
            return (
              <label
                key={option}
                className={cn(
                  "flex cursor-pointer items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
                  isOn ? "bg-primary/8 font-medium" : "hover:bg-muted/60",
                )}
              >
                <Checkbox
                  checked={isOn}
                  onCheckedChange={() => onChange(toggledValue(f, value, option))}
                  className={cn(!f.multiple && "rounded-full")}
                />
                <span className="min-w-0 flex-1 break-words">{option}</span>
                {k !== undefined && k < 9 && <Kbd>{k + 1}</Kbd>}
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  }

  const text = typeof value === "string" ? value : null;
  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{heading}</Label>
      {f.type === "select" ? (
        <Select value={text ?? NONE} onValueChange={(v) => onChange(v === NONE ? null : v)}>
          <SelectTrigger id={id} className={cn("w-full", missing && "border-destructive")}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>
              <span className="text-muted-foreground">—</span>
            </SelectItem>
            {f.options.map((o) => (
              <SelectItem key={o} value={o}>
                {o}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : (
        <Textarea
          id={id}
          rows={2}
          className={cn("resize-none", missing && "border-destructive")}
          placeholder={f.placeholder || undefined}
          value={text ?? ""}
          onChange={(e) => onChange(e.target.value || null)}
        />
      )}
    </div>
  );
}

function LiveTime({ timeStore, fps }: { timeStore: TimeStore; fps: number }) {
  const t = useCurrentTime(timeStore);
  return (
    <div className="flex items-center gap-1.5 font-mono text-xs tabular-nums">
      <span className="rounded bg-muted px-1.5 py-0.5">{formatTime(t)}</span>
      <span className="text-muted-foreground">F{frameAt(t, fps)}</span>
    </div>
  );
}

function StatusLine({ dirty, status, savedAt }: { dirty: boolean; status: Props["status"]; savedAt: string | null }) {
  if (dirty)
    return (
      <span className="flex items-center gap-1.5 text-amber-600 dark:text-amber-400">
        <span className="size-1.5 rounded-full bg-current" /> Unsaved changes
      </span>
    );
  if (status === "completed")
    return (
      <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
        Completed · {formatRelative(savedAt)}
      </Badge>
    );
  if (savedAt) return <span className="text-muted-foreground">Saved {formatRelative(savedAt)}</span>;
  return <span className="text-muted-foreground">Not saved yet</span>;
}
