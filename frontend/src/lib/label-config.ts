/**
 * Label Studio-style XML <-> Lemon label schema.
 *
 * Supported tags
 *   <Header value="…"/>                     label for the next control
 *   <Choices name choice="single|multiple" required layout="select">  + <Choice value selected/>
 *   <TextArea name placeholder required/>
 *   <TimelineLabels name> / <Labels name>   + <Label value/>  -> event types
 *   <Checkbox name value checked/>          Lemon extension for a single true/false flag
 *   perRegion="true" on a control           recorded per timestamp; otherwise one answer per video
 * Object tags (<Video>, <Audio>, …) and layout tags (<View>, <Style>, …) are accepted and ignored.
 */
import { makeField, uniqueKey } from "./schema";
import type { LabelSchema, SchemaField } from "./types";

export interface ParseResult {
  schema: LabelSchema | null;
  errors: string[];
  warnings: string[];
}

/** Object tags: they display data, so a <Header> before one labels it, not the next control. */
const OBJECT_TAGS = new Set([
  "video",
  "audio",
  "audioplus",
  "image",
  "text",
  "hypertext",
  "paragraphs",
  "timeseries",
  "table",
  "list",
  "pdf",
  "markdown",
]);

const IGNORED_TAGS = new Set([
  "view",
  "style",
  "collapse",
  "panel",
  "filter",
  "video",
  "audio",
  "audioplus",
  "image",
  "text",
  "hypertext",
  "paragraphs",
  "timeseries",
  "table",
  "list",
  "pdf",
  "markdown",
  "choice",
  "label",
  "header",
]);

/** Label Studio controls describe the whole task (video) unless they're marked perRegion. */
const scopeOf = (el: Element) => (truthy(el.getAttribute("perRegion")) ? "event" : "video");

const truthy = (v: string | null) => v !== null && ["true", "1", "yes"].includes(v.trim().toLowerCase());

const humanize = (name: string) =>
  name
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^./, (c) => c.toUpperCase());

/** Values of direct <Choice>/<Label> children, plus the ones marked selected. */
function childValues(el: Element, tag: string): { values: string[]; selected: string[] } {
  const values: string[] = [];
  const selected: string[] = [];
  for (const child of Array.from(el.children)) {
    if (child.tagName.toLowerCase() !== tag) continue;
    const value = (child.getAttribute("value") ?? child.getAttribute("alias") ?? child.textContent ?? "").trim();
    if (!value) continue;
    if (!values.some((v) => v.toLowerCase() === value.toLowerCase())) values.push(value);
    if (truthy(child.getAttribute("selected"))) selected.push(value);
  }
  return { values, selected };
}

function parserErrorMessage(doc: Document): string | null {
  const err = doc.getElementsByTagName("parsererror")[0];
  if (!err) return null;
  // Browsers wrap the message differently; keep the first meaningful line.
  const text = (err.textContent ?? "").replace(/\s+/g, " ").trim();
  const match = /(line \d+[^:]*:?.*?)(?:Below is|$)/i.exec(text);
  return `Invalid XML: ${(match?.[1] ?? text).slice(0, 220)}`;
}

