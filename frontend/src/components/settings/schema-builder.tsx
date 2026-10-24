"use client";

import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  CheckCircle2,
  CheckSquare,
  ChevronDown,
  Code2,
  LayoutList,
  ListChecks,
  Plus,
  Sparkles,
  Trash2,
  Type,
  X,
  XCircle,
} from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";

import { LabelConfigEditor } from "@/components/settings/label-config-editor";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useUpdateProject } from "@/hooks/queries";
import { errorMessage } from "@/lib/api";
import { describeSchema, parseLabelConfig, serializeLabelConfig } from "@/lib/label-config";
import { hotkeyTargets, makeField, SAMPLE_SCHEMA, uniqueKey } from "@/lib/schema";
import type { FieldType, LabelSchema, Project, SchemaField } from "@/lib/types";
import { cn } from "@/lib/utils";

const TYPE_META: Record<FieldType, { label: string; icon: typeof CheckSquare; hint: string }> = {
  checkbox: { label: "Checkbox", icon: CheckSquare, hint: "A single true/false flag" },
  choices: { label: "Choices", icon: ListChecks, hint: "A visible list of options (single or multiple)" },
  select: { label: "Dropdown", icon: ChevronDown, hint: "One value picked from a dropdown" },
  text: { label: "Text", icon: Type, hint: "Free text" },
};

type Mode = "visual" | "code";

interface DraftField extends SchemaField {
  /** Local row id; `locked` means the key already exists in saved annotations. */
  _id: string;
  locked: boolean;
}

interface Draft {
  event_types: string[];
  fields: DraftField[];
}

const toDraft = (schema: LabelSchema, lockedKeys?: Set<string>): Draft => ({
  event_types: [...schema.event_types],
  fields: schema.fields.map((f) => ({
    ...makeField(f),
    _id: `${f.key}-${Math.random().toString(36).slice(2, 8)}`,
    locked: lockedKeys ? lockedKeys.has(f.key) : true,
  })),
});

const toSchema = (draft: Draft): LabelSchema => ({
  event_types: draft.event_types,
  fields: draft.fields.map((f) =>
    makeField({
      key: f.key,
      label: f.label.trim(),
      type: f.type,
      options: f.options,
      default: f.default,
      multiple: f.multiple,
      required: f.required,
      placeholder: f.placeholder,
      scope: f.scope,
    }),
  ),
});

/** Comparable form of a schema, ignoring local row ids. */
const fingerprint = (schema: LabelSchema) =>
  JSON.stringify([
    schema.event_types,
    schema.fields.map((f) => [
      f.key,
      f.label.trim(),
      f.type,
      f.options,
      f.default ?? null,
      f.multiple,
      f.required,
      f.placeholder,
      f.scope,
    ]),
  ]);

function validate(event_types: string[], fields: DraftField[]): Record<string, string> {
  const errors: Record<string, string> = {};
  const labels = new Map<string, string>();
  for (const f of fields) {
    const label = f.label.trim().toLowerCase();
    if (!label) errors[f._id] = "Label is required";
    else if (labels.has(label)) errors[f._id] = "Duplicate label";
    else labels.set(label, f._id);
    if ((f.type === "select" || f.type === "choices") && f.options.length === 0)
      errors[f._id] = "Add at least one option";
  }
  if (new Set(event_types.map((t) => t.toLowerCase())).size !== event_types.length) {
    errors.event_types = "Event types must be unique";
  }
  return errors;
}

