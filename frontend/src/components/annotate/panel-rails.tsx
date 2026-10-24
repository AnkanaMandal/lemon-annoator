"use client";

import { Crosshair, PanelLeftOpen, PanelRightOpen, Save, SkipForward } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

/** Slim vertical strip shown in place of a collapsed side panel. */
function Rail({ side, children }: { side: "left" | "right"; children: React.ReactNode }) {
  return (
    <div
      className={cn(
        "hidden h-full flex-col items-center gap-1.5 bg-muted/20 py-2.5 lg:flex",
        side === "left" ? "border-r" : "border-l",
      )}
    >
      {children}
    </div>
  );
}

function RailButton({
  label,
  side,
  onClick,
  disabled,
  className,
  children,
}: {
  label: string;
  side: "left" | "right";
  onClick: () => void;
  disabled?: boolean;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          aria-label={label}
          onClick={onClick}
          disabled={disabled}
          className={className}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side={side === "left" ? "right" : "left"}>{label}</TooltipContent>
    </Tooltip>
  );
}

export function QueueRail({ completed, total, onExpand }: { completed: number; total: number; onExpand: () => void }) {
  return (
    <Rail side="left">
      <RailButton side="left" label="Show queue (Q)" onClick={onExpand}>
        <PanelLeftOpen />
      </RailButton>
      <div className="my-1 h-px w-6 bg-border" />
      <button
        type="button"
        onClick={onExpand}
        className="rounded-md px-1 py-2 text-[11px] font-medium text-muted-foreground tabular-nums [writing-mode:vertical-rl] hover:text-foreground"
        title="Show queue"
      >
        <span className="rotate-180">
          {completed} / {total} completed
        </span>
      </button>
    </Rail>
  );
}

export function TagRail({
  onExpand,
  onCapture,
  onSave,
  onSaveNext,
  canCapture,
  dirty,
  saving,
}: {
  onExpand: () => void;
  onCapture: () => void;
  onSave: () => void;
  onSaveNext: () => void;
  canCapture: boolean;
  dirty: boolean;
  saving: boolean;
}) {
  return (
    <Rail side="right">
      <RailButton side="right" label="Show tag panel (T)" onClick={onExpand}>
        <PanelRightOpen />
      </RailButton>
      <div className="my-1 h-px w-6 bg-border" />
      <RailButton side="right" label="Capture timestamp (Enter)" onClick={onCapture} disabled={!canCapture}>
        <Crosshair />
      </RailButton>
      <RailButton
        side="right"
        label={dirty ? "Save — unsaved changes (Ctrl+S)" : "Save (Ctrl+S)"}
        onClick={onSave}
        disabled={saving}
        className="relative"
      >
        <Save />
        {dirty && <span className="absolute top-1.5 right-1.5 size-1.5 rounded-full bg-amber-500" />}
      </RailButton>
      <RailButton
        side="right"
        label="Save & Next (Ctrl+Enter)"
        onClick={onSaveNext}
        disabled={saving}
        className="text-emerald-600 hover:text-emerald-600 dark:text-emerald-400"
      >
        {saving ? <Spinner /> : <SkipForward />}
      </RailButton>
    </Rail>
  );
}
