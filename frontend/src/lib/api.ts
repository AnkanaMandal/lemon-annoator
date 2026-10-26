import type {
  AnnotationSave,
  ClearResult,
  ConnectionTestResult,
  ExportResult,
  Project,
  ProjectActivity,
  ProjectUpdate,
  StorageUpdate,
  StreamUrl,
  VideoAnnotation,
  VideoDetails,
  VideoList,
} from "./types";
import { accessToken, signOut } from "./supabase";

/** The Lemon API (Render) in production. Empty in local development: /api is proxied by Next.js. */
const API_URL = (process.env.NEXT_PUBLIC_API_URL ?? "").replace(/\/$/, "");

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code: string = "UNKNOWN",
    public hint: string | null = null,
    public details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }
}

const UNREACHABLE_HINT = API_URL
  ? "If the API runs on Render's free plan it can take a minute to wake up; try again shortly."
  : "Make sure the backend is running (npm run dev from the repo root).";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await accessToken();
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...init?.headers,
      },
    });
  } catch {
    throw new ApiError("Cannot reach the Lemon API.", 0, "API_UNREACHABLE", UNREACHABLE_HINT);
  }

  if (res.ok) {
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : null) as T;
  }

  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON error (e.g. proxy failure) */
  }
  const err = (
    body as { error?: { code?: string; message?: string; hint?: string; details?: Record<string, unknown> } }
  )?.error;
  if (err?.message) {
    // The session is no longer valid: back to the sign-in screen.
    if (err.code === "UNAUTHORIZED") void signOut();
    throw new ApiError(err.message, res.status, err.code, err.hint ?? null, err.details ?? {});
  }
  if (res.status === 500 || res.status === 502 || res.status === 503 || res.status === 504) {
    // A proxy (Next.js locally, Render while starting) answers without a JSON body when FastAPI is down.
    throw new ApiError("The Lemon API did not respond.", res.status, "API_UNREACHABLE", UNREACHABLE_HINT);
  }
  throw new ApiError(`Request failed (${res.status})`, res.status);
}

const q = (key: string) => `key=${encodeURIComponent(key)}`;
const json = (body: unknown) => JSON.stringify(body);

export const api = {
  listProjects: () => request<Project[]>("/api/projects"),
  getProject: (id: string) => request<Project>(`/api/projects/${id}`),
  createProject: (body: { name: string; description?: string }) =>
    request<Project>("/api/projects", { method: "POST", body: json(body) }),
  updateProject: (id: string, body: ProjectUpdate) =>
    request<Project>(`/api/projects/${id}`, { method: "PATCH", body: json(body) }),
  deleteProject: (id: string) =>
    request<{ ok: boolean; deleted_at: string }>(`/api/projects/${id}`, { method: "DELETE" }),
  testStorage: (id: string, storage?: StorageUpdate) =>
    request<ConnectionTestResult>(`/api/projects/${id}/storage/test`, {
      method: "POST",
      body: storage ? json(storage) : undefined,
    }),

  listVideos: (id: string) => request<VideoList>(`/api/projects/${id}/videos`),
  syncStorage: (id: string) => request<VideoList>(`/api/projects/${id}/sync`, { method: "POST" }),
  streamUrl: (id: string, key: string) => request<StreamUrl>(`/api/projects/${id}/videos/stream-url?${q(key)}`),
  videoDetails: (id: string, key: string) => request<VideoDetails>(`/api/projects/${id}/videos/details?${q(key)}`),
  clearAnnotation: (id: string, key: string) =>
    request<ClearResult>(`/api/projects/${id}/annotations?${q(key)}`, { method: "DELETE" }),
  getAnnotation: (id: string, key: string) =>
    request<VideoAnnotation | null>(`/api/projects/${id}/annotations?${q(key)}`),
  saveAnnotation: (id: string, key: string, body: AnnotationSave) =>
    request<VideoAnnotation>(`/api/projects/${id}/annotations?${q(key)}`, {
      method: "PUT",
      body: json(body),
    }),
  exportProject: (id: string) => request<ExportResult>(`/api/projects/${id}/export`, { method: "POST" }),
  activity: (id: string) => request<ProjectActivity>(`/api/projects/${id}/activity`),
  /** "I have this video open" (null: none); returns the latest activity. */
  presence: (id: string, key: string | null) =>
    request<ProjectActivity>(`/api/projects/${id}/presence`, { method: "PUT", body: json({ key }) }),
};

export const isConflict = (error: unknown): error is ApiError =>
  error instanceof ApiError && error.code === "ANNOTATION_CONFLICT";

export function errorMessage(error: unknown): { title: string; hint: string | null } {
  if (error instanceof ApiError) return { title: error.message, hint: error.hint };
  if (error instanceof Error) return { title: error.message, hint: null };
  return { title: "Something went wrong", hint: null };
}
