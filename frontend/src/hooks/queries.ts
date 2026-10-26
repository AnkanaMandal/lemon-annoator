"use client";

import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import { api } from "@/lib/api";
import type {
  AnnotationSave,
  Project,
  ProjectActivity,
  ProjectUpdate,
  VideoActivity,
  VideoAnnotation,
  VideoItem,
  VideoList,
} from "@/lib/types";

export const keys = {
  projects: ["projects"] as const,
  project: (id: string) => ["projects", id] as const,
  videos: (id: string) => ["projects", id, "videos"] as const,
  streamUrl: (id: string, key: string) => ["projects", id, "stream-url", key] as const,
  annotation: (id: string, key: string) => ["projects", id, "annotation", key] as const,
  details: (id: string, key: string) => ["projects", id, "details", key] as const,
  activity: (id: string) => ["projects", id, "activity"] as const,
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

/** Refetched whenever a video is opened, so edits start from what the other person last saved. */
export function useAnnotation(id: string, key: string | null) {
  return useQuery({
    queryKey: keys.annotation(id, key ?? ""),
    queryFn: () => api.getAnnotation(id, key!),
    enabled: Boolean(key),
    staleTime: 0,
  });
}

const ACTIVITY_POLL_MS = 15_000;

/**
 * Polls what others are doing in the project: saved status per video, and who has which video
 * open. Each poll is also this user's heartbeat for the video they have open (`activeKey`).
 */
export function useActivity(id: string, activeKey: string | null) {
  const qc = useQueryClient();
  const keyRef = useRef(activeKey);
  useEffect(() => {
    keyRef.current = activeKey;
  });
  const query = useQuery({
    queryKey: keys.activity(id),
    queryFn: () => api.presence(id, keyRef.current),
    staleTime: 0,
    refetchInterval: ACTIVITY_POLL_MS,
    refetchIntervalInBackground: true,
    refetchOnWindowFocus: true,
    retry: false, // the next poll is the retry
  });
  // Announce a video switch right away rather than at the next poll.
  useEffect(() => {
    void qc.refetchQueries({ queryKey: keys.activity(id), exact: true });
  }, [activeKey, id, qc]);
  // Leaving the annotation view: no longer on any video.
  useEffect(() => () => void api.presence(id, null).catch(() => {}), [id]);
  return query;
}

/** The queue with the latest saved status from activity polling (which may come from someone else). */
export function withActivity(videos: VideoItem[], activity: Record<string, VideoActivity> | undefined): VideoItem[] {
  if (!activity) return videos;
  return videos.flatMap((v) => {
    const a = activity[v.key];
    if (a) {
      return [
        {
          ...v,
          status: a.status,
          event_count: a.event_count,
          annotated_at: a.annotated_at,
          annotated_by: a.annotated_by,
        },
      ];
    }
    if (v.missing) return []; // its annotations were all that kept it in the queue, and they were cleared
    if (v.status === "not_started") return [v];
    return [{ ...v, status: "not_started" as const, event_count: 0, annotated_at: null, annotated_by: null }];
  });
}

export function useSaveAnnotation(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ key, body }: { key: string; body: AnnotationSave }) => api.saveAnnotation(id, key, body),
    onSuccess: (saved: VideoAnnotation, { key }) => {
      qc.setQueryData(keys.annotation(id, key), saved);
      qc.removeQueries({ queryKey: keys.details(id, key) });
      const status = {
        status: saved.status,
        event_count: saved.events.length,
        annotated_at: saved.updated_at,
        annotated_by: saved.updated_by,
      };
      qc.setQueryData<VideoList>(keys.videos(id), (prev) =>
        prev ? { ...prev, videos: prev.videos.map((v) => (v.key === key ? { ...v, ...status } : v)) } : prev,
      );
      qc.setQueryData<ProjectActivity>(keys.activity(id), (prev) =>
        prev
          ? { ...prev, videos: { ...prev.videos, [key]: { ...status, revision: saved.revision } as VideoActivity } }
          : prev,
      );
      qc.invalidateQueries({ queryKey: keys.projects, exact: true });
    },
  });
}