export function parseLabelConfig(xml: string, existing?: LabelSchema): ParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!xml.trim()) return { schema: null, errors: ["Paste a label config to import."], warnings };

  const doc = new DOMParser().parseFromString(xml, "application/xml");
  const parseError = parserErrorMessage(doc);
  if (parseError) return { schema: null, errors: [parseError], warnings };

  const root = doc.documentElement;
  if (root.tagName.toLowerCase() !== "view") warnings.push(`Root element is <${root.tagName}>; expected <View>.`);

  const eventTypes: string[] = [];
  const fields: SchemaField[] = [];
  const takenKeys = new Set<string>();
  const usedNames = new Set<string>();
  const existingByKey = new Map((existing?.fields ?? []).map((f) => [f.key, f]));
  let pendingHeader: string | null = null;

  const claimKey = (rawName: string | null, label: string, tag: string): string | null => {
    const name = (rawName ?? "").trim();
    if (!name) {
      errors.push(`<${tag}> "${label}" is missing a name attribute.`);
      return null;
    }
    if (usedNames.has(name)) {
      errors.push(`Duplicate name "${name}". Every control needs a unique name.`);
      return null;
    }
    usedNames.add(name);
    const key = uniqueKey(name, takenKeys);
    if (key !== name) warnings.push(`"${name}" is stored as "${key}" (lowercase letters, numbers and _ only).`);
    takenKeys.add(key);
    return key;
  };

  const takeLabel = (fallbackName: string | null) => {
    const label = pendingHeader ?? humanize(fallbackName ?? "");
    pendingHeader = null;
    return label || "Untitled";
  };

  for (const el of Array.from(root.getElementsByTagName("*"))) {
    const tag = el.tagName.toLowerCase();
    switch (tag) {
      case "header": {
        const value = (el.getAttribute("value") ?? el.textContent ?? "").trim();
        pendingHeader = value || null;
        break;
      }
      case "timelinelabels":
      case "labels": {
        const { values } = childValues(el, "label");
        if (eventTypes.length)
          warnings.push(`Multiple <${el.tagName}> blocks were merged into one list of event types.`);
        for (const v of values) if (!eventTypes.some((t) => t.toLowerCase() === v.toLowerCase())) eventTypes.push(v);
        if (!values.length)
          warnings.push(`<${el.tagName} name="${el.getAttribute("name") ?? ""}"> has no <Label> values.`);
        pendingHeader = null;
        break;
      }
      case "choices": {
        const label = takeLabel(el.getAttribute("name"));
        const key = claimKey(el.getAttribute("name"), label, el.tagName);
        if (!key) break;
        const { values, selected } = childValues(el, "choice");
        if (!values.length) {
          errors.push(`<Choices name="${el.getAttribute("name")}"> has no <Choice> options.`);
          break;
        }
        const multiple = (el.getAttribute("choice") ?? "single").toLowerCase() === "multiple";
        const asDropdown = !multiple && (el.getAttribute("layout") ?? "").toLowerCase() === "select";
        fields.push(
          makeField({
            key,
            label,
            type: asDropdown ? "select" : "choices",
            options: values,
            multiple,
            required: truthy(el.getAttribute("required")),
            default: !multiple && selected[0] ? selected[0] : null,
            scope: scopeOf(el),
          }),
        );
        break;
      }
      case "textarea": {
        const label = takeLabel(el.getAttribute("name"));
        const key = claimKey(el.getAttribute("name"), label, el.tagName);
        if (!key) break;
        fields.push(
          makeField({
            key,
            label,
            type: "text",
            default: "",
            required: truthy(el.getAttribute("required")),
            placeholder: el.getAttribute("placeholder") ?? "",
            scope: scopeOf(el),
          }),
        );
        break;
      }
      case "checkbox": {
        const label = (el.getAttribute("value") ?? "").trim() || takeLabel(el.getAttribute("name"));
        pendingHeader = null;
        const key = claimKey(el.getAttribute("name"), label, el.tagName);
        if (!key) break;
        fields.push(
          makeField({ key, label, type: "checkbox", default: truthy(el.getAttribute("checked")), scope: scopeOf(el) }),
        );
        break;
      }
      default:
        if (OBJECT_TAGS.has(tag)) {
          pendingHeader = null;
        } else if (!IGNORED_TAGS.has(tag)) {
          const name = el.getAttribute("name");
          warnings.push(`<${el.tagName}${name ? ` name="${name}"` : ""}> is not supported and was ignored.`);
          pendingHeader = null;
        }
    }
  }

  // Two controls under the same header text would collide; disambiguate with the key.
  const seen = new Map<string, number>();
  for (const f of fields) {
    const n = (seen.get(f.label.toLowerCase()) ?? 0) + 1;
    seen.set(f.label.toLowerCase(), n);
    if (n > 1) f.label = `${f.label} (${f.key})`;
  }

  for (const f of fields) {
    const before = existingByKey.get(f.key);
    if (before && before.type !== f.type) {
      warnings.push(`"${f.label}" changes type from ${before.type} to ${f.type}; values saved earlier may not match.`);
    }
  }

  if (!fields.length && !eventTypes.length && !errors.length) {
    errors.push("No supported controls found. Add <Choices>, <TextArea> or <TimelineLabels> elements.");
  }
  return errors.length
    ? { schema: null, errors, warnings }
    : { schema: { event_types: eventTypes, fields }, errors, warnings };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function serializeLabelConfig(schema: LabelSchema): string {
  const lines = ["<View>", '  <Video name="video" value="$video"/>'];

  if (schema.event_types.length) {
    lines.push("", "  <!-- Event types (the event name of each captured timestamp) -->");
    lines.push('  <TimelineLabels name="event_type" toName="video">');
    for (const t of schema.event_types) lines.push(`    <Label value="${esc(t)}"/>`);
    lines.push("  </TimelineLabels>");
  }

  for (const f of schema.fields) {
    lines.push("");
    const required = (f.required ? ' required="true"' : "") + (f.scope === "event" ? ' perRegion="true"' : "");
    if (f.type === "checkbox") {
      const perRegion = f.scope === "event" ? ' perRegion="true"' : "";
      lines.push(
        `  <Checkbox name="${f.key}" value="${esc(f.label)}"${f.default ? ' checked="true"' : ""}${perRegion}/>`,
      );
      continue;
    }
    lines.push(`  <Header value="${esc(f.label)}"/>`);
    if (f.type === "text") {
      const placeholder = f.placeholder ? ` placeholder="${esc(f.placeholder)}"` : "";
      lines.push(`  <TextArea name="${f.key}" toName="video" rows="3"${placeholder}${required}/>`);
      continue;
    }
    const choice = f.type === "choices" && f.multiple ? "multiple" : "single";
    const layout = f.type === "select" ? ' layout="select"' : "";
    lines.push(`  <Choices name="${f.key}" toName="video" choice="${choice}"${layout}${required}>`);
    for (const o of f.options) {
      lines.push(`    <Choice value="${esc(o)}"${f.default === o ? ' selected="true"' : ""}/>`);
    }
    lines.push("  </Choices>");
  }

  lines.push("</View>", "");
  return lines.join("\n");
}

/** Short human summary of a parsed schema, e.g. "3 event types · 4 choices · 1 text field". */
export function describeSchema(schema: LabelSchema): string {
  const count = (n: number, one: string, many = `${one}s`) => (n ? `${n} ${n === 1 ? one : many}` : null);
  const byType = (t: SchemaField["type"]) => schema.fields.filter((f) => f.type === t).length;
  return (
    [
      count(schema.event_types.length, "event type"),
      count(byType("choices"), "choice group"),
      count(byType("select"), "dropdown"),
      count(byType("checkbox"), "checkbox", "checkboxes"),
      count(byType("text"), "text field"),
    ]
      .filter(Boolean)
      .join(" · ") || "empty"
  );
}
