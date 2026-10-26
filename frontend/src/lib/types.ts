export type FieldType = "checkbox" | "select" | "choices" | "text";

export interface SchemaField {
  key: string;
  label: string;
  type: FieldType;
  options: string[];
  default: boolean | string | null;
  /** choices only: several options may be selected (stored as a list). */
  multiple: boolean;
  /** Must be filled in before an event can be captured. */
  required: boolean;
  /** text only. */
  placeholder: string;
  /** "video": one answer per video, saved with it. "event": recorded with every captured timestamp. */
  scope: FieldScope;
}

export type FieldScope = "video" | "event";

/** A whole-video answer: checkbox -> boolean; dropdown / choice / text -> string; multiple -> list. */
export type LabelValue = boolean | string | string[] | null;

/** Dropdown / single choice / text -> string | null; multiple choice -> list of selected options. */
export type AttributeValue = string | string[] | null;

export interface LabelSchema {
  event_types: string[];
  fields: SchemaField[];
}

export interface StoragePublic {
  access_key_id: string;
  has_secret_access_key: boolean;
  has_session_token: boolean;
  region: string;
  bucket: string;
  prefix: string;
  endpoint_url: string;
  is_configured: boolean;
}

export interface StorageUpdate {
  access_key_id?: string;
  /** Omit to keep the saved secret, "" to clear it. */
  secret_access_key?: string;
  session_token?: string;
  region?: string;
  bucket?: string;
  prefix?: string;
  endpoint_url?: string;
}

export interface ProjectSettings {
  fps: number;
  skip_seconds: number;
  url_expiry_seconds: number;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  created_at: string;
  updated_at: string;
  storage: StoragePublic;
  label_schema: LabelSchema;
  settings: ProjectSettings;
  last_sync: SyncInfo | null;
  stats: { completed: number; in_progress: number; total_events: number };
}

export interface ProjectUpdate {
  name?: string;
  description?: string;
  storage?: StorageUpdate;
  label_schema?: LabelSchema;
  settings?: ProjectSettings;
}

export type VideoStatus = "not_started" | "in_progress" | "completed";

export interface VideoItem {
  key: string;
  filename: string;
  size: number | null;
  last_modified: string | null;
  status: VideoStatus;
  event_count: number;
  annotated_at: string | null;
  annotated_by: string | null;
  missing: boolean;
}

/** Result of the latest bucket listing. */
export interface SyncInfo {
  video_count: number;
  synced_at: string;
  /** Videos uploaded since the previous sync; null on the first sync of a bucket/folder. */
  new_count: number | null;
  total_bytes: number | null;
  truncated: boolean;
}

export interface VideoList {
  videos: VideoItem[];
  truncated: boolean;
  bucket: string;
  prefix: string;
  sync: SyncInfo;
}

export interface VideoDetails {
  key: string;
  filename: string;
  folder: string;
  extension: string;
  bucket: string;
  region: string;
  s3_uri: string;
  console_url: string | null;
  size: number | null;
  content_type: string | null;
  last_modified: string | null;
  etag: string | null;
  storage_class: string | null;
  user_metadata: Record<string, string>;
  s3_error: string | null;
  status: VideoStatus;
  event_count: number;
  annotated_at: string | null;
  annotated_by: string | null;
  streaming_url: string | null;
  duration_seconds: number | null;
}

export interface ClearResult {
  key: string;
  cleared: boolean;
}

/** Someone with a video open (heartbeats from the annotation view). */
export interface Presence {
  user_id: string;
  name: string;
  video_key: string | null;
  seen_at: string;
}

export interface VideoActivity {
  status: VideoStatus;
  event_count: number;
  annotated_at: string;
  annotated_by: string | null;
  revision: number;
}

/** Saved status per annotated video and who is on which video; polled while annotating. */
export interface ProjectActivity {
  me: string;
  videos: Record<string, VideoActivity>;
  presence: Presence[];
}

export interface StreamUrl {
  key: string;
  url: string;
  expires_at: string;
}

export interface AnnotationEvent {
  id: string;
  timestamp: number;
  time?: string;
  frame: number | null;
  event_name: string | null;
  checkboxes: Record<string, boolean>;
  attributes: Record<string, AttributeValue>;
  note: string;
  created_at?: string | null;
  updated_at?: string | null;
}

export interface VideoAnnotation {
  video_key: string;
  video_filename: string;
  s3_uri: string;
  streaming_url: string | null;
  streaming_url_expires_at: string | null;
  status: "in_progress" | "completed";
  duration_seconds: number | null;
  fps: number | null;
  event_count: number;
  events: AnnotationEvent[];
  labels: Record<string, LabelValue>;
  created_at: string;
  updated_at: string;
  /** Number of saves; sent back as base_revision so a stale save is refused. */
  revision: number;
  updated_by: string | null;
}

export interface AnnotationSave {
  /** The revision the edits started from (0: nothing saved yet). */
  base_revision: number;
  status: "in_progress" | "completed";
  events: AnnotationEvent[];
  labels: Record<string, LabelValue>;
  streaming_url?: string | null;
  streaming_url_expires_at?: string | null;
  duration_seconds?: number | null;
}

export interface ConnectionTestResult {
  ok: boolean;
  bucket: string;
  region: string;
  prefix: string;
  video_count: number;
  sample_keys: string[];
  truncated: boolean;
}

export interface ExportResult {
  filename: string;
  export_id: number;
  video_count: number;
  event_count: number;
  warnings: string[];
  data: unknown;
}
