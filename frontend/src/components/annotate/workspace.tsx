"use client";

import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  CloudOff,
  ExternalLink,
  FolderSearch,
  Keyboard,
  Settings2,
  Users,
} from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { toast } from "sonner";

import { ClearAnnotationsDialog } from "@/components/annotate/clear-annotations-dialog";
import { EventList, LabelsSummary } from "@/components/annotate/event-list";
import { QueueRail, TagRail } from "@/components/annotate/panel-rails";
import { ShortcutsDialog } from "@/components/annotate/shortcuts-dialog";
import { type PanelPrefs, TaggingPanel } from "@/components/annotate/tagging-panel";
import { VideoDetailsDialog } from "@/components/annotate/video-details-dialog";
import { VideoQueue } from "@/components/annotate/video-queue";
import { type PlayerHandle, VideoPlayer } from "@/components/annotate/video-player";
import { ErrorState } from "@/components/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useHotkeys } from "@/hooks/use-hotkeys";
import { useHydrated } from "@/hooks/use-hydrated";
import {
  keys,
  streamUrlQuery,
  useActivity,
  useAnnotation,
  useProject,
  useSaveAnnotation,
  useStreamUrl,
  useVideos,
  withActivity,
} from "@/hooks/queries";
import { api, errorMessage, isConflict } from "@/lib/api";
import { eventColor } from "@/lib/colors";
import { formatTime, frameAt, newId } from "@/lib/format";
import { pendingSave } from "@/lib/pending-save";
import {
  type DraftValues,
  emptyDraft,
  hotkeyTargets,
  missingRequired,
  draftHasValues,
  draftValue,
  hasEventSection,
  missingRequiredLabels,
  reconcileDraft,
  setDraftValue,
  toggledValue,
  withLabelDefaults,
} from "@/lib/schema";
import { createTimeStore } from "@/lib/time-store";
import type {
  AnnotationEvent,
  LabelValue,
  Project,
  ProjectActivity,
  StreamUrl,
  VideoAnnotation,
  VideoItem,
  VideoList,
} from "@/lib/types";
import { cn } from "@/lib/utils";

/* -------------------------------------------------------------------------- */
/* Gate: project → storage → video list                                       */
/* -------------------------------------------------------------------------- */

export function AnnotateWorkspace() {
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const hydrated = useHydrated();
  const projectQ = useProject(projectId);
  // Render data only after hydration so the first client render matches the server HTML.
  const project = hydrated ? projectQ.data : undefined;
  const configured = Boolean(project?.storage.is_configured);
  const videosQ = useVideos(projectId, configured);
  const list = videosQ.data;

  // Once the workspace has been shown it stays mounted: replacing it with an error or empty screen
  // because a background refresh failed would throw away unsaved events.
  const [workspaceShown, setWorkspaceShown] = useState(false);
  if (list && list.videos.length > 0 && !workspaceShown) setWorkspaceShown(true);

  // A failed refresh while data is on screen is reported, not rendered as a full-page error.
  useEffect(() => {
    if (!videosQ.errorUpdatedAt || !videosQ.data || !videosQ.error) return;
    const { title, hint } = errorMessage(videosQ.error);
    toast.error(`Couldn't refresh the queue: ${title}`, { description: hint ?? undefined });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per failed refresh
  }, [videosQ.errorUpdatedAt]);

  if (!hydrated || projectQ.isPending) return <WorkspaceSkeleton />;
  if (!project) return <ErrorState className="h-full" error={projectQ.error} onRetry={() => projectQ.refetch()} />;

  const settingsLink = (
    <Button asChild size="sm" variant="outline">
      <Link href={`/projects/${projectId}/settings`}>
        <Settings2 /> Open settings
      </Link>
    </Button>
  );

  if (!configured && !workspaceShown) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <CloudOff />
          </EmptyMedia>
          <EmptyTitle>Connect your S3 bucket</EmptyTitle>
          <EmptyDescription>Add your bucket, folder prefix and credentials to load the video queue.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button asChild>
            <Link href={`/projects/${projectId}/settings`}>
              <Settings2 /> Configure storage
            </Link>
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  if (!list) {
    if (videosQ.error)
      return (
        <ErrorState className="h-full" error={videosQ.error} onRetry={() => videosQ.refetch()} action={settingsLink} />
      );
    return <WorkspaceSkeleton />;
  }
  if (list.videos.length === 0 && !workspaceShown) {
    return (
      <Empty className="h-full">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FolderSearch />
          </EmptyMedia>
          <EmptyTitle>No videos found</EmptyTitle>
          <EmptyDescription>
            No .mp4 or .mov files under{" "}
            <code className="font-mono">
              s3://{list.bucket}/{list.prefix}
            </code>
            .
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          <Button size="sm" variant="outline" onClick={() => videosQ.refetch()} disabled={videosQ.isFetching}>
            {videosQ.isFetching && <Spinner />} Re-scan
          </Button>
          {settingsLink}
        </EmptyContent>
      </Empty>
    );
  }

  return (
    <Workspace
      project={project}
      list={list}
      refreshing={videosQ.isFetching}
      onRefresh={() => videosQ.refetch()}
      initialKey={searchParams.get("v")}
    />
  );
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

const sortEvents = (evs: AnnotationEvent[]) =>
  [...evs].sort((a, b) => a.timestamp - b.timestamp || a.id.localeCompare(b.id));

const round3 = (n: number) => Math.round(n * 1000) / 1000;

/** Next video that still needs work and nobody else has open, searching forward from `current` and wrapping. */
function findNextTodo(videos: VideoItem[], current: string | null, busy: Map<string, string[]>): string | null {
  const i = videos.findIndex((v) => v.key === current);
  const order = [...videos.slice(i + 1), ...videos.slice(0, Math.max(i, 0))];
  return order.find((v) => v.status !== "completed" && !v.missing && !busy.has(v.key))?.key ?? null;
}

/** Video key -> names of the other people who have it open. */
function othersByVideo(activity: ProjectActivity | undefined): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const p of activity?.presence ?? []) {
    if (p.user_id === activity!.me || !p.video_key) continue;
    map.set(p.video_key, [...(map.get(p.video_key) ?? []), p.name]);
  }
  return map;
}

