"use client";

import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Copy, ExternalLink, Play } from "lucide-react";
import { useState } from "react";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { keys } from "@/hooks/queries";
import { api, errorMessage } from "@/lib/api";
import { copyText } from "@/lib/clipboard";
import { formatBytes, formatTime } from "@/lib/format";
import type { VideoDetails, VideoItem, VideoStatus } from "@/lib/types";
import { cn } from "@/lib/utils";

const STATUS_LABEL: Record<VideoStatus, string> = {
  not_started: "Not started",
  in_progress: "In progress",
  completed: "Completed",
};

export function VideoDetailsDialog({
  projectId,
  video,
  onOpenChange,
  onOpenVideo,
}: {
  projectId: string;
  video: VideoItem | null;
  onOpenChange: (open: boolean) => void;
  onOpenVideo: (video: VideoItem) => void;
}) {
  return (
    <Dialog open={video !== null} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85svh] grid-rows-[auto_minmax(0,1fr)_auto] sm:max-w-2xl">
        {video && <DetailsBody projectId={projectId} video={video} onOpenVideo={onOpenVideo} />}
      </DialogContent>
    </Dialog>
  );
}

function DetailsBody({
  projectId,
  video,
  onOpenVideo,
}: {
  projectId: string;
  video: VideoItem;
  onOpenVideo: (video: VideoItem) => void;
}) {
  const q = useQuery({
    queryKey: keys.details(projectId, video.key),
    queryFn: () => api.videoDetails(projectId, video.key),
    staleTime: 0,
  });
  const d = q.data;

  return (
    <>
      <DialogHeader className="min-w-0">
        <DialogTitle className="truncate pr-8" title={video.filename}>
          {video.filename}
        </DialogTitle>
        <DialogDescription className="truncate font-mono text-xs" title={video.key}>
          {d?.folder || "/"}
        </DialogDescription>
      </DialogHeader>

      <div className="-mx-4 min-h-0 overflow-y-auto px-4">
        {q.isPending ? (
          <div className="grid gap-3 py-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-6" />
            ))}
          </div>
        ) : q.error ? (
          <Alert variant="destructive">
            <AlertTriangle />
            <AlertTitle>{errorMessage(q.error).title}</AlertTitle>
            {errorMessage(q.error).hint && <AlertDescription>{errorMessage(q.error).hint}</AlertDescription>}
          </Alert>
        ) : (
          <DetailsContent projectId={projectId} d={q.data} missing={video.missing} />
        )}
      </div>

      <DialogFooter className="gap-2 sm:justify-between">
        <div className="flex gap-2">
          {d?.console_url && (
            <Button variant="ghost" asChild>
              <a href={d.console_url} target="_blank" rel="noreferrer">
                <ExternalLink /> AWS console
              </a>
            </Button>
          )}
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            onClick={() => copyText(`s3://${d?.bucket ?? ""}/${video.key}`, "S3 URI copied")}
            disabled={!d}
          >
            <Copy /> Copy S3 URI
          </Button>
          <Button onClick={() => onOpenVideo(video)} disabled={video.missing}>
            <Play /> Open video
          </Button>
        </div>
      </DialogFooter>
    </>
  );
}