export function SchemaBuilder({ project }: { project: Project }) {
  const [saved, setSaved] = useState<LabelSchema>(() => toSchema(toDraft(project.label_schema)));
  const [draft, setDraft] = useState<Draft>(() => toDraft(project.label_schema));
  const [mode, setMode] = useState<Mode>("visual");
  const [code, setCode] = useState("");
  const [newType, setNewType] = useState("");
  const update = useUpdateProject(project.id);

  const savedKeys = useMemo(() => new Set(saved.fields.map((f) => f.key)), [saved]);
  const parsed = useMemo(() => (mode === "code" ? parseLabelConfig(code, saved) : null), [mode, code, saved]);
  const errors = useMemo(() => validate(draft.event_types, draft.fields), [draft]);

  const current: LabelSchema | null = mode === "code" ? (parsed?.schema ?? null) : toSchema(draft);
  const dirty = current ? fingerprint(current) !== fingerprint(saved) : true;
  const canSave = mode === "code" ? Boolean(parsed?.schema) : Object.keys(errors).length === 0;

  const setEventTypes = (event_types: string[]) => setDraft((d) => ({ ...d, event_types }));
  const setFields = (fn: (fields: DraftField[]) => DraftField[]) => setDraft((d) => ({ ...d, fields: fn(d.fields) }));

  /* ------------------------------ mode switch ----------------------------- */

  const switchMode = (next: Mode) => {
    if (next === mode) return;
    if (next === "code") {
      setCode(serializeLabelConfig(toSchema(draft)));
      setMode("code");
      return;
    }
    const result = parseLabelConfig(code, saved);
    if (!result.schema) {
      toast.error("Fix the config before switching to Visual", { description: result.errors[0] });
      return;
    }
    setDraft(toDraft(result.schema, savedKeys));
    setMode("visual");
  };

  /* -------------------------------- visual -------------------------------- */

  const addType = () => {
    const parts = newType
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean);
    if (!parts.length) return;
    const existing = new Set(draft.event_types.map((t) => t.toLowerCase()));
    const fresh = parts.filter((t) => !existing.has(t.toLowerCase()));
    if (fresh.length < parts.length) toast.info("Skipped duplicate event types");
    setEventTypes([...draft.event_types, ...fresh]);
    setNewType("");
  };

  const addField = (type: FieldType) => {
    const taken = new Set(draft.fields.map((f) => f.key));
    const label = `${TYPE_META[type].label} ${draft.fields.length + 1}`;
    const key = uniqueKey(label, taken);
    setFields((fields) => [
      ...fields,
      {
        ...makeField({
          key,
          label,
          type,
          options: type === "select" || type === "choices" ? ["Option A", "Option B"] : [],
          default: type === "checkbox" ? false : type === "text" ? "" : null,
          scope: "video",
        }),
        _id: `${key}-${Date.now()}`,
        locked: false,
      },
    ]);
  };

  const patchField = (id: string, patch: Partial<DraftField>) =>
    setFields((prev) =>
      prev.map((f) => {
        if (f._id !== id) return f;
        const next = { ...f, ...patch };
        // New fields derive their key from the label until first saved.
        if (patch.label !== undefined && !f.locked) {
          const taken = new Set(prev.filter((o) => o._id !== id).map((o) => o.key));
          next.key = uniqueKey(patch.label, taken);
        }
        if (patch.type && patch.type !== f.type) {
          const hasOptions = patch.type === "select" || patch.type === "choices";
          next.options = hasOptions ? (f.options.length ? f.options : ["Option A"]) : [];
          next.default = patch.type === "checkbox" ? false : patch.type === "text" ? "" : null;
          next.multiple = false;
          if (patch.type === "checkbox") next.required = false;
        }
        if (patch.multiple) next.default = null;
        return next;
      }),
    );

  const move = (index: number, dir: -1 | 1) =>
    setFields((fields) => {
      const next = [...fields];
      const [item] = next.splice(index, 1);
      next.splice(index + dir, 0, item);
      return next;
    });

  /* ------------------------------- actions -------------------------------- */

  const loadSample = () => {
    if (mode === "code") setCode(serializeLabelConfig(SAMPLE_SCHEMA));
    else setDraft(toDraft(SAMPLE_SCHEMA, savedKeys));
  };

  const reset = () => {
    setDraft(toDraft(saved));
    if (mode === "code") setCode(serializeLabelConfig(saved));
  };

  const save = () => {
    if (!current) return;
    update.mutate(
      { label_schema: current },
      {
        onSuccess: (p) => {
          const next = toSchema(toDraft(p.label_schema));
          setSaved(next);
          setDraft(toDraft(p.label_schema));
          toast.success("Label schema saved", {
            description: `${describeSchema(next)}. Available in the Annotate tab now.`,
          });
        },
        onError: (err) => {
          const { title, hint } = errorMessage(err);
          toast.error(title, { description: hint ?? undefined });
        },
      },
    );
  };

  const targetIndex = new Map(
    hotkeyTargets(toSchema(draft)).map((t, i) => [`${t.field.key}::${t.option ?? ""}`, i] as const),
  );

  return (
    <Card>
      <CardHeader>
        <CardTitle>Label schema</CardTitle>
        <CardDescription>
          The event types and attributes recorded at every captured timestamp, for all videos in this project.
        </CardDescription>
        <CardAction className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={loadSample}>
            <Sparkles /> Load example
          </Button>
          <div role="tablist" aria-label="Editor mode" className="flex rounded-lg border bg-muted/40 p-0.5">
            {(
              [
                ["visual", "Visual", LayoutList],
                ["code", "Code", Code2],
              ] as const
            ).map(([m, label, Icon]) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-selected={mode === m}
                onClick={() => switchMode(m)}
                className={cn(
                  "flex h-7 items-center gap-1.5 rounded-md px-2.5 text-sm transition-colors",
                  mode === m ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon className="size-3.5" /> {label}
              </button>
            ))}
          </div>
        </CardAction>
      </CardHeader>

      <CardContent className="grid grid-cols-1 gap-6">
        {mode === "code" ? (
          <CodeMode code={code} onChange={setCode} parsed={parsed} />
        ) : (
          <>
            {/* Event types */}
            <section className="grid gap-3">
              <div>
                <Label>Event types</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  Optional. The &ldquo;Event type&rdquo; dropdown in the tagging panel. Shortcut: <Kbd>Shift</Kbd> +{" "}
                  <Kbd>1</Kbd>–<Kbd>9</Kbd>.
                </p>
              </div>
              <div className="flex flex-wrap gap-1.5">
                {draft.event_types.map((t, i) => (
                  <Badge key={t} variant="secondary" className="h-7 gap-1.5 rounded-md pr-1 pl-2 text-sm">
                    {i < 9 && <span className="font-mono text-[10px] text-muted-foreground">{i + 1}</span>}
                    {t}
                    <button
                      type="button"
                      className="grid size-5 place-items-center rounded hover:bg-foreground/10"
                      onClick={() => setEventTypes(draft.event_types.filter((x) => x !== t))}
                      aria-label={`Remove ${t}`}
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
                {draft.event_types.length === 0 && (
                  <span className="text-sm text-muted-foreground">
                    No event types — the event type dropdown is hidden while annotating.
                  </span>
                )}
              </div>
              <form
                className="flex max-w-md gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  addType();
                }}
              >
                <Input
                  placeholder="Smash, Drop, Clear…"
                  value={newType}
                  onChange={(e) => setNewType(e.target.value)}
                  aria-label="New event type"
                />
                <Button type="submit" variant="outline" disabled={!newType.trim()}>
                  <Plus /> Add
                </Button>
              </form>
              {errors.event_types && <p className="text-xs text-destructive">{errors.event_types}</p>}
            </section>

            <Separator />

            {/* Attributes */}
            <section className="grid gap-3">
              <div>
                <Label>Attributes</Label>
                <p className="mt-1 text-xs text-muted-foreground">
                  <strong>Whole video</strong> fields are answered once per video and saved with it.{" "}
                  <strong>Each timestamp</strong> fields are recorded with every captured event. Keys <Kbd>1</Kbd>–
                  <Kbd>9</Kbd> toggle the first nine checkboxes / choice options. Prefer pasting a config? Switch to{" "}
                  <strong>Code</strong>.
                </p>
              </div>

              {draft.fields.length === 0 && (
                <div className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">
                  No attributes yet. Add checkboxes like &ldquo;Forehand&rdquo;, choices like &ldquo;Verdict: pass /
                  fail&rdquo;, or paste a Label Studio config in <strong>Code</strong>.
                </div>
              )}

              <div className="grid gap-2">
                {draft.fields.map((f, i) => (
                  <FieldRow
                    key={f._id}
                    field={f}
                    index={i}
                    count={draft.fields.length}
                    error={errors[f._id]}
                    hotkey={(option) => targetIndex.get(`${f.key}::${option ?? ""}`)}
                    onPatch={(patch) => patchField(f._id, patch)}
                    onMove={(dir) => move(i, dir)}
                    onRemove={() => setFields((fields) => fields.filter((x) => x._id !== f._id))}
                  />
                ))}
              </div>

              <div className="flex flex-wrap gap-2">
                {(Object.keys(TYPE_META) as FieldType[]).map((t) => {
                  const Icon = TYPE_META[t].icon;
                  return (
                    <Button key={t} variant="outline" size="sm" onClick={() => addField(t)} title={TYPE_META[t].hint}>
                      <Icon /> Add {TYPE_META[t].label.toLowerCase()}
                    </Button>
                  );
                })}
              </div>
            </section>
          </>
        )}
      </CardContent>

      <CardFooter className="justify-between gap-2 border-t">
        <p className="text-xs text-muted-foreground">
          {dirty ? "Unsaved changes" : "Removing an attribute hides it from new exports; saved files are untouched."}
        </p>
        <div className="flex gap-2">
          <Button variant="outline" disabled={!dirty} onClick={reset}>
            Reset
          </Button>
          <Button onClick={save} disabled={!dirty || !canSave || update.isPending}>
            {update.isPending && <Spinner />} Save schema
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
}

/* ---------------------------------------------------------------------------------------------- */

function CodeMode({
  code,
  onChange,
  parsed,
}: {
  code: string;
  onChange: (code: string) => void;
  parsed: ReturnType<typeof parseLabelConfig> | null;
}) {
  const [showAllWarnings, setShowAllWarnings] = useState(false);
  const warnings = parsed?.warnings ?? [];
  const visibleWarnings = showAllWarnings ? warnings : warnings.slice(0, 4);

  return (
    <section className="grid gap-3">
      <p className="text-xs text-muted-foreground">
        Paste a <strong>Label Studio</strong> labeling config, or edit the generated one. Supported:{" "}
        <code className="font-mono">Header</code>, <code className="font-mono">Choices</code> /{" "}
        <code className="font-mono">Choice</code> (single, multiple, <code className="font-mono">required</code>,{" "}
        <code className="font-mono">layout=&quot;select&quot;</code>), <code className="font-mono">TextArea</code> and{" "}
        <code className="font-mono">TimelineLabels</code> for event types. Controls label the{" "}
        <strong>whole video</strong>; add <code className="font-mono">perRegion=&quot;true&quot;</code> to record one
        with every captured timestamp instead.
      </p>
      <LabelConfigEditor
        value={code}
        onChange={onChange}
        placeholder={'<View>\n  <Video name="video" value="$video"/>\n  …\n</View>'}
      />

      {parsed && (
        <div className="grid gap-2 text-sm" aria-live="polite">
          {parsed.schema ? (
            <p className="flex items-center gap-2 text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="size-4 shrink-0" />
              Valid config · {describeSchema(parsed.schema)}
            </p>
          ) : (
            parsed.errors.map((e) => (
              <p key={e} className="flex items-start gap-2 text-destructive">
                <XCircle className="mt-0.5 size-4 shrink-0" />
                <span className="break-words">{e}</span>
              </p>
            ))
          )}
          {visibleWarnings.map((w) => (
            <p key={w} className="flex items-start gap-2 text-xs text-amber-600 dark:text-amber-400">
              <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
              <span className="break-words">{w}</span>
            </p>
          ))}
          {warnings.length > visibleWarnings.length && (
            <button
              type="button"
              className="w-fit text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
              onClick={() => setShowAllWarnings(true)}
            >
              Show {warnings.length - visibleWarnings.length} more warnings
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function FieldRow({
  field: f,
  index,
  count,
  error,
  hotkey,
  onPatch,
  onMove,
  onRemove,
}: {
  field: DraftField;
  index: number;
  count: number;
  error?: string;
  hotkey: (option?: string) => number | undefined;
  onPatch: (patch: Partial<DraftField>) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
}) {
  const Icon = TYPE_META[f.type].icon;
  const cbKey = f.type === "checkbox" ? hotkey() : undefined;

  return (
    <div className="grid gap-3 rounded-lg border bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={f.type} onValueChange={(v) => onPatch({ type: v as FieldType })}>
          <SelectTrigger className="w-36" aria-label="Attribute type">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(Object.keys(TYPE_META) as FieldType[]).map((t) => {
              const TIcon = TYPE_META[t].icon;
              return (
                <SelectItem key={t} value={t}>
                  <TIcon /> {TYPE_META[t].label}
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
        <Input
          className="min-w-40 flex-1"
          value={f.label}
          onChange={(e) => onPatch({ label: e.target.value })}
          aria-label="Attribute label"
          aria-invalid={Boolean(error)}
        />
        <code
          className="hidden rounded bg-muted px-1.5 py-0.5 font-mono text-xs text-muted-foreground md:block"
          title={f.locked ? "Key is fixed once saved so existing annotations stay valid" : "Export key"}
        >
          {f.key}
        </code>
        {cbKey !== undefined && cbKey < 9 && <Kbd>{cbKey + 1}</Kbd>}
        <div className="ml-auto flex items-center">
          <Button variant="ghost" size="icon-sm" disabled={index === 0} onClick={() => onMove(-1)} aria-label="Move up">
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            disabled={index === count - 1}
            onClick={() => onMove(1)}
            aria-label="Move down"
          >
            <ArrowDown />
          </Button>
          <Button variant="ghost" size="icon-sm" onClick={onRemove} aria-label="Delete attribute">
            <Trash2 />
          </Button>
        </div>
      </div>

      {(f.type === "select" || f.type === "choices") && (
        <OptionsEditor field={f} hotkey={f.type === "choices" ? hotkey : undefined} onChange={onPatch} />
      )}
      {f.type === "text" && (
        <Input
          className="h-7 max-w-sm text-xs"
          placeholder="Placeholder shown while annotating (optional)"
          value={f.placeholder}
          onChange={(e) => onPatch({ placeholder: e.target.value })}
          aria-label="Placeholder"
        />
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-muted-foreground">
        <div role="radiogroup" aria-label="Applies to" className="flex rounded-md border bg-background p-0.5">
          {(
            [
              ["video", "Whole video"],
              ["event", "Each timestamp"],
            ] as const
          ).map(([scope, label]) => (
            <button
              key={scope}
              type="button"
              role="radio"
              aria-checked={f.scope === scope}
              onClick={() => onPatch({ scope })}
              className={cn(
                "rounded px-2 py-1 transition-colors",
                f.scope === scope ? "bg-muted font-medium text-foreground" : "hover:text-foreground",
              )}
            >
              {label}
            </button>
          ))}
        </div>
        {f.type === "checkbox" ? (
          <label className="flex items-center gap-2">
            <Switch size="sm" checked={Boolean(f.default)} onCheckedChange={(v) => onPatch({ default: v })} />
            Checked by default
          </label>
        ) : (
          <label className="flex items-center gap-2">
            <Switch size="sm" checked={f.required} onCheckedChange={(v) => onPatch({ required: v })} />
            Required before capture
          </label>
        )}
        {f.type === "choices" && (
          <label className="flex items-center gap-2">
            <Switch size="sm" checked={f.multiple} onCheckedChange={(v) => onPatch({ multiple: v })} />
            Allow multiple
          </label>
        )}
      </div>

      {error && (
        <p className="flex items-center gap-1 text-xs text-destructive">
          <Icon className="size-3" /> {error}
        </p>
      )}
    </div>
  );
}

function OptionsEditor({
  field,
  hotkey,
  onChange,
}: {
  field: DraftField;
  hotkey?: (option: string) => number | undefined;
  onChange: (patch: Partial<DraftField>) => void;
}) {
  const [value, setValue] = useState("");
  const add = () => {
    const parts = value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const existing = new Set(field.options.map((o) => o.toLowerCase()));
    const fresh = parts.filter((p) => !existing.has(p.toLowerCase()));
    if (fresh.length) onChange({ options: [...field.options, ...fresh] });
    setValue("");
  };
  const showDefault = !(field.type === "choices" && field.multiple);

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-1.5">
        {field.options.map((o) => {
          const k = hotkey?.(o);
          return (
            <Badge key={o} variant="outline" className="h-6 gap-1 rounded-md pr-0.5">
              {k !== undefined && k < 9 && <span className="font-mono text-[10px] text-muted-foreground">{k + 1}</span>}
              {o}
              <button
                type="button"
                className="grid size-4 place-items-center rounded hover:bg-foreground/10"
                onClick={() =>
                  onChange({
                    options: field.options.filter((x) => x !== o),
                    default: field.default === o ? null : field.default,
                  })
                }
                aria-label={`Remove option ${o}`}
              >
                <X className="size-3" />
              </button>
            </Badge>
          );
        })}
        <Input
          className="h-6 w-40 text-xs"
          placeholder="Add option…"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === ",") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
        />
      </div>
      {showDefault && (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          Default
          <Select
            value={typeof field.default === "string" && field.default ? field.default : "__none"}
            onValueChange={(v) => onChange({ default: v === "__none" ? null : v })}
          >
            <SelectTrigger size="sm" className="h-6 w-40 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none">None</SelectItem>
              {field.options.map((o) => (
                <SelectItem key={o} value={o}>
                  {o}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );
}