const joinNames = (names: string[]) =>
  names.length <= 2 ? names.join(" and ") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;

const lastVideoKey = (projectId: string) => `lemon.last-video.${projectId}`;

function readLastVideo(projectId: string): string | null {
  try {
    return localStorage.getItem(lastVideoKey(projectId));
  } catch {
    return null;
  }
}

/** Autosave this long after the last change. */
const AUTOSAVE_MS = 1200;

function pickInitial(videos: VideoItem[], requested: string | null): string | null {
  if (requested && videos.some((v) => v.key === requested)) return requested;
  return videos.find((v) => v.status !== "completed" && !v.missing)?.key ?? videos[0]?.key ?? null;
}

function describeMediaError(err: MediaError | null): string {
  switch (err?.code) {
    case MediaError.MEDIA_ERR_NETWORK:
      return "A network error interrupted streaming from S3.";
    case MediaError.MEDIA_ERR_DECODE:
      return "The video could not be decoded. It may be corrupt or use a codec your browser can't play.";
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return "This browser can't play this file. MP4/MOV must be encoded with H.264 (HEVC/H.265 and ProRes won't play in most browsers), or S3 refused access to the object.";
    default:
      return "Playback failed.";
  }
}

/* Workspace preferences persisted per browser: tagging behaviour + which side panels are open. */
interface WorkspacePrefs extends PanelPrefs {
  queueOpen: boolean;
  panelOpen: boolean;
}
const PREFS_KEY = "lemon.workspace-prefs";
const DEFAULT_PREFS: WorkspacePrefs = { pauseOnCapture: false, keepValues: false, queueOpen: true, panelOpen: true };
const prefListeners = new Set<() => void>();
let prefCache: WorkspacePrefs | null = null;
const prefsStore = {
  read(): WorkspacePrefs {
    if (prefCache) return prefCache;
    try {
      prefCache = { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
    } catch {
      prefCache = DEFAULT_PREFS;
    }
    return prefCache!;
  },
  write(p: WorkspacePrefs) {
    prefCache = p;
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(p));
    } catch {
      /* private mode */
    }
    prefListeners.forEach((l) => l());
  },
  subscribe(fn: () => void) {
    prefListeners.add(fn);
    return () => prefListeners.delete(fn);
  },
};

/* -------------------------------------------------------------------------- */
/* Workspace                                                                  */
/* -------------------------------------------------------------------------- */

