"use client";

import { ChevronFirst, ChevronLast, Maximize, Pause, Play, Rewind, FastForward, Volume2, VolumeX } from "lucide-react";
import { useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { eventColor } from "@/lib/colors";
import { formatTime, frameAt } from "@/lib/format";
import { type TimeStore, useCurrentTime } from "@/lib/time-store";
import type { AnnotationEvent } from "@/lib/types";
import { cn } from "@/lib/utils";

export const SPEEDS = [0.1, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3];

export interface PlayerHandle {
  toggle(): void;
  play(): void;
  pause(): void;
  seek(t: number): void;
  seekBy(dt: number): void;
  stepFrames(n: number): void;
  changeSpeed(dir: 1 | -1): void;
  getTime(): number;
  getDuration(): number;
}

interface Props {
  ref?: React.Ref<PlayerHandle>;
  /** Stable identity of the media; a new `src` with the same key resumes in place. */
  mediaKey: string;
  src: string | null;
  fps: number;
  skipSeconds: number;
  timeStore: TimeStore;
  events: AnnotationEvent[];
  eventTypes: string[];
  selectedEventId: string | null;
  onMarkerClick: (ev: AnnotationEvent) => void;
  onMediaError: (error: MediaError | null) => void;
  onDuration?: (d: number) => void;
  overlay?: React.ReactNode;
}

export function VideoPlayer({
  ref,
  mediaKey,
  src,
  fps,
  skipSeconds,
  timeStore,
  events,
  eventTypes,
  selectedEventId,
  onMarkerClick,
  onMediaError,
  onDuration,
  overlay,
}: Props) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [paused, setPaused] = useState(true);
  const [duration, setDuration] = useState(0);
  const [buffering, setBuffering] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [muted, setMuted] = useState(false);
  const resumeRef = useRef<{ key: string; time: number; play: boolean } | null>(null);
  const lastKeyRef = useRef<string | null>(null);
  const lastSrcRef = useRef<string | null>(null);
  const playingRef = useRef(false);
  const callbacks = useRef({ onMediaError, onDuration });
  useEffect(() => {
    callbacks.current = { onMediaError, onDuration };
  });

  const v = () => videoRef.current;

  // React to the media changing. Effects also re-run when a hidden route is shown again, so act
  // only on real changes of video (mediaKey) or URL (src).
  useLayoutEffect(() => {
    const video = v();
    const keyChanged = mediaKey !== lastKeyRef.current;
    if (keyChanged) {
      // Another video: stop the old one right away. Removing the src attribute alone doesn't
      // unload media, so it would keep playing (and feeding its time) until the new URL arrives.
      if (video) {
        video.pause();
        if (!src) {
          video.removeAttribute("src");
          video.load();
        }
      }
      playingRef.current = false;
      resumeRef.current = null;
      timeStore.set(0);
      setDuration(0);
    } else if (src && lastSrcRef.current && src !== lastSrcRef.current && timeStore.get() > 0) {
      // Same video, fresh presigned URL: resume where playback stopped. The time comes from the
      // store because assigning a new src has already reset currentTime to 0.
      resumeRef.current = { key: mediaKey, time: timeStore.get(), play: playingRef.current };
    }
    lastKeyRef.current = mediaKey;
    if (keyChanged) lastSrcRef.current = src;
    else if (src) lastSrcRef.current = src;
  }, [src, mediaKey, timeStore]);

  // Pause when the route is hidden by <Activity> (display:none does not stop media).
  useLayoutEffect(() => {
    const video = v();
    return () => video?.pause();
  }, []);

  // Smooth time updates while playing; event listeners cover seeks while paused.
  useEffect(() => {
    const video = v();
    if (!video) return;
    let raf = 0;
    const tick = () => {
      sync();
      raf = requestAnimationFrame(tick);
    };
    // While a new resource loads (readyState 0) currentTime reads 0; keep the last real
    // position so a presigned-URL refresh can resume exactly where playback stopped.
    const sync = () => {
      if (video.readyState > 0) timeStore.set(video.currentTime);
    };
    const onPlay = () => {
      playingRef.current = true;
      setPaused(false);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    const onPause = () => {
      playingRef.current = false;
      setPaused(true);
      cancelAnimationFrame(raf);
      sync();
    };
    const onMeta = () => {
      const d = Number.isFinite(video.duration) ? video.duration : 0;
      setDuration(d);
      callbacks.current.onDuration?.(d);
      const resume = resumeRef.current;
      if (resume && resume.key === lastKeyRef.current) {
        video.currentTime = resume.time;
        if (resume.play) video.play().catch(() => {});
        resumeRef.current = null;
      }
      sync();
    };
    const onWaiting = () => setBuffering(true);
    const onReady = () => setBuffering(false);
    const onError = () => {
      setBuffering(false);
      callbacks.current.onMediaError(video.error);
    };

    video.addEventListener("play", onPlay);
    video.addEventListener("pause", onPause);
    video.addEventListener("ended", onPause);
    video.addEventListener("seeked", sync);
    video.addEventListener("timeupdate", sync);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("durationchange", onMeta);
    video.addEventListener("waiting", onWaiting);
    video.addEventListener("seeking", onWaiting);
    video.addEventListener("canplay", onReady);
    video.addEventListener("seeked", onReady);
    video.addEventListener("playing", onReady);
    video.addEventListener("error", onError);
    if (video.readyState >= 1) onMeta(); // already loaded (e.g. returning to a hidden route)
    return () => {
      cancelAnimationFrame(raf);
      video.removeEventListener("play", onPlay);
      video.removeEventListener("pause", onPause);
      video.removeEventListener("ended", onPause);
      video.removeEventListener("seeked", sync);
      video.removeEventListener("timeupdate", sync);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("durationchange", onMeta);
      video.removeEventListener("waiting", onWaiting);
      video.removeEventListener("seeking", onWaiting);
      video.removeEventListener("canplay", onReady);
      video.removeEventListener("seeked", onReady);
      video.removeEventListener("playing", onReady);
      video.removeEventListener("error", onError);
    };
  }, [timeStore]);

  const seek = useCallback(
    (t: number) => {
      const video = v();
      if (!video) return;
      const max = Number.isFinite(video.duration) ? video.duration : t;
      video.currentTime = Math.min(Math.max(0, t), max);
      timeStore.set(video.currentTime);
    },
    [timeStore],
  );

  const handle: PlayerHandle = {
    toggle() {
      const video = v();
      if (!video || !src) return;
      if (video.paused || video.ended) video.play().catch(() => {});
      else video.pause();
    },
    play() {
      v()
        ?.play()
        .catch(() => {});
    },
    pause() {
      v()?.pause();
    },
    seek,
    seekBy(dt) {
      const video = v();
      if (video) seek(video.currentTime + dt);
    },
    stepFrames(n) {
      const video = v();
      if (!video) return;
      video.pause();
      // Land in the middle of the target frame: boundaries are ambiguous across browsers.
      const frame = frameAt(video.currentTime, fps) + n;
      seek((Math.max(0, frame) + 0.5) / fps);
    },
    changeSpeed(dir) {
      const i = SPEEDS.indexOf(speed);
      const next = SPEEDS[Math.min(SPEEDS.length - 1, Math.max(0, (i < 0 ? 4 : i) + dir))];
      setSpeed(next);
    },
    getTime: () => v()?.currentTime ?? 0,
    getDuration: () => {
      const d = v()?.duration ?? 0;
      return Number.isFinite(d) ? d : 0;
    },
  };
  useImperativeHandle(ref, () => handle);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, src]);

  const toggleMute = () => {
    const video = v();
    if (!video) return;
    video.muted = !video.muted;
    setMuted(video.muted);
  };

  const fullscreen = () => {
    const el = containerRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.().catch(() => {});
  };

  return (
    <div ref={containerRef} className="flex flex-col bg-black text-white [&:fullscreen_video]:max-h-none">
      <div className="relative flex aspect-video max-h-[calc(100svh-22rem)] min-h-56 w-full items-center justify-center">
        <video
          ref={videoRef}
          src={src ?? undefined}
          preload="auto"
          playsInline
          className="h-full w-full object-contain"
          onClick={() => handle.toggle()}
          onDoubleClick={fullscreen}
        />
        {buffering && src && !overlay && (
          <div className="pointer-events-none absolute inset-0 grid place-items-center">
            <Spinner className="size-7 text-white/80" />
          </div>
        )}
        {overlay && <div className="absolute inset-0 grid place-items-center bg-black/80 p-6">{overlay}</div>}
      </div>

      <Scrubber
        duration={duration}
        timeStore={timeStore}
        events={events}
        eventTypes={eventTypes}
        selectedEventId={selectedEventId}
        onSeek={seek}
        onMarkerClick={onMarkerClick}
      />

      <div className="flex h-11 items-center gap-1 px-2 text-sm">
        <ControlButton label="Back 1 frame" kbd="←" onClick={() => handle.stepFrames(-1)}>
          <ChevronFirst />
        </ControlButton>
        <ControlButton label={`Back ${skipSeconds}s`} kbd="J" onClick={() => handle.seekBy(-skipSeconds)}>
          <Rewind />
        </ControlButton>
        <ControlButton label={paused ? "Play" : "Pause"} kbd="Space" onClick={() => handle.toggle()}>
          {paused ? <Play className="fill-current" /> : <Pause className="fill-current" />}
        </ControlButton>
        <ControlButton label={`Forward ${skipSeconds}s`} kbd="L" onClick={() => handle.seekBy(skipSeconds)}>
          <FastForward />
        </ControlButton>
        <ControlButton label="Forward 1 frame" kbd="→" onClick={() => handle.stepFrames(1)}>
          <ChevronLast />
        </ControlButton>

        <TimeReadout timeStore={timeStore} duration={duration} fps={fps} />

        <div className="ml-auto flex items-center gap-1">
          <DropdownMenu>
            <Tooltip>
              <TooltipTrigger asChild>
                <DropdownMenuTrigger asChild>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 font-mono text-xs text-white/80 hover:bg-white/10 hover:text-white dark:hover:bg-white/10"
                  >
                    {speed}×
                  </Button>
                </DropdownMenuTrigger>
              </TooltipTrigger>
              <TooltipContent>Playback speed ( [ / ] )</TooltipContent>
            </Tooltip>
            <DropdownMenuContent align="end" className="w-28">
              <DropdownMenuRadioGroup value={String(speed)} onValueChange={(s) => setSpeed(Number(s))}>
                {SPEEDS.map((s) => (
                  <DropdownMenuRadioItem key={s} value={String(s)} className="font-mono text-xs">
                    {s}×
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
            </DropdownMenuContent>
          </DropdownMenu>
          <ControlButton label={muted ? "Unmute" : "Mute"} onClick={toggleMute}>
            {muted ? <VolumeX /> : <Volume2 />}
          </ControlButton>
          <ControlButton label="Fullscreen" onClick={fullscreen}>
            <Maximize />
          </ControlButton>
        </div>
      </div>
    </div>
  );
}

function ControlButton({
  label,
  kbd,
  onClick,
  children,
}: {
  label: string;
  kbd?: string;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          onClick={onClick}
          className="text-white/80 hover:bg-white/10 hover:text-white dark:hover:bg-white/10"
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent>
        {label}
        {kbd && <span className="ml-1.5 opacity-60">{kbd}</span>}
      </TooltipContent>
    </Tooltip>
  );
}

function TimeReadout({ timeStore, duration, fps }: { timeStore: TimeStore; duration: number; fps: number }) {
  const t = useCurrentTime(timeStore);
  return (
    <div className="ml-2 flex items-baseline gap-2 font-mono text-xs tabular-nums">
      <span className="text-white">{formatTime(t)}</span>
      <span className="text-white/40">/ {formatTime(duration)}</span>
      <span className="hidden rounded bg-white/10 px-1.5 py-0.5 text-[10px] text-white/70 sm:inline">
        F {frameAt(t, fps)}
      </span>
    </div>
  );
}

function Scrubber({
  duration,
  timeStore,
  events,
  eventTypes,
  selectedEventId,
  onSeek,
  onMarkerClick,
}: {
  duration: number;
  timeStore: TimeStore;
  events: AnnotationEvent[];
  eventTypes: string[];
  selectedEventId: string | null;
  onSeek: (t: number) => void;
  onMarkerClick: (ev: AnnotationEvent) => void;
}) {
  const trackRef = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null);
  const dragging = useRef(false);
  const t = useCurrentTime(timeStore);
  const pct = duration ? Math.min(100, (t / duration) * 100) : 0;

  const timeAt = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    return { x: ratio * rect.width, t: ratio * duration };
  };

  return (
    <div className="px-3 pt-2">
      <div
        ref={trackRef}
        role="slider"
        aria-label="Seek"
        aria-valuemin={0}
        aria-valuemax={duration}
        aria-valuenow={t}
        tabIndex={-1}
        className={cn("group relative h-6 touch-none select-none", duration ? "cursor-pointer" : "opacity-40")}
        onPointerDown={(e) => {
          if (!duration || (e.target as HTMLElement).dataset.marker) return;
          dragging.current = true;
          e.currentTarget.setPointerCapture(e.pointerId);
          onSeek(timeAt(e.clientX).t);
        }}
        onPointerMove={(e) => {
          if (!duration) return;
          const pos = timeAt(e.clientX);
          setHover(pos);
          if (dragging.current) onSeek(pos.t);
        }}
        onPointerUp={() => (dragging.current = false)}
        onPointerLeave={() => setHover(null)}
      >
        <div className="absolute inset-x-0 top-1/2 h-1 -translate-y-1/2 rounded-full bg-white/15 transition-[height] group-hover:h-1.5">
          <div className="h-full rounded-full bg-white/70" style={{ width: `${pct}%` }} />
        </div>
        {duration > 0 &&
          events.map((ev) => {
            const left = Math.min(100, (ev.timestamp / duration) * 100);
            const selected = ev.id === selectedEventId;
            return (
              <button
                key={ev.id}
                type="button"
                data-marker="1"
                tabIndex={-1}
                title={`${formatTime(ev.timestamp)} · ${ev.event_name ?? "Unlabeled"}`}
                onClick={() => onMarkerClick(ev)}
                className={cn(
                  "absolute top-1/2 h-3.5 w-1 -translate-x-1/2 -translate-y-1/2 rounded-full ring-black/60 transition-transform hover:scale-y-150",
                  selected ? "z-10 h-5 w-1.5 ring-2 ring-white" : "ring-1",
                )}
                style={{ left: `${left}%`, backgroundColor: eventColor(ev.event_name, eventTypes) }}
              />
            );
          })}
        <div
          className="pointer-events-none absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-white shadow"
          style={{ left: `${pct}%` }}
        />
        {hover && (
          <div
            className="pointer-events-none absolute -top-6 -translate-x-1/2 rounded bg-white px-1.5 py-0.5 font-mono text-[10px] text-black tabular-nums"
            style={{ left: hover.x }}
          >
            {formatTime(hover.t)}
          </div>
        )}
      </div>
    </div>
  );
}
