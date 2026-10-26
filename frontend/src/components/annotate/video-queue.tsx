"use client";

import {
  AlertTriangle,
  CheckCircle2,
  Circle,
  CircleDot,
  Copy,
  Eraser,
  ExternalLink,
  Info,
  PanelLeftClose,
  Play,
  RefreshCw,
  Search,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { copyText } from "@/lib/clipboard";
import { formatBytes } from "@/lib/format";
import type { VideoItem } from "@/lib/types";
import { cn } from "@/lib/utils";

type Filter = "all" | "todo" | "done";

const FILTER_LABELS: Record<Filter, string> = {
  all: "All",
  todo: "To do",
  done: "Done",
};

interface Props {
  videos: VideoItem[];
  prefix: string;
  activeKey: string | null;
  activeDirty: boolean;
  truncated: boolean;
  refreshing: boolean;
  onSelect: (key: string) => void;
  onRefresh: () => void;
  /** Collapses the queue to a slim rail (desktop layout only). */
  onCollapse?: () => void;
  bucket: string;
  /** Unsaved + saved events on the active video, so "Clear" is offered even before the first save. */
  activeEventCount: number;
  onShowDetails: (video: VideoItem) => void;
  onOpenVideo: (video: VideoItem) => void;
  onClear: (video: VideoItem) => void;
  /** localStorage key under which the filter and search are remembered (per project). */
  storageKey: string;
  /** Video key -> names of the other people who have it open. */
  othersOn: Map<string, string[]>;
}

function readQueueView(storageKey: string): { query: string; filter: Filter } {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    return {
      query: typeof saved.query === "string" ? saved.query : "",
      filter: ["all", "todo", "done"].includes(saved.filter) ? saved.filter : "all",
    };
  } catch {
    return { query: "", filter: "all" };
  }
}

