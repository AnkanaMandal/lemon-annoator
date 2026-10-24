"use client";

import { useState } from "react";
import { toast } from "sonner";

import { Field } from "@/components/settings/storage-form";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import { useUpdateProject } from "@/hooks/queries";
import { errorMessage } from "@/lib/api";
import type { Project } from "@/lib/types";

const FPS_PRESETS = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60, 120];

function fromProject(p: Project) {
  return {
    name: p.name,
    description: p.description,
    fps: String(p.settings.fps),
    skip_seconds: String(p.settings.skip_seconds),
    url_expiry_minutes: String(Math.round(p.settings.url_expiry_seconds / 60)),
  };
}

export function GeneralSettings({ project }: { project: Project }) {
  const [form, setForm] = useState(() => fromProject(project));
  const [baseline, setBaseline] = useState(form);
  const update = useUpdateProject(project.id);
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline);

  const fps = Number(form.fps);
  const skip = Number(form.skip_seconds);
  const expiry = Number(form.url_expiry_minutes);
  const invalid =
    !form.name.trim() || !(fps > 0 && fps <= 240) || !(skip > 0 && skip <= 600) || !(expiry >= 5 && expiry <= 720);

  const save = () =>
    update.mutate(
      {
        name: form.name.trim(),
        description: form.description,
        settings: {
          fps,
          skip_seconds: skip,
          url_expiry_seconds: Math.round(expiry * 60),
        },
      },
      {
        onSuccess: (p) => {
          const next = fromProject(p);
          setForm(next);
          setBaseline(next);
          toast.success("Project settings saved");
        },
        onError: (err) => {
          const { title, hint } = errorMessage(err);
          toast.error(title, { description: hint ?? undefined });
        },
      },
    );

  const set = (patch: Partial<typeof form>) => setForm((f) => ({ ...f, ...patch }));

  return (
    <Card>
      <CardHeader>
        <CardTitle>General</CardTitle>
        <CardDescription>Project details and player behaviour.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 sm:grid-cols-2">
        <Field label="Project name" htmlFor="name">
          <Input id="name" value={form.name} maxLength={100} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="Frame rate (FPS)" htmlFor="fps" hint="Used for frame stepping and frame numbers in the export.">
          <Input
            id="fps"
            list="fps-presets"
            inputMode="decimal"
            value={form.fps}
            onChange={(e) => set({ fps: e.target.value })}
            aria-invalid={!(fps > 0 && fps <= 240)}
          />
          <datalist id="fps-presets">
            {FPS_PRESETS.map((f) => (
              <option key={f} value={f} />
            ))}
          </datalist>
        </Field>
        <div className="sm:col-span-2">
          <Field label="Description" htmlFor="description">
            <Textarea
              id="description"
              rows={2}
              maxLength={500}
              value={form.description}
              onChange={(e) => set({ description: e.target.value })}
            />
          </Field>
        </div>
        <Field label="Skip interval (seconds)" htmlFor="skip" hint="J / L jump backward / forward by this amount.">
          <Input
            id="skip"
            inputMode="decimal"
            value={form.skip_seconds}
            onChange={(e) => set({ skip_seconds: e.target.value })}
            aria-invalid={!(skip > 0 && skip <= 600)}
          />
        </Field>
        <Field
          label="Presigned URL lifetime (minutes)"
          htmlFor="expiry"
          hint="5–720. URLs refresh automatically when they expire."
        >
          <Input
            id="expiry"
            inputMode="numeric"
            value={form.url_expiry_minutes}
            onChange={(e) => set({ url_expiry_minutes: e.target.value })}
            aria-invalid={!(expiry >= 5 && expiry <= 720)}
          />
        </Field>
        <p className="text-xs text-muted-foreground sm:col-span-2">
          The queue includes every <code className="font-mono">.mp4</code> and <code className="font-mono">.mov</code>{" "}
          file under the folder prefix, including sub-folders.
        </p>
      </CardContent>
      <CardFooter className="justify-end border-t">
        <Button onClick={save} disabled={!dirty || invalid || update.isPending}>
          {update.isPending && <Spinner />} Save settings
        </Button>
      </CardFooter>
    </Card>
  );
}