function Workspace({
  project,
  list,
  refreshing,
  onRefresh,
  initialKey,
}: {
  project: Project;
  list: VideoList;
  refreshing: boolean;
  onRefresh: () => void;
  initialKey: string | null;
}) {
  const qc = useQueryClient();
  const projectId = project.id;
  const schema = project.label_schema;
  const { fps, skip_seconds: skipSeconds } = project.settings;

  const playerRef = useRef<PlayerHandle>(null);
  const [timeStore] = useState(createTimeStore);
  const prefs = useSyncExternalStore(prefsStore.subscribe, prefsStore.read, () => DEFAULT_PREFS);

  const [activeKey, setActiveKey] = useState<string | null>(() =>
    pickInitial(list.videos, initialKey ?? readLastVideo(project.id)),
  );
  const activeKeyRef = useRef(activeKey);
  useEffect(() => {
    activeKeyRef.current = activeKey;
  }, [activeKey]);

  // The other person's saves and whereabouts, polled (also announces which video this user has open).
  const activityQ = useActivity(projectId, activeKey);
  const videos = useMemo(
    () => withActivity(list.videos, activityQ.data?.videos),
    [list.videos, activityQ.data?.videos],
  );
  const othersOn = useMemo(() => othersByVideo(activityQ.data), [activityQ.data]);
  const othersHere = activeKey ? (othersOn.get(activeKey) ?? []) : [];

  const urlQ = useStreamUrl(projectId, activeKey);
  const annQ = useAnnotation(projectId, activeKey);
  const saveMut = useSaveAnnotation(projectId);

  // Local, editable copy of the active video's events.
  const [events, setEvents] = useState<AnnotationEvent[]>([]);
  // Whole-video answers, saved with the video (as opposed to per-timestamp events).
  const [labels, setLabels] = useState<Record<string, LabelValue>>({});
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const versionRef = useRef(0);
  /** versionRef value covered by the last successful save (nothing newer to write when equal). */
  const savedVersionRef = useRef(0);
  /** Server revision these edits are based on; a save from an older one is refused (conflict). */
  const baseRevisionRef = useRef(0);
  const [adopted, setAdopted] = useState<{ revision: number } | null>(null);
  useEffect(() => {
    if (adopted) baseRevisionRef.current = adopted.revision;
  }, [adopted]);
  /** Someone else saved (or cleared) this video since it was opened; saving waits for a choice. */
  const [conflict, setConflict] = useState<{ message: string; revision: number } | null>(null);

  const [draft, setDraft] = useState<DraftValues>(() => emptyDraft(schema));
  const [draftSchema, setDraftSchema] = useState(schema);
  if (draftSchema !== schema) {
    // The schema was edited in Settings: drop values for removed fields / event types.
    setDraftSchema(schema);
    setDraft((d) => reconcileDraft(d, schema));
  }
  const [editingId, setEditingId] = useState<string | null>(null);
  const [preEditDraft, setPreEditDraft] = useState<DraftValues | null>(null);
  const [flashId, setFlashId] = useState<string | null>(null);
  const [showShortcuts, setShowShortcuts] = useState(false);
  const [showRequired, setShowRequired] = useState(false);
  const [showRequiredLabels, setShowRequiredLabels] = useState(false);
  const [detailsVideo, setDetailsVideo] = useState<VideoItem | null>(null);
  const [clearVideo, setClearVideo] = useState<VideoItem | null>(null);
  const [mediaError, setMediaError] = useState<string | null>(null);
  const lastRefresh = useRef<{ key: string; at: number } | null>(null);

  // Adopt server data once per video switch (derived-state pattern, no effect needed). Wait for the
  // refetch to finish so a cached copy never becomes the base of new edits.
  if (activeKey && annQ.isSuccess && annQ.fetchStatus === "idle" && loadedKey !== activeKey) {
    setLoadedKey(activeKey);
    setAdopted({ revision: annQ.data?.revision ?? 0 });
    setConflict(null);
    setEvents(sortEvents(annQ.data?.events ?? []));
    setLabels(withLabelDefaults(schema, annQ.data?.labels));
    setDirty(false);
    setShowRequiredLabels(false);
    setEditingId(null);
    setPreEditDraft(null);
  }
  const ready = Boolean(activeKey) && loadedKey === activeKey;
  const activeVideo = videos.find((v) => v.key === activeKey) ?? null;
  const editingIndex = editingId ? events.findIndex((e) => e.id === editingId) : -1;
  const editing = editingIndex >= 0 ? { event: events[editingIndex], index: editingIndex } : null;

  const mutateEvents = (fn: (prev: AnnotationEvent[]) => AnnotationEvent[]) => {
    setEvents((prev) => sortEvents(fn(prev)));
    setDirty(true);
    versionRef.current++;
  };

  const changeLabels = (next: Record<string, LabelValue>) => {
    setLabels(next);
    setDirty(true);
    versionRef.current++;
  };
  const withEvents = hasEventSection(schema);

  /* ------------------------------ switching ------------------------------ */

  const doSwitch = (key: string) => {
    // Drop a cached presigned URL that is about to expire rather than flash an old one.
    const cached = qc.getQueryData<StreamUrl>(keys.streamUrl(projectId, key));
    if (cached && new Date(cached.expires_at).getTime() - Date.now() < 3 * 60_000) {
      qc.removeQueries({ queryKey: keys.streamUrl(projectId, key) });
    }
    setActiveKey(key);
    setLoadedKey(null);
    setEvents([]);
    setLabels({});
    setShowRequiredLabels(false);
    setEditingId(null);
    setPreEditDraft(null);
    setMediaError(null);
    setDirty(false);
    setConflict(null);
    setShowRequired(false);
    if (!prefs.keepValues) setDraft(emptyDraft(schema));
    window.history.replaceState(null, "", `?v=${encodeURIComponent(key)}`);
  };

  /** Switching never discards work: pending changes are saved first (and stay put if that fails). */
  const requestSwitch = async (key: string) => {
    if (key === activeKey) return;
    if (dirty && ready) {
      try {
        await save("save");
      } catch {
        return; // the error toast is already shown; stay on this video
      }
    }
    doSwitch(key);
  };

  const goRelative = (dir: 1 | -1) => {
    const i = videos.findIndex((v) => v.key === activeKey);
    const next = videos[i + dir];
    if (next) requestSwitch(next.key);
  };

  // Warm up the next video's stream so Save & Next is quick. (Its annotations are always refetched.)
  useEffect(() => {
    const next = findNextTodo(videos, activeKey, othersOn);
    if (next) qc.prefetchQuery(streamUrlQuery(projectId, next));
  }, [activeKey, videos, othersOn, projectId, qc]);

  /* -------------------------------- saving ------------------------------- */

  const saveChain = useRef<Promise<unknown>>(Promise.resolve());
  /** Saves run one after another, in the order they were requested. */
  const save = (mode: "save" | "complete") => {
    const run = saveChain.current.then(
      () => saveNow(mode),
      () => saveNow(mode),
    );
    saveChain.current = run.catch(() => {});
    return run;
  };

  const saveNow = async (mode: "save" | "complete") => {
    const key = activeKeyRef.current;
    if (!key || loadedKey !== key) return null;
    const version = versionRef.current;
    // Plain saves with nothing new are skipped (autosave may fire after an explicit save).
    if (mode === "save" && version === savedVersionRef.current) return null;
    // Status from the latest saved copy, never a stale render: a queued autosave must not demote
    // a video that Save & Next just marked completed.
    const previous = qc.getQueryData<VideoAnnotation | null>(keys.annotation(projectId, key))?.status;
    const status = mode === "complete" || previous === "completed" ? "completed" : "in_progress";
    const url = urlQ.data?.key === key ? urlQ.data : undefined;
    try {
      const saved = await saveMut.mutateAsync({
        key,
        body: {
          base_revision: baseRevisionRef.current,
          status,
          events,
          labels,
          streaming_url: url?.url ?? null,
          streaming_url_expires_at: url?.expires_at ?? null,
          duration_seconds: playerRef.current?.getDuration() || null,
        },
      });
      if (activeKeyRef.current === key) baseRevisionRef.current = saved.revision;
      // Only mark clean if nothing changed while the request was in flight.
      savedVersionRef.current = Math.max(savedVersionRef.current, version);
      if (versionRef.current === version && activeKeyRef.current === key) {
        setEvents(sortEvents(saved.events));
        setLabels(withLabelDefaults(schema, saved.labels));
        setDirty(false);
        // Directly, not via the effect: effects don't run while this view is hidden, and a stale
        // registration would make the browser warn about work that is already saved.
        pendingSave.register(projectId, null);
      }
      return saved;
    } catch (err) {
      const { title, hint } = errorMessage(err);
      if (isConflict(err) && activeKeyRef.current === key) {
        setConflict({ message: title, revision: Number(err.details.revision ?? 0) });
        toast.error(title, { description: "Not saved. Choose which version to keep above the player." });
      } else {
        toast.error(`Save failed: ${title}`, { description: hint ?? undefined });
      }
      throw err;
    }
  };

  /** Drop local edits and load what is saved now (after a conflict, or when someone else saved). */
  const reloadFromServer = () => {
    const key = activeKeyRef.current;
    if (!key) return;
    setConflict(null);
    setDirty(false);
    savedVersionRef.current = versionRef.current;
    pendingSave.register(projectId, null);
    setLoadedKey(null);
    void qc.resetQueries({ queryKey: keys.annotation(projectId, key), exact: true });
  };

  /** Resolve a conflict by saving these edits over the newer version. */
  const keepMine = () => {
    if (!conflict) return;
    baseRevisionRef.current = conflict.revision;
    setConflict(null);
    save("save")
      .then(() => toast.success("Saved your version"))
      .catch(() => {});
  };

  const saveOnly = () => {
    if (!ready) return;
    save("save")
      .then((s) =>
        s
          ? toast.success("Saved", { description: s.video_filename })
          : toast.success("Already saved", { description: "Changes are saved automatically.", duration: 1500 }),
      )
      .catch(() => {});
  };

  const saveAndNext = async () => {
    if (!ready) return;
    const missingLabels = missingRequiredLabels(schema, labels);
    if (missingLabels.length) {
      setShowRequiredLabels(true);
      toast.error(`Fill in required field${missingLabels.length === 1 ? "" : "s"} first`, {
        description: missingLabels.map((f) => f.label).join(", "),
      });
      return;
    }
    // Per-timestamp selections only count once captured. Don't let them vanish silently.
    if (withEvents && !editingId && events.length === 0 && draftHasValues(draft, schema)) {
      toast.error("These timestamp values haven't been captured yet", {
        description: "Press Enter (Capture) to record them at the current time, or discard them.",
        action: { label: "Discard", onClick: () => setDraft(emptyDraft(schema)) },
      });
      return;
    }
    const current = activeKeyRef.current;
    const version = versionRef.current;
    try {
      const saved = await save("complete");
      if (!saved) return;
    } catch {
      return;
    }
    if (activeKeyRef.current !== current) return;
    if (versionRef.current !== version) {
      toast.info("Saved. You made changes while saving, so you're still on this video.");
      return;
    }
    const latest = withActivity(
      qc.getQueryData<VideoList>(keys.videos(projectId))?.videos ?? list.videos,
      qc.getQueryData<ProjectActivity>(keys.activity(projectId))?.videos,
    );
    const next = findNextTodo(latest, current, othersOn);
    if (next) {
      doSwitch(next);
      toast.success("Saved — next video", { duration: 1500 });
    } else {
      toast.success("All videos in this queue are completed", {
        description: "Use Export Project JSON to write the final file.",
      });
    }
  };

  // Autosave: write changes to disk shortly after the last edit, so work persists until it is
  // cleared on purpose. A ref keeps the timer from restarting on unrelated re-renders.
  const saveRef = useRef(save);
  const flushRef = useRef<() => void>(() => {});
  useEffect(() => {
    saveRef.current = save;
    flushRef.current = () => {
      if (dirty && ready && !conflict) save("save").catch(() => {});
    };
  });
  useEffect(() => {
    if (!dirty || !ready || conflict) return;
    const id = setTimeout(() => saveRef.current("save").catch(() => {}), AUTOSAVE_MS);
    return () => clearTimeout(id);
  }, [dirty, ready, conflict, events, labels]);

  // Someone else saved or cleared this video while it is open here with nothing unsaved: show their
  // version. (With unsaved edits, the next save reports a conflict instead.)
  const serverRevision = activeKey && activityQ.data ? (activityQ.data.videos[activeKey]?.revision ?? 0) : null;
  const serverEditor = activeKey ? activityQ.data?.videos[activeKey]?.annotated_by : null;
  useEffect(() => {
    if (serverRevision === null || !ready || dirty || conflict || editingId || saveMut.isPending) return;
    const base = baseRevisionRef.current;
    if (serverRevision > base || (serverRevision === 0 && base > 0)) {
      reloadFromServer();
      toast.info(
        serverRevision ? `${serverEditor ?? "Someone"} updated this video` : "This video's annotations were cleared",
        {
          description: "Showing the latest saved version.",
        },
      );
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- reacts to new server revisions only
  }, [serverRevision, ready, dirty, conflict, editingId, saveMut.isPending]);
  // Leaving the Annotate view (another tab of the app) or unmounting saves immediately.
  useEffect(() => () => flushRef.current(), []);

  // Remember where the user was, per project.
  useEffect(() => {
    if (!activeKey) return;
    try {
      localStorage.setItem(lastVideoKey(projectId), activeKey);
    } catch {
      /* private mode */
    }
  }, [activeKey, projectId]);

  // Export (header) saves pending edits first, and closing the tab warns about them. Registered
  // without a cleanup on purpose: it must stay active while this route is hidden behind Settings.
  useEffect(() => {
    pendingSave.register(projectId, dirty ? () => save("save") : null);
  });

  /* ------------------------------- events -------------------------------- */

  const fullValues = (d: DraftValues): DraftValues => {
    const r = reconcileDraft(d, schema);
    return { ...r, note: r.note.trim() };
  };

  /** True when every required field has a value; otherwise highlights them and explains why. */
  const requiredFilled = () => {
    const missing = missingRequired(schema, fullValues(draft));
    if (!missing.length) {
      setShowRequired(false);
      return true;
    }
    setShowRequired(true);
    toast.error(`Fill in required field${missing.length === 1 ? "" : "s"} first`, {
      description: missing.map((f) => f.label).join(", "),
    });
    return false;
  };

  const capture = () => {
    if (!ready || !urlQ.data || mediaError) {
      toast.error("Load a video before capturing timestamps.");
      return;
    }
    if (!requiredFilled()) return;
    const player = playerRef.current;
    if (!player) return;
    if (prefs.pauseOnCapture) player.pause();
    const t = player.getTime();
    const ev: AnnotationEvent = { id: newId(), timestamp: round3(t), frame: frameAt(t, fps), ...fullValues(draft) };
    mutateEvents((prev) => [...prev, ev]);
    setFlashId(ev.id);
    setDraft(prefs.keepValues ? { ...draft, note: "" } : emptyDraft(schema));
  };

  const startEdit = (ev: AnnotationEvent) => {
    if (!editingId) setPreEditDraft(draft);
    setEditingId(ev.id);
    setDraft({
      event_name: ev.event_name,
      checkboxes: { ...ev.checkboxes },
      attributes: { ...ev.attributes },
      note: ev.note,
    });
    playerRef.current?.pause();
    playerRef.current?.seek(ev.timestamp);
  };

  const exitEdit = () => {
    setEditingId(null);
    setShowRequired(false);
    setDraft(preEditDraft ?? emptyDraft(schema));
    setPreEditDraft(null);
  };

  const updateEvent = () => {
    if (!editingId || !requiredFilled()) return;
    const id = editingId;
    const values = fullValues(draft);
    // Merge over the stored event so values for fields no longer in the schema are kept.
    mutateEvents((prev) =>
      prev.map((e) =>
        e.id === id
          ? {
              ...e,
              event_name: values.event_name,
              note: values.note,
              checkboxes: { ...e.checkboxes, ...values.checkboxes },
              attributes: { ...e.attributes, ...values.attributes },
            }
          : e,
      ),
    );
    setFlashId(id);
    exitEdit();
  };

  const retime = () => {
    if (!editingId || !playerRef.current) return;
    const t = playerRef.current.getTime();
    const id = editingId;
    mutateEvents((prev) => prev.map((e) => (e.id === id ? { ...e, timestamp: round3(t), frame: frameAt(t, fps) } : e)));
    toast.success(`Moved to ${formatTime(t)}`, { duration: 1500 });
  };

  const deleteEvent = (ev: AnnotationEvent) => {
    const key = activeKey;
    mutateEvents((prev) => prev.filter((e) => e.id !== ev.id));
    if (editingId === ev.id) exitEdit();
    toast(`Deleted event at ${formatTime(ev.timestamp)}`, {
      action: {
        label: "Undo",
        onClick: () => {
          if (activeKeyRef.current !== key) toast.error("Switch back to that video to undo.");
          else mutateEvents((prev) => (prev.some((e) => e.id === ev.id) ? prev : [...prev, ev]));
        },
      },
    });
  };

  const seekTo = (ev: AnnotationEvent) => playerRef.current?.seek(ev.timestamp);

  /* ---------------------------- queue actions ---------------------------- */

  /** Opens the video in a new tab with a fresh presigned URL. */
  const openVideoInTab = async (video: VideoItem) => {
    // Open synchronously so the popup isn't blocked, then point it at the URL once signed.
    const win = window.open("", "_blank");
    try {
      const cached = qc.getQueryData<StreamUrl>(keys.streamUrl(projectId, video.key));
      if (cached && new Date(cached.expires_at).getTime() - Date.now() < 60_000) {
        qc.removeQueries({ queryKey: keys.streamUrl(projectId, video.key) });
      }
      const { url } = await qc.fetchQuery(streamUrlQuery(projectId, video.key));
      if (win) win.location.href = url;
      else window.open(url, "_blank", "noopener");
    } catch (err) {
      win?.close();
      const { title, hint } = errorMessage(err);
      toast.error(title, { description: hint ?? undefined });
    }
  };

  const clearAnnotations = async (video: VideoItem) => {
    if (saveMut.isPending) {
      toast.error("A save is in progress. Try again in a moment.");
      throw new Error("save in progress");
    }
    await qc.cancelQueries({ queryKey: keys.annotation(projectId, video.key) });
    let cleared = false;
    if (video.status !== "not_started" || video.event_count > 0) {
      try {
        cleared = (await api.clearAnnotation(projectId, video.key)).cleared;
      } catch (err) {
        const { title, hint } = errorMessage(err);
        toast.error(`Couldn't clear annotations: ${title}`, { description: hint ?? undefined });
        throw err;
      }
    }
    qc.setQueryData(keys.annotation(projectId, video.key), null);
    qc.removeQueries({ queryKey: keys.details(projectId, video.key) });
    qc.setQueryData<VideoList>(keys.videos(projectId), (prev) =>
      prev
        ? {
            ...prev,
            videos: prev.videos.flatMap((v) =>
              v.key !== video.key
                ? [v]
                : v.missing // annotations were all that kept a deleted video in the queue
                  ? []
                  : [{ ...v, status: "not_started" as const, event_count: 0, annotated_at: null }],
            ),
          }
        : prev,
    );
    qc.setQueryData<ProjectActivity>(keys.activity(projectId), (prev) => {
      if (!prev) return prev;
      const videos = { ...prev.videos };
      delete videos[video.key];
      return { ...prev, videos };
    });
    qc.invalidateQueries({ queryKey: keys.projects, exact: true });
    if (video.key === activeKeyRef.current) {
      setLabels(withLabelDefaults(schema, undefined));
      setEvents([]);
      setDirty(false);
      setConflict(null);
      baseRevisionRef.current = 0;
      pendingSave.register(projectId, null);
      setEditingId(null);
      setPreEditDraft(null);
      versionRef.current++;
    }
    toast.success(`Cleared annotations for ${video.filename}`, {
      description: cleared ? "A copy is kept in the database." : undefined,
    });
  };

  /* ------------------------------- layout -------------------------------- */

  const toggleQueue = () => prefsStore.write({ ...prefs, queueOpen: !prefs.queueOpen });
  const togglePanel = () => prefsStore.write({ ...prefs, panelOpen: !prefs.panelOpen });

  /* ----------------------------- media errors ---------------------------- */

  const onMediaError = useCallback(
    (err: MediaError | null) => {
      const key = activeKeyRef.current;
      if (!key) return;
      const last = lastRefresh.current;
      // Most failures mid-session are an expired presigned URL: fetch a fresh one once a minute.
      if (!last || last.key !== key || Date.now() - last.at > 60_000) {
        lastRefresh.current = { key, at: Date.now() };
        qc.invalidateQueries({ queryKey: keys.streamUrl(projectId, key) });
        return;
      }
      setMediaError(describeMediaError(err));
    },
    [qc, projectId],
  );

  const retryMedia = () => {
    setMediaError(null);
    lastRefresh.current = null;
    if (activeKey) qc.invalidateQueries({ queryKey: keys.streamUrl(projectId, activeKey) });
  };

  /* ------------------------------- hotkeys ------------------------------- */

  useHotkeys(
    (e) => {
      const p = playerRef.current;
      const mod = e.ctrlKey || e.metaKey;
      if (mod && e.key.toLowerCase() === "s") return void saveOnly();
      if (mod && e.key === "Enter") return void saveAndNext();
      if (e.key === "Escape") {
        if (editingId) exitEdit();
        (document.activeElement as HTMLElement | null)?.blur?.();
        return;
      }
      if (e.altKey && (e.key === "ArrowDown" || e.key === "ArrowUp")) return goRelative(e.key === "ArrowDown" ? 1 : -1);
      if (mod || e.altKey) return false;

      switch (e.key) {
        case " ":
        case "k":
        case "K":
          return p?.toggle();
        case "ArrowLeft":
          return e.shiftKey ? p?.seekBy(-1) : p?.stepFrames(-1);
        case "ArrowRight":
          return e.shiftKey ? p?.seekBy(1) : p?.stepFrames(1);
        case ",":
          return p?.stepFrames(-1);
        case ".":
          return p?.stepFrames(1);
        case "j":
        case "J":
          return p?.seekBy(-skipSeconds);
        case "l":
        case "L":
          return p?.seekBy(skipSeconds);
        case "[":
          return p?.changeSpeed(-1);
        case "]":
          return p?.changeSpeed(1);
        case "Enter":
        case "m":
        case "M":
          if (!withEvents) return false;
          return editingId ? updateEvent() : capture();
        case "Delete":
        case "Backspace":
          if (!editing) return false;
          return deleteEvent(editing.event);
        case "?":
          return setShowShortcuts(true);
        case "q":
        case "Q":
          return toggleQueue();
        case "t":
        case "T":
          return togglePanel();
      }

      const digit = /^(?:Digit|Numpad)(\d)$/.exec(e.code);
      if (digit) {
        const n = Number(digit[1]);
        if (e.shiftKey) {
          if (n === 0) return setDraft((d) => ({ ...d, event_name: null }));
          const type = schema.event_types[n - 1];
          if (type) return setDraft((d) => ({ ...d, event_name: type }));
          return;
        }
        const target = n > 0 ? hotkeyTargets(schema)[n - 1] : undefined;
        if (target?.field.scope === "video") {
          const { field, option } = target;
          return changeLabels({ ...labels, [field.key]: toggledValue(field, labels[field.key], option) });
        }
        if (target) {
          const { field, option } = target;
          return setDraft((d) => setDraftValue(d, field, toggledValue(field, draftValue(d, field), option)));
        }
        return;
      }
      return false;
    },
    {
      allowInInputs: (e) =>
        e.key === "Escape" || ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === "s" || e.key === "Enter")),
    },
  );

  /* -------------------------------- render ------------------------------- */

  const playerOverlay = urlQ.isPending ? (
    <div className="flex flex-col items-center gap-2 text-sm text-white/70">
      <Spinner className="size-6" /> Preparing secure stream…
    </div>
  ) : urlQ.error ? (
    <ErrorState error={urlQ.error} onRetry={() => urlQ.refetch()} className="text-white [&_p]:text-white/70" compact />
  ) : mediaError ? (
    <ErrorState
      error={new Error(mediaError)}
      onRetry={retryMedia}
      className="text-white [&_p]:text-white/70"
      compact
      action={
        urlQ.data && (
          <Button size="sm" variant="outline" asChild>
            <a href={urlQ.data.url} target="_blank" rel="noreferrer">
              <ExternalLink /> Open file
            </a>
          </Button>
        )
      }
    />
  ) : null;

  const status = annQ.data?.status ?? "not_started";
  const completedCount = videos.filter((v) => v.status === "completed").length;
  const columns = `${prefs.queueOpen ? "20rem" : "3.25rem"} minmax(0,1fr) ${prefs.panelOpen ? "21rem" : "3.25rem"}`;

  return (
    <div
      style={{ "--ws-cols": columns } as React.CSSProperties}
      className="flex h-full flex-col overflow-y-auto lg:grid lg:[grid-template-columns:var(--ws-cols)] lg:overflow-hidden lg:transition-[grid-template-columns] lg:duration-200 lg:ease-out"
    >
      <aside className="flex max-h-80 min-h-0 shrink-0 flex-col border-b lg:max-h-none lg:border-b-0">
        {/* Kept mounted while collapsed so the search / filter survive. Always shown on small screens. */}
        <div className={cn("flex min-h-0 flex-1 flex-col lg:border-r", !prefs.queueOpen && "lg:hidden")}>
          <VideoQueue
            videos={videos}
            prefix={list.prefix}
            activeKey={activeKey}
            activeDirty={dirty}
            truncated={list.truncated}
            refreshing={refreshing}
            onSelect={requestSwitch}
            onRefresh={onRefresh}
            onCollapse={toggleQueue}
            bucket={list.bucket}
            activeEventCount={ready ? events.length : 0}
            onShowDetails={setDetailsVideo}
            onOpenVideo={openVideoInTab}
            onClear={setClearVideo}
            storageKey={`lemon.queue.${projectId}`}
            othersOn={othersOn}
          />
        </div>
        {!prefs.queueOpen && <QueueRail completed={completedCount} total={videos.length} onExpand={toggleQueue} />}
      </aside>

      <section className="flex shrink-0 flex-col lg:min-h-0 lg:overflow-hidden">
        <div className="flex h-11 shrink-0 items-center gap-2 border-b px-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="truncate text-sm font-medium" title={activeVideo?.filename ?? activeKey ?? ""}>
                {activeVideo?.filename ?? activeKey}
              </span>
              {status === "completed" && (
                <Badge variant="outline" className="border-emerald-500/40 text-emerald-600 dark:text-emerald-400">
                  Completed
                </Badge>
              )}
              {othersHere.length > 0 && (
                <Badge variant="outline" className="shrink-0 border-amber-500/40 text-amber-600 dark:text-amber-400">
                  <Users /> {joinNames(othersHere)} {othersHere.length === 1 ? "is" : "are"} also here
                </Badge>
              )}
            </div>
          </div>
          <span
            className="hidden max-w-[40%] min-w-0 truncate font-mono text-[11px] text-muted-foreground xl:block"
            title={`s3://${list.bucket}/${activeKey}`}
          >
            s3://{list.bucket}/{activeKey}
          </span>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => goRelative(-1)} aria-label="Previous video">
                <ChevronUp />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Previous video (Alt+↑)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon-sm" onClick={() => goRelative(1)} aria-label="Next video">
                <ChevronDown />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Next video (Alt+↓)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                onClick={() => setShowShortcuts(true)}
                aria-label="Keyboard shortcuts"
              >
                <Keyboard />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Keyboard shortcuts (?)</TooltipContent>
          </Tooltip>
        </div>

        {conflict && (
          <div
            role="alert"
            className="flex shrink-0 flex-wrap items-center gap-2 border-b border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm"
          >
            <AlertTriangle className="size-4 shrink-0 text-amber-600 dark:text-amber-400" />
            <span className="min-w-0 flex-1">
              {conflict.message} <span className="text-muted-foreground">Your changes here are not saved yet.</span>
            </span>
            <Button size="xs" variant="outline" onClick={reloadFromServer}>
              Load their version
            </Button>
            <Button size="xs" onClick={keepMine}>
              Keep mine
            </Button>
          </div>
        )}

        <div className="shrink-0">
          <VideoPlayer
            ref={playerRef}
            mediaKey={activeKey ?? ""}
            src={urlQ.data && urlQ.data.key === activeKey ? urlQ.data.url : null}
            fps={fps}
            skipSeconds={skipSeconds}
            timeStore={timeStore}
            events={ready ? events : []}
            eventTypes={schema.event_types}
            selectedEventId={editingId}
            onMarkerClick={startEdit}
            onMediaError={onMediaError}
            overlay={playerOverlay}
          />
        </div>

        <div className="flex h-9 shrink-0 items-center justify-between border-b px-4 text-xs">
          <span className="font-medium">
            {withEvents ? (
              <>
                Timeline{" "}
                <span className="ml-1 text-muted-foreground tabular-nums">{ready ? events.length : "–"} events</span>
              </>
            ) : (
              "Video labels"
            )}
          </span>
          <EventLegend eventTypes={schema.event_types} />
        </div>
        <div className="min-h-48 flex-1 lg:min-h-0 lg:overflow-y-auto">
          {annQ.error ? (
            <ErrorState error={annQ.error} onRetry={() => annQ.refetch()} compact />
          ) : !ready ? (
            <div className="space-y-2 p-4">
              <Skeleton className="h-8" />
              <Skeleton className="h-8" />
              <Skeleton className="h-8 w-2/3" />
            </div>
          ) : (
            <>
              <LabelsSummary schema={schema} labels={labels} />
              {withEvents && (
                <EventList
                  events={events}
                  schema={schema}
                  timeStore={timeStore}
                  selectedId={editingId}
                  flashId={flashId}
                  onSeek={seekTo}
                  onEdit={startEdit}
                  onDelete={deleteEvent}
                />
              )}
            </>
          )}
        </div>
      </section>

      <aside className="shrink-0 border-t lg:min-h-0 lg:border-t-0">
        <div className={cn("h-full lg:border-l", !prefs.panelOpen && "lg:hidden")}>
          <TaggingPanel
            schema={schema}
            fps={fps}
            timeStore={timeStore}
            draft={draft}
            onDraftChange={setDraft}
            labels={labels}
            onLabelsChange={changeLabels}
            showRequiredLabelErrors={showRequiredLabels}
            editing={editing}
            prefs={prefs}
            onPrefsChange={(p) => prefsStore.write({ ...prefs, ...p })}
            disabled={!ready}
            onCapture={capture}
            onUpdate={updateEvent}
            onRetime={retime}
            onCancelEdit={exitEdit}
            onDelete={() => editing && deleteEvent(editing.event)}
            dirty={dirty}
            saving={saveMut.isPending}
            status={status}
            savedAt={annQ.data?.updated_at ?? null}
            eventCount={ready ? events.length : 0}
            onSave={saveOnly}
            onSaveNext={saveAndNext}
            onCollapse={togglePanel}
            showRequiredErrors={showRequired}
          />
        </div>
        {!prefs.panelOpen && (
          <TagRail
            onExpand={togglePanel}
            onCapture={editingId ? updateEvent : capture}
            onSave={saveOnly}
            onSaveNext={saveAndNext}
            canCapture={ready && withEvents}
            dirty={dirty}
            saving={saveMut.isPending}
          />
        )}
      </aside>

      <ShortcutsDialog open={showShortcuts} onOpenChange={setShowShortcuts} />

      <VideoDetailsDialog
        projectId={projectId}
        video={detailsVideo}
        onOpenChange={(open) => !open && setDetailsVideo(null)}
        onOpenVideo={openVideoInTab}
      />

      <ClearAnnotationsDialog
        video={clearVideo}
        eventCount={clearVideo?.key === activeKey && ready ? events.length : (clearVideo?.event_count ?? 0)}
        onOpenChange={(open) => !open && setClearVideo(null)}
        onConfirm={clearAnnotations}
      />
    </div>
  );
}

function EventLegend({ eventTypes }: { eventTypes: string[] }) {
  if (eventTypes.length === 0) return null;
  return (
    <div className="hidden min-w-0 items-center gap-3 overflow-hidden text-muted-foreground sm:flex">
      {eventTypes.map((t) => (
        <span key={t} className="flex shrink-0 items-center gap-1.5">
          <span className="size-2 rounded-full" style={{ backgroundColor: eventColor(t, eventTypes) }} />
          {t}
        </span>
      ))}
    </div>
  );
}

export function WorkspaceSkeleton() {
  return (
    <div className="grid h-full grid-cols-1 lg:grid-cols-[20rem_minmax(0,1fr)_21rem]">
      <div className="hidden space-y-2 border-r p-3 lg:block">
        <Skeleton className="h-20" />
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9" />
        ))}
      </div>
      <div className="space-y-3 p-3">
        <Skeleton className="aspect-video w-full" />
        <Skeleton className="h-8" />
        <Skeleton className="h-8" />
      </div>
      <div className="hidden space-y-3 border-l p-4 lg:block">
        <Skeleton className="h-9" />
        <Skeleton className="h-32" />
        <Skeleton className="h-11" />
      </div>
    </div>
  );
}