export function VideoQueue({
  videos,
  prefix,
  activeKey,
  activeDirty,
  truncated,
  refreshing,
  onSelect,
  onRefresh,
  onCollapse,
  bucket,
  activeEventCount,
  onShowDetails,
  onOpenVideo,
  onClear,
  storageKey,
  othersOn,
}: Props) {
  const [query, setQuery] = useState(() => readQueueView(storageKey).query);
  const [filter, setFilter] = useState<Filter>(() => readQueueView(storageKey).filter);
  useEffect(() => {
    try {
      localStorage.setItem(storageKey, JSON.stringify({ query, filter }));
    } catch {
      /* private mode */
    }
  }, [storageKey, query, filter]);
  const activeRef = useRef<HTMLButtonElement>(null);

  const completed = videos.filter((v) => v.status === "completed").length;
  const pct = videos.length ? Math.round((completed / videos.length) * 100) : 0;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return videos.filter((v) => {
      if (filter === "todo" && v.status === "completed") return false;
      if (filter === "done" && v.status !== "completed") return false;
      return !q || v.key.toLowerCase().includes(q);
    });
  }, [videos, query, filter]);

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: "nearest" });
  }, [activeKey]);

  const counts: Record<Filter, number> = {
    all: videos.length,
    todo: videos.length - completed,
    done: completed,
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="space-y-4 border-b px-4 py-4">
        <div className="flex items-center justify-between">
          <h2 className="text-[15px] font-semibold tracking-tight">Dataset queue</h2>
          <div className="flex items-center gap-0.5">
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-xs"
                  onClick={onRefresh}
                  disabled={refreshing}
                  aria-label="Refresh from S3"
                >
                  <RefreshCw className={cn(refreshing && "animate-spin")} />
                </Button>
              </TooltipTrigger>
              <TooltipContent>Re-scan the bucket</TooltipContent>
            </Tooltip>
            {onCollapse && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-xs"
                    onClick={onCollapse}
                    aria-label="Hide queue"
                    className="hidden lg:inline-flex"
                  >
                    <PanelLeftClose />
                  </Button>
                </TooltipTrigger>
                <TooltipContent>Hide queue (Q)</TooltipContent>
              </Tooltip>
            )}
          </div>
        </div>
        <div className="space-y-2">
          <div className="flex justify-between text-[13px] text-muted-foreground tabular-nums">
            <span>
              <span className="font-medium text-foreground">{completed}</span> / {videos.length} completed
            </span>
            <span>{pct}%</span>
          </div>
          <Progress value={pct} className="h-1.5 [&>div]:bg-emerald-500" />
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter videos…"
            className="h-10 pl-9 text-sm"
            aria-label="Filter videos"
          />
        </div>
        <div className="grid grid-cols-3 gap-1 rounded-lg bg-muted p-1 text-[13px]">
          {(["all", "todo", "done"] as Filter[]).map((f) => (
            <button
              key={f}
              type="button"
              onClick={() => setFilter(f)}
              className={cn(
                "rounded-md px-2 py-1.5 transition-colors",
                filter === f ? "bg-background font-medium shadow-sm" : "text-muted-foreground hover:text-foreground",
              )}
            >
              {FILTER_LABELS[f]} <span className="tabular-nums opacity-60">{counts[f]}</span>
            </button>
          ))}
        </div>
      </div>

      <nav className="min-h-0 flex-1 space-y-1 overflow-y-auto p-2.5" aria-label="Videos">
        {visible.length === 0 && (
          <p className="p-6 text-center text-sm text-muted-foreground">No videos match this filter.</p>
        )}
        {visible.map((v) => {
          const active = v.key === activeKey;
          const rel = v.key.startsWith(prefix) ? v.key.slice(prefix.length) : v.key;
          const folder = rel.includes("/") ? rel.slice(0, rel.lastIndexOf("/") + 1) : "";
          const canClear = v.status !== "not_started" || v.event_count > 0 || (active && activeEventCount > 0);
          const others = othersOn.get(v.key) ?? [];
          const savedBy = v.annotated_by ? ` · last saved by ${v.annotated_by}` : "";
          return (
            <ContextMenu key={v.key}>
              <ContextMenuTrigger asChild>
                <button
                  ref={active ? activeRef : undefined}
                  type="button"
                  aria-current={active ? "true" : undefined}
                  onClick={() => onSelect(v.key)}
                  title={`${v.key}${savedBy} · Right-click for options`}
                  className={cn(
                    "group flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors [content-visibility:auto] [contain-intrinsic-size:auto_56px]",
                    active ? "bg-accent text-accent-foreground" : "hover:bg-muted/60 data-[state=open]:bg-muted/60",
                  )}
                >
                  <StatusIcon video={v} />
                  <div className="min-w-0 flex-1 space-y-0.5">
                    <div
                      className={cn("truncate text-sm font-medium", v.missing && "text-muted-foreground line-through")}
                    >
                      {v.filename}
                      {active && activeDirty && <span className="ml-1 text-amber-500">•</span>}
                    </div>
                    <div className="flex gap-2 truncate text-xs text-muted-foreground">
                      {folder && <span className="truncate font-mono">{folder}</span>}
                      {v.size != null && <span className="shrink-0">{formatBytes(v.size)}</span>}
                    </div>
                  </div>
                  {others.length > 0 && (
                    <span
                      className="grid size-6 shrink-0 place-items-center rounded-full bg-amber-500/15 text-[11px] font-semibold text-amber-700 uppercase dark:text-amber-400"
                      title={`${others.join(", ")} ${others.length === 1 ? "has" : "have"} this video open`}
                    >
                      {others.length === 1 ? others[0].slice(0, 1) : others.length}
                    </span>
                  )}
                  {v.event_count > 0 && (
                    <span className="rounded-md bg-muted px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground tabular-nums group-aria-[current=true]:bg-background">
                      {v.event_count}
                    </span>
                  )}
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent className="w-60">
                <ContextMenuLabel className="truncate text-xs font-normal text-muted-foreground" title={v.key}>
                  {v.filename}
                </ContextMenuLabel>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => onShowDetails(v)}>
                  <Info /> View details
                </ContextMenuItem>
                {!active && (
                  <ContextMenuItem onSelect={() => onSelect(v.key)} disabled={v.missing}>
                    <Play /> Annotate this video
                  </ContextMenuItem>
                )}
                <ContextMenuItem onSelect={() => onOpenVideo(v)} disabled={v.missing}>
                  <ExternalLink /> Open in new tab
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => copyText(`s3://${bucket}/${v.key}`, "S3 URI copied")}>
                  <Copy /> Copy S3 URI
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => copyText(v.key, "Key copied")}>
                  <Copy /> Copy key
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem variant="destructive" onSelect={() => onClear(v)} disabled={!canClear}>
                  <Eraser /> Clear annotations…
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          );
        })}
        {truncated && (
          <p className="p-3 text-center text-xs text-muted-foreground">
            Listing truncated — narrow the folder prefix to see everything.
          </p>
        )}
      </nav>
    </div>
  );
}

function StatusIcon({ video }: { video: VideoItem }) {
  if (video.missing)
    return (
      <Tooltip>
        <TooltipTrigger asChild>
          <AlertTriangle className="size-[18px] shrink-0 text-amber-500" />
        </TooltipTrigger>
        <TooltipContent>Annotated, but no longer in the bucket</TooltipContent>
      </Tooltip>
    );
  if (video.status === "completed")
    return <CheckCircle2 className="size-[18px] shrink-0 text-emerald-500" aria-label="Completed" />;
  if (video.status === "in_progress")
    return <CircleDot className="size-[18px] shrink-0 text-amber-500" aria-label="In progress" />;
  return <Circle className="size-[18px] shrink-0 text-muted-foreground/50" aria-label="Not started" />;
}
