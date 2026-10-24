"use client";

import { Clapperboard, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSyncStorage } from "@/hooks/queries";
import { errorMessage } from "@/lib/api";
import { formatBytes, formatRelative } from "@/lib/format";
import type { Project, SyncInfo } from "@/lib/types";
import { cn } from "@/lib/utils";

/** Re-render periodically so "Last synced 2m ago" stays current. */
function useTicker(ms: number) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((t) => t + 1), ms);
    return () => clearInterval(id);
  }, [ms]);
}

const plural = (n: number, word: string) => `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

export function SyncPanel({ project, unsavedChanges }: { project: Project; unsavedChanges: boolean }) {
  useTicker(30_000);
  const sync = useSyncStorage(project.id);
  const info = project.last_sync;
  const configured = project.storage.is_configured;
  const disabled = !configured || unsavedChanges || sync.isPending;

  const run = () =>
    sync.mutate(undefined, {
      onSuccess: ({ sync: s }) => toast.success(`Synced · ${summary(s)}`),
      onError: (err) => {
        const { title, hint } = errorMessage(err);
        toast.error(`Sync failed: ${title}`, { description: hint ?? undefined });
      },
    });

  return (
    <section
      aria-label="Bucket sync"
      className="flex flex-col gap-5 rounded-xl border bg-muted/30 p-5 sm:flex-row sm:items-center sm:justify-between"
    >
      <div className="flex min-w-0 items-center gap-4">
        <div className="grid size-12 shrink-0 place-items-center rounded-xl bg-background text-muted-foreground ring-1 ring-border">
          <Clapperboard className="size-5" />
        </div>
        <div className="min-w-0 space-y-1.5">
          {info ? (
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-2xl leading-none font-semibold tracking-tight tabular-nums">
                {info.video_count.toLocaleString()}
                {info.truncated && "+"}
              </span>
              <span className="text-sm text-muted-foreground">{info.video_count === 1 ? "video" : "videos"}</span>
              <NewBadge info={info} />
            </div>
          ) : (
            <p className="text-base font-medium">{configured ? "Not synced yet" : "Not connected yet"}</p>
          )}
          <p className="text-xs text-muted-foreground">
            {info ? (
              <>
                {info.total_bytes != null && <>{formatBytes(info.total_bytes)} · </>}
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span className="cursor-default underline decoration-dotted underline-offset-2">
                      Last synced {formatRelative(info.synced_at)}
                    </span>
                  </TooltipTrigger>
                  <TooltipContent>{new Date(info.synced_at).toLocaleString()}</TooltipContent>
                </Tooltip>
              </>
            ) : configured ? (
              "Sync to count the .mp4 and .mov files in this folder."
            ) : (
              "Save a bucket below, then sync to load its videos."
            )}
          </p>
          {info?.truncated && (
            <p className="text-xs text-amber-600 dark:text-amber-400">
              Listing stopped at the scan limit. Narrow the folder prefix to see everything.
            </p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 flex-col items-stretch gap-1.5 sm:items-end">
        <Button variant="outline" onClick={run} disabled={disabled} className="h-9 px-4">
          <RefreshCw className={cn(sync.isPending && "animate-spin")} />
          {sync.isPending ? "Syncing…" : "Sync storage"}
        </Button>
        {unsavedChanges && configured && (
          <p className="text-[11px] text-muted-foreground">Save your changes to sync with them.</p>
        )}
      </div>
    </section>
  );
}

function NewBadge({ info }: { info: SyncInfo }) {
  if (info.new_count == null) {
    return (
      <Badge variant="secondary" className="font-normal">
        First sync
      </Badge>
    );
  }
  if (info.new_count === 0) return <span className="text-xs text-muted-foreground">· no new videos</span>;
  return (
    <Badge variant="outline" className="border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400">
      +{info.new_count.toLocaleString()} new
    </Badge>
  );
}

function summary(s: SyncInfo): string {
  const total = plural(s.video_count, "video");
  if (s.new_count == null) return total;
  return s.new_count ? `${total} (${s.new_count} new)` : `${total}, nothing new`;
}
