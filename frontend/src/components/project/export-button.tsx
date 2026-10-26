"use client";

import { useMutation } from "@tanstack/react-query";
import { Download } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { api, errorMessage } from "@/lib/api";
import { pendingSave } from "@/lib/pending-save";

function download(filename: string, data: unknown) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportButton({ projectId }: { projectId: string }) {
  const exporter = useMutation({
    mutationFn: async () => {
      await pendingSave.flush(projectId);
      return api.exportProject(projectId);
    },
    onSuccess: (res) => {
      download(res.filename, res.data);
      toast.success(`Exported ${res.video_count} videos · ${res.event_count} events`, {
        description: `A copy is kept in the database (export #${res.export_id}).`,
        duration: 8000,
      });
      for (const w of res.warnings) toast.warning(w, { duration: 10000 });
    },
    onError: (err) => {
      const { title, hint } = errorMessage(err);
      toast.error(`Export failed: ${title}`, { description: hint ?? undefined });
    },
  });

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          onClick={() => exporter.mutate()}
          disabled={exporter.isPending}
          className="h-10 gap-2 rounded-lg px-4 text-[15px] [&_svg:not([class*='size-'])]:size-[18px]"
        >
          {exporter.isPending ? <Spinner /> : <Download />}
          <span className="hidden sm:inline">Export Project JSON</span>
          <span className="sm:hidden">Export</span>
        </Button>
      </TooltipTrigger>
      <TooltipContent>Downloads the project as JSON and keeps a copy in the database</TooltipContent>
    </Tooltip>
  );
}
