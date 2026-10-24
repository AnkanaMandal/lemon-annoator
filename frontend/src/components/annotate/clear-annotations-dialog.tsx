"use client";

import { useState } from "react";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { VideoItem } from "@/lib/types";

export function ClearAnnotationsDialog({
  video,
  eventCount,
  onOpenChange,
  onConfirm,
}: {
  video: VideoItem | null;
  /** Events that will be removed (saved, plus unsaved ones when this is the active video). */
  eventCount: number;
  onOpenChange: (open: boolean) => void;
  onConfirm: (video: VideoItem) => Promise<void>;
}) {
  const [pending, setPending] = useState(false);
  const saved = video ? video.status !== "not_started" : false;

  return (
    <AlertDialog open={video !== null} onOpenChange={(open) => !pending && onOpenChange(open)}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear annotations?</AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2">
              <p>
                <span className="font-medium break-all text-foreground">{video?.filename}</span> will go back to{" "}
                <span className="font-medium text-foreground">not started</span> and its {eventCount} event
                {eventCount === 1 ? "" : "s"} will be removed.
              </p>
              {saved && (
                <p>
                  The saved file is moved to <code className="font-mono">app_data/.trash</code>, so it can still be
                  recovered. The video in S3 is not touched.
                </p>
              )}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <Button
            disabled={pending}
            className="bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/90 dark:hover:bg-destructive"
            onClick={async () => {
              if (!video) return;
              setPending(true);
              try {
                await onConfirm(video);
                onOpenChange(false);
              } catch {
                /* error toast already shown; keep the dialog open so the user can retry */
              } finally {
                setPending(false);
              }
            }}
          >
            {pending && <Spinner />} Clear annotations
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
