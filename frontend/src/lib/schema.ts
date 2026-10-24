import type { AnnotationEvent, AttributeValue, LabelSchema, LabelValue, SchemaField } from "./types";

export function slugifyKey(label: string): string {
  return (
    label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 64) || "field"
  );
}

export function uniqueKey(label: string, taken: Set<string>): string {
  const base = slugifyKey(label);
  let key = base;
  let i = 2;
  while (taken.has(key)) key = `${base}_${i++}`;
  return key;
}

/** A schema field with every optional property filled in. */
export function makeField(field: Partial<SchemaField> & Pick<SchemaField, "key" | "label" | "type">): SchemaField {
  return { options: [], default: null, multiple: false, required: false, placeholder: "", scope: "event", ...field };
}

export const SAMPLE_SCHEMA: LabelSchema = {
  event_types: ["Smash", "Drop", "Clear", "Drive", "Net shot", "Serve"],
  fields: [
    makeField({ key: "forehand", label: "Forehand", type: "checkbox", default: false }),
    makeField({ key: "winning_shot", label: "Winning Shot", type: "checkbox", default: false }),
    makeField({ key: "unforced_error", label: "Unforced Error", type: "checkbox", default: false }),
    makeField({ key: "court_side", label: "Court Side", type: "select", options: ["Left", "Center", "Right"] }),
  ],
};

export const videoFields = (schema: LabelSchema) => schema.fields.filter((f) => f.scope === "video");
export const eventFields = (schema: LabelSchema) => schema.fields.filter((f) => f.scope !== "video");

/** Does this schema record per-timestamp events? Yes when it has event types or per-timestamp
 * fields, and also when it has no whole-video fields at all (plain timestamp marking). */
export const hasEventSection = (schema: LabelSchema) =>
  schema.event_types.length > 0 || eventFields(schema).length > 0 || videoFields(schema).length === 0;

/* ------------------------------------------------------------------ values ---------------------------- */

function emptyValue(f: SchemaField): LabelValue {
  if (f.type === "checkbox") return Boolean(f.default);
  if (f.type === "choices" && f.multiple) return [];
  return typeof f.default === "string" && f.default ? f.default : null;
}

/** Next value after toggling a checkbox, or an option of a choices group (single choice acts as an
 * unsettable radio; multiple choice adds/removes the option). */
export function toggledValue(field: SchemaField, current: LabelValue | undefined, option?: string): LabelValue {
  if (field.type === "checkbox") return !current;
  if (field.multiple) {
    const list = Array.isArray(current) ? current : typeof current === "string" && current ? [current] : [];
    return list.includes(option!) ? list.filter((o) => o !== option) : [...list, option!];
  }
  return current === option ? null : option!;
}

export const isEmptyValue = (value: LabelValue | undefined) =>
  value == null || value === "" || value === false || (Array.isArray(value) && value.length === 0);

export function formatValue(value: LabelValue | undefined): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "boolean") return value ? "yes" : "no";
  return value ?? "";
}

/* ------------------------------------------------------------- whole-video labels --------------------- */

export function emptyLabels(schema: LabelSchema): Record<string, LabelValue> {
  return Object.fromEntries(videoFields(schema).map((f) => [f.key, emptyValue(f)]));
}

/** Saved labels on top of the defaults (unknown keys are kept, so nothing saved is ever dropped). */
export const withLabelDefaults = (schema: LabelSchema, labels: Record<string, LabelValue> | undefined) => ({
  ...emptyLabels(schema),
  ...labels,
});

export function missingRequiredLabels(schema: LabelSchema, labels: Record<string, LabelValue>): SchemaField[] {
  return videoFields(schema).filter((f) => f.required && f.type !== "checkbox" && isEmptyValue(labels[f.key]));
}

/* ------------------------------------------------------------- per-timestamp draft -------------------- */

export type DraftValues = Pick<AnnotationEvent, "event_name" | "checkboxes" | "attributes" | "note">;

export function emptyDraft(schema: LabelSchema): DraftValues {
  const checkboxes: Record<string, boolean> = {};
  const attributes: Record<string, AttributeValue> = {};
  for (const f of eventFields(schema)) {
    if (f.type === "checkbox") checkboxes[f.key] = Boolean(f.default);
    else attributes[f.key] = emptyValue(f) as AttributeValue;
  }
  return { event_name: null, checkboxes, attributes, note: "" };
}

/** Value of an event field in the draft, in the shared LabelValue shape. */
export const draftValue = (draft: DraftValues, f: SchemaField): LabelValue =>
  f.type === "checkbox" ? Boolean(draft.checkboxes[f.key]) : (draft.attributes[f.key] ?? null);

export function setDraftValue(draft: DraftValues, f: SchemaField, value: LabelValue): DraftValues {
  return f.type === "checkbox"
    ? { ...draft, checkboxes: { ...draft.checkboxes, [f.key]: Boolean(value) } }
    : { ...draft, attributes: { ...draft.attributes, [f.key]: value as AttributeValue } };
}

/**
 * The draft restricted to the schema: values for removed fields or event types are dropped and
 * values whose shape no longer fits a field's type (e.g. after an edit in Settings) are reset.
 */
export function reconcileDraft(draft: DraftValues, schema: LabelSchema): DraftValues {
  const out = emptyDraft(schema);
  for (const f of eventFields(schema)) {
    if (f.type === "checkbox") {
      const v = draft.checkboxes[f.key];
      if (typeof v === "boolean") out.checkboxes[f.key] = v;
      continue;
    }
    const v = draft.attributes[f.key];
    if (f.type === "text") {
      if (typeof v === "string") out.attributes[f.key] = v;
    } else if (f.multiple) {
      const list = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
      out.attributes[f.key] = list.filter((o) => f.options.includes(o));
    } else if (typeof v === "string" && f.options.includes(v)) {
      out.attributes[f.key] = v;
    }
  }
  out.event_name = draft.event_name && schema.event_types.includes(draft.event_name) ? draft.event_name : null;
  out.note = draft.note;
  return out;
}

/** True when the draft holds selections that would be lost if the video were saved now. */
export function draftHasValues(draft: DraftValues, schema: LabelSchema): boolean {
  const empty = emptyDraft(schema);
  const r = reconcileDraft(draft, schema);
  return (
    Boolean(r.event_name) ||
    Boolean(r.note.trim()) ||
    JSON.stringify([r.checkboxes, r.attributes]) !== JSON.stringify([empty.checkboxes, empty.attributes])
  );
}

export function missingRequired(schema: LabelSchema, draft: DraftValues): SchemaField[] {
  return eventFields(schema).filter(
    (f) => f.required && f.type !== "checkbox" && isEmptyValue(draft.attributes[f.key]),
  );
}

/* ------------------------------------------------------------------ hotkeys --------------------------- */

/**
 * Everything the number keys can toggle, in display order (whole-video fields first, then
 * per-timestamp fields): checkbox fields and every option of a choices group. Keys 1–9 map to the
 * first nine.
 */
export type HotkeyTarget = { field: SchemaField; option?: string };

export function hotkeyTargets(schema: LabelSchema): HotkeyTarget[] {
  const targets: HotkeyTarget[] = [];
  for (const field of [...videoFields(schema), ...eventFields(schema)]) {
    if (field.type === "checkbox") targets.push({ field });
    else if (field.type === "choices") for (const option of field.options) targets.push({ field, option });
  }
  return targets;
}
