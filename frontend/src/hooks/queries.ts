"use client";

import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "@/lib/api";
import type { AnnotationSave, Project, ProjectUpdate, VideoAnnotation, VideoList } from "@/lib/types";

export const keys = {
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  videos: (id: string) => ["projects", id, "videos"] as const,
  streamUrl: (id: string, key: string) => ["projects", id, "stream-url", key] as const,
  annotation: (id: string, key: string) => ["projects", id, "annotation", key] as const,
  details: (id: string, key: string) => ["projects", id, "details", key] as const,
};

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: api.listProjects });
}

export function useProject(id: string) {
  return useQuery({ queryKey: keys.project(id), queryFn: () => api.getProject(id) });
}

export function useUpdateProject(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: ProjectUpdate) => api.updateProject(id, body),
    onSuccess: (project: Project, body) => {
      qc.setQueryData(keys.project(id), project);
      qc.invalidateQueries({ queryKey: keys.projects, exact: true });
      if (body.storage || body.settings) qc.invalidateQueries({ queryKey: keys.videos(id) });
      if (body.storage) {
        // Presigned URLs and object details were made for the old bucket / credentials.
        qc.removeQueries({ queryKey: ["projects", id, "stream-url"] });
        qc.removeQueries({ queryKey: ["projects", id, "details"] });
      }
    },
  });
}

/** Every listing is a sync on the server; mirror its result into the project so Settings and the
 * dashboard show the same numbers as the queue. */
function applySync(qc: QueryClient, id: string, list: VideoList) {
  qc.setQueryData<Project>(keys.project(id), (p) => (p ? { ...p, last_sync: list.sync } : p));
  qc.invalidateQueries({ queryKey: keys.projects, exact: true });
}

export function useVideos(id: string, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: keys.videos(id),
    queryFn: async () => {
      const list = await api.listVideos(id);
      applySync(qc, id, list);
      return list;
    },
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** "Sync storage": re-read the bucket now and refresh the queue with the result. */
export function useSyncStorage(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.syncStorage(id),
    onSuccess: (list) => {
      qc.setQueryData(keys.videos(id), list);
      applySync(qc, id, list);
    },
  });
}

/**
 * Presigned URLs never refetch on their own: swapping src mid-playback would stutter.
 * They are refreshed when playback fails (expired) or dropped before reuse when close to expiry.
 */
export function streamUrlQuery(id: string, key: string) {
  return {
    queryKey: keys.streamUrl(id, key),
    queryFn: () => api.streamUrl(id, key),
    staleTime: Infinity,
    gcTime: 15 * 60_000,
  };
}

export function useStreamUrl(id: string, key: string | null) {
  return useQuery({ ...streamUrlQuery(id, key ?? ""), enabled: Boolean(key) });
}

export function useAnnotation(id: string, key: string | null) {
  return useQuery({
    queryKey: keys.annotation(id, key ?? ""),
    queryFn: () => api.getAnnotation(id, key!),
    enabled: Boolean(key),
    staleTime: Infinity,
  });
}

export function useSaveAnnotation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: string; body: AnnotationSave }) => api.saveAnnotation(id, key, body),
    onSuccess: (saved: VideoAnnotation, { key }) => {
      qc.setQueryData(keys.annotation(id, key), saved);
      qc.removeQueries({ queryKey: keys.details(id, key) });
      qc.setQueryData<VideoList>(keys.videos(id), (prev) =>
        prev
          ? {
              ...prev,
              videos: prev.videos.map((v) =>
                v.key === key
                  ? { ...v, status: saved.status, event_count: saved.events.length, annotated_at: saved.updated_at }
                  : v,
              ),
            }
          : prev,
      );
      qc.invalidateQueries({ queryKey: keys.projects, exact: true });
    },
  });
}