function DetailsContent({ projectId, d, missing }: { projectId: string; d: VideoDetails; missing: boolean }) {
  const meta = Object.entries(d.user_metadata);
  return (
    <div className="grid gap-5 py-1">
      <div className="flex flex-wrap gap-1.5">
        <Badge
          variant="outline"
          className={cn(
            d.status === "completed" && "border-emerald-500/40 text-emerald-600 dark:text-emerald-400",
            d.status === "in_progress" && "border-amber-500/40 text-amber-600 dark:text-amber-400",
          )}
        >
          {STATUS_LABEL[d.status]}
        </Badge>
        <Badge variant="secondary" className="font-mono uppercase">
          {d.extension.replace(".", "")}
        </Badge>
        {d.content_type && (
          <Badge variant="secondary" className="font-mono">
            {d.content_type}
          </Badge>
        )}
        {missing && (
          <Badge variant="outline" className="border-amber-500/40 text-amber-600 dark:text-amber-400">
            Not in bucket
          </Badge>
        )}
      </div>

      {d.s3_error && (
        <Alert className="border-amber-500/30 bg-amber-500/5">
          <AlertTriangle className="text-amber-500" />
          <AlertTitle>S3 object details unavailable</AlertTitle>
          <AlertDescription>{d.s3_error}</AlertDescription>
        </Alert>
      )}

      <Section title="Location">
        <Row label="S3 URI" value={d.s3_uri} mono copy />
        <Row label="Bucket" value={d.bucket} mono />
        <Row label="Region" value={d.region} mono />
        <Row label="Key" value={d.key} mono copy />
      </Section>

      <Section title="File">
        <Row label="Size" value={d.size != null ? `${formatBytes(d.size)} (${d.size.toLocaleString()} bytes)` : null} />
        <Row label="File type" value={d.extension === ".mov" ? "QuickTime movie (.mov)" : "MPEG-4 video (.mp4)"} />
        <Row label="Content type" value={d.content_type} mono />
        <Row label="Last modified" value={d.last_modified ? new Date(d.last_modified).toLocaleString() : null} />
        <Row label="Storage class" value={d.storage_class} mono />
        <Row label="ETag" value={d.etag} mono copy />
      </Section>

      {!missing && !d.s3_error && <MediaSection projectId={projectId} videoKey={d.key} />}

      <Section title="S3 metadata">
        {meta.length ? (
          meta.map(([k, v]) => <Row key={k} label={k} value={v} mono />)
        ) : (
          <p className="text-xs text-muted-foreground">No custom metadata (x-amz-meta-*) on this object.</p>
        )}
      </Section>

      <Section title="Annotations">
        <Row label="Status" value={STATUS_LABEL[d.status]} />
        <Row label="Events" value={String(d.event_count)} />
        <Row label="Last saved" value={d.annotated_at ? new Date(d.annotated_at).toLocaleString() : "Never"} />
        <Row label="Local file" value={d.annotation_file} mono copy />
        <Row label="Session URL" value={d.streaming_url} mono copy truncate />
      </Section>
    </div>
  );
}

/** Duration and resolution, read by the browser from the file header. */
function MediaSection({ projectId, videoKey }: { projectId: string; videoKey: string }) {
  // A fresh URL each time: a cached one may have expired, which would look like an unplayable file.
  const url = useQuery({
    queryKey: [...keys.details(projectId, videoKey), "media-url"],
    queryFn: () => api.streamUrl(projectId, videoKey),
    staleTime: 0,
    gcTime: 0,
  });
  const [media, setMedia] = useState<{ duration: number; width: number; height: number } | null>(null);
  const [failed, setFailed] = useState(false);
  const pending = !media && !failed && !url.error;

  return (
    <Section title="Video">
      {url.data && !media && !failed && (
        <video
          src={url.data.url}
          preload="metadata"
          muted
          className="hidden"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setMedia({ duration: v.duration, width: v.videoWidth, height: v.videoHeight });
            v.removeAttribute("src");
            v.load();
          }}
          onError={() => setFailed(true)}
        />
      )}
      <Row
        label="Duration"
        value={media ? formatTime(media.duration) : pending ? "Reading…" : "Unavailable"}
        mono={Boolean(media)}
      />
      <Row
        label="Resolution"
        value={media ? `${media.width} × ${media.height}` : pending ? "Reading…" : "Unavailable (codec not playable?)"}
        mono={Boolean(media)}
      />
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-2">
      <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      <dl className="grid gap-1.5 rounded-lg border bg-muted/20 p-3">{children}</dl>
    </section>
  );
}

function Row({
  label,
  value,
  mono,
  copy,
  truncate,
}: {
  label: string;
  value: string | null | undefined;
  mono?: boolean;
  copy?: boolean;
  truncate?: boolean;
}) {
  return (
    <div className="group grid grid-cols-[8.5rem_minmax(0,1fr)_auto] items-start gap-3 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd
        className={cn(
          "min-w-0",
          mono && "font-mono text-xs leading-5",
          truncate ? "truncate" : "break-all",
          !value && "text-muted-foreground",
        )}
        title={truncate && value ? value : undefined}
      >
        {value || "—"}
      </dd>
      {copy && value ? (
        <Button
          variant="ghost"
          size="icon-xs"
          className="opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
          onClick={() => copyText(value, `${label} copied`)}
          aria-label={`Copy ${label}`}
        >
          <Copy />
        </Button>
      ) : (
        <span className="size-6" />
      )}
    </div>
  );
}
