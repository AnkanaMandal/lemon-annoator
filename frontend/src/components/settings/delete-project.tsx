"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { keys } from "@/hooks/queries";
import { api, errorMessage } from "@/lib/api";
import type { Project } from "@/lib/types";

const CONFIRM_WORD = "delete";

export function DeleteProject({ project }: { project: Project }) {
  const router = useRouter();
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const confirmed = typed.trim().toLowerCase() === CONFIRM_WORD;
  const annotated = project.stats.completed + project.stats.in_progress;

  const remove = useMutation({
    mutationFn: () => api.deleteProject(project.id),
    onSuccess: (res) => {
      setOpen(false);
      qc.removeQueries({ queryKey: keys.project(project.id) });
      qc.invalidateQueries({ queryKey: keys.projects });
      toast.success(`Deleted “${project.name}”`, { description: `Files moved to ${res.moved_to}` });
      router.push("/");
    },
    onError: (err) => {
      const { title, hint } = errorMessage(err);
      toast.error(title, { description: hint ?? undefined });
    },
  });

  const onOpenChange = (next: boolean) => {
    if (remove.isPending) return;
    setOpen(next);
    if (!next) setTyped("");
  };

  return (
    <Card className="ring-destructive/30">
      <CardHeader>
        <CardTitle>Delete project</CardTitle>
        <CardDescription>
          Moves this project&apos;s folder (config, annotations and exports) to{" "}
          <code className="font-mono">app_data/.trash</code>. Videos in S3 are never touched.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <AlertDialog open={open} onOpenChange={onOpenChange}>
          <AlertDialogTrigger asChild>
            <Button variant="destructive">
              <Trash2 /> Delete project
            </Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <form
              className="grid gap-4"
              onSubmit={(e) => {
                e.preventDefault();
                if (confirmed && !remove.isPending) remove.mutate();
              }}
            >
              <AlertDialogHeader>
                <AlertDialogTitle>Delete “{project.name}”?</AlertDialogTitle>
                <AlertDialogDescription>
                  {annotated > 0
                    ? `${annotated} annotated video${annotated === 1 ? "" : "s"} and all exports will be moved to the trash folder.`
                    : "The project configuration will be moved to the trash folder."}{" "}
                  You can restore it by moving the folder back into <code className="font-mono">app_data/projects</code>
                  .
                </AlertDialogDescription>
              </AlertDialogHeader>
              <div className="grid gap-2">
                <Label htmlFor="confirm-delete" className="font-normal">
                  Type <span className="font-mono font-semibold">{CONFIRM_WORD}</span> to confirm
                </Label>
                <Input
                  id="confirm-delete"
                  autoFocus
                  autoComplete="off"
                  spellCheck={false}
                  value={typed}
                  onChange={(e) => setTyped(e.target.value)}
                  placeholder={CONFIRM_WORD}
                  className="font-mono"
                />
              </div>
              <AlertDialogFooter>
                <AlertDialogCancel type="button" disabled={remove.isPending}>
                  Cancel
                </AlertDialogCancel>
                <Button
                  type="submit"
                  disabled={!confirmed || remove.isPending}
                  className="bg-destructive text-white hover:bg-destructive/90 dark:bg-destructive/90 dark:hover:bg-destructive"
                >
                  {remove.isPending && <Spinner />} Confirm
                </Button>
              </AlertDialogFooter>
            </form>
          </AlertDialogContent>
        </AlertDialog>
      </CardContent>
    </Card>
  );
}
