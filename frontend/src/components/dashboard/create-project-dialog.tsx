"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { keys } from "@/hooks/queries";
import { api, errorMessage } from "@/lib/api";

export function CreateProjectDialog({ trigger }: { trigger?: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const router = useRouter();
  const qc = useQueryClient();

  const create = useMutation({
    mutationFn: () => api.createProject({ name: name.trim(), description: description.trim() }),
    onSuccess: (project) => {
      qc.invalidateQueries({ queryKey: keys.projects });
      toast.success(`Created “${project.name}”`, { description: "Connect your S3 bucket to get started." });
      setOpen(false);
      setName("");
      setDescription("");
      router.push(`/projects/${project.id}/settings`);
    },
    onError: (err) => {
      const { title, hint } = errorMessage(err);
      toast.error(title, { description: hint ?? undefined });
    },
  });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        {trigger ?? (
          <Button>
            <Plus /> Create New Project
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (name.trim()) create.mutate();
          }}
        >
          <DialogHeader>
            <DialogTitle>Create project</DialogTitle>
            <DialogDescription>A project points at one S3 folder and has its own label schema.</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="project-name">Name</Label>
            <Input
              id="project-name"
              autoFocus
              placeholder="e.g. Badminton rallies — Q3"
              value={name}
              maxLength={100}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="project-description">
              Description <span className="font-normal text-muted-foreground">(optional)</span>
            </Label>
            <Textarea
              id="project-description"
              rows={3}
              maxLength={500}
              placeholder="What is being labeled and why?"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || create.isPending}>
              {create.isPending && <Spinner />} Create project
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
