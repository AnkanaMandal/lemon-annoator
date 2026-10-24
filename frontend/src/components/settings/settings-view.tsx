"use client";

import { ArrowRight, CheckCircle2, Cloud, SlidersHorizontal, Tags } from "lucide-react";
import Link from "next/link";
import { useParams, useSearchParams } from "next/navigation";
import { useState } from "react";

import { ErrorState } from "@/components/error-state";
import { DeleteProject } from "@/components/settings/delete-project";
import { GeneralSettings } from "@/components/settings/general-settings";
import { SchemaBuilder } from "@/components/settings/schema-builder";
import { StorageForm } from "@/components/settings/storage-form";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { useProject } from "@/hooks/queries";
import { useHydrated } from "@/hooks/use-hydrated";
import type { Project } from "@/lib/types";
import { cn } from "@/lib/utils";

const SECTIONS = [
  { id: "storage", label: "Cloud storage", icon: Cloud },
  { id: "schema", label: "Label schema", icon: Tags },
  { id: "general", label: "General", icon: SlidersHorizontal },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

const isSection = (v: string | null): v is SectionId => SECTIONS.some((s) => s.id === v);

export function SettingsView() {
  const { projectId } = useParams<{ projectId: string }>();
  const searchParams = useSearchParams();
  const requested = searchParams.get("section");
  const [section, setSection] = useState<SectionId>(isSection(requested) ? requested : "storage");
  const hydrated = useHydrated();
  const projectQ = useProject(projectId);
  // Render data only after hydration so the first client render matches the server HTML.
  const project = hydrated ? projectQ.data : undefined;
  const isPending = !hydrated || projectQ.isPending;
  const { error, refetch } = projectQ;

  const select = (id: SectionId) => {
    setSection(id);
    window.history.replaceState(null, "", `?section=${id}`);
  };

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6 md:flex-row md:gap-10">
        <aside className="shrink-0 md:sticky md:top-8 md:w-56 md:self-start">
          <SettingsNav project={project} active={section} onSelect={select} />
        </aside>

        <main className="min-w-0 flex-1">
          {!project ? (
            !isPending && error ? (
              <Card>
                <ErrorState error={error} onRetry={() => refetch()} />
              </Card>
            ) : (
              <SettingsSkeleton />
            )
          ) : (
            // Every section stays mounted (only hidden) so unsaved edits survive switching sections.
            // Keyed by id so each form initialises its local state once per project.
            <>
              <div hidden={section !== "storage"}>
                <StorageForm key={`storage-${project.id}`} project={project} />
              </div>
              <div hidden={section !== "schema"}>
                <SchemaBuilder key={`schema-${project.id}`} project={project} />
              </div>
              <div hidden={section !== "general"} className="grid gap-6">
                <GeneralSettings key={`general-${project.id}`} project={project} />
                <DeleteProject project={project} />
              </div>
            </>
          )}
        </main>
      </div>
    </div>
  );
}

function SettingsNav({
  project,
  active,
  onSelect,
}: {
  project: Project | undefined;
  active: SectionId;
  onSelect: (id: SectionId) => void;
}) {
  const done: Partial<Record<SectionId, boolean>> = project
    ? {
        storage: project.storage.is_configured,
        schema: project.label_schema.event_types.length + project.label_schema.fields.length > 0,
      }
    : {};

  return (
    <div className="flex flex-col gap-4">
      <h1 className="hidden px-3 text-lg font-semibold tracking-tight md:block">Settings</h1>
      <nav aria-label="Settings sections" className="grid grid-cols-3 gap-1 md:flex md:flex-col">
        {SECTIONS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            type="button"
            onClick={() => onSelect(id)}
            aria-current={active === id ? "page" : undefined}
            className={cn(
              "flex h-9 min-w-0 items-center justify-center gap-2 rounded-md px-2 text-sm transition-colors md:justify-start md:gap-2.5 md:px-3",
              active === id
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground",
            )}
          >
            <Icon className="hidden size-4 shrink-0 md:block" />
            <span className="truncate md:flex-1 md:text-left">{label}</span>
            {done[id] && (
              <CheckCircle2 className="hidden size-3.5 shrink-0 text-emerald-500 md:block" aria-label="Configured" />
            )}
          </button>
        ))}
      </nav>
      {project && (
        <Button
          asChild
          variant={done.storage && done.schema ? "default" : "outline"}
          className="hidden md:inline-flex"
          disabled={!project.storage.is_configured}
        >
          <Link href={`/projects/${project.id}`}>
            Start annotating <ArrowRight />
          </Link>
        </Button>
      )}
    </div>
  );
}

export function SettingsSkeleton() {
  return (
    <div className="grid gap-6">
      <Skeleton className="h-96 rounded-xl" />
      <Skeleton className="h-40 rounded-xl" />
    </div>
  );
}
