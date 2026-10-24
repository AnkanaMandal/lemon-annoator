"use client";

import { AlertTriangle, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";

export function ErrorState({
  error,
  onRetry,
  action,
  className,
  compact,
}: {
  error: unknown;
  onRetry?: () => void;
  action?: React.ReactNode;
  className?: string;
  compact?: boolean;
}) {
  const { title, hint } = errorMessage(error);
  return (
    <div
      role="alert"
      className={cn("flex flex-col items-center justify-center gap-3 text-center", compact ? "p-4" : "p-8", className)}
    >
      <div className="grid size-9 place-items-center rounded-full bg-destructive/10 text-destructive">
        <AlertTriangle className="size-4" />
      </div>
      <div className="max-w-sm space-y-1">
        <p className="text-sm font-medium">{title}</p>
        {hint && <p className="text-xs/relaxed text-muted-foreground">{hint}</p>}
      </div>
      {(onRetry || action) && (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RefreshCw /> Retry
            </Button>
          )}
          {action}
        </div>
      )}
    </div>
  );
}
