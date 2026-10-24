"use client";

import { ArrowUpRight, CalendarDays, CloudOff, FolderKanban, Plus, Tags } from "lucide-react";
import Link from "next/link";

import { AppHeader } from "@/components/app-header";
import { CreateProjectDialog } from "@/components/dashboard/create-project-dialog";
import { ErrorState } from "@/components/error-state";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyContent, EmptyDescription, EmptyHeader, EmptyMedia, EmptyTitle } from "@/components/ui/empty";
import { Progress } from "@/components/ui/progress";
import { Skeleton } from "@/components/ui/skeleton";
import { useProjects } from "@/hooks/queries";
import { useHydrated } from "@/hooks/use-hydrated";
import { formatDate, formatRelative } from "@/lib/format";
import type { Project } from "@/lib/types";

export function Dashboard() {
  const hydrated = useHydrated();
  const projectsQ = useProjects();
  // Render data only after hydration so the first client render matches the server HTML.
  const projects = hydrated ? projectsQ.data : undefined;
  const isPending = !hydrated || projectsQ.isPending;
  const { error, refetch } = projectsQ;

  return (
    <div className="flex min-h-svh flex-col">
      <AppHeader />
      <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-10 sm:px-6">
        <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Each project streams one S3 folder and has its own label schema.
            </p>
          </div>
          {projects && projects.length > 0 && <CreateProjectDialog />}
        </div>

        {!isPending && error && !projects ? (
          <div className="rounded-xl border">
            <ErrorState error={error} onRetry={() => refetch()} />
          </div>
        ) : isPending || !projects ? (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-44 rounded-xl" />
            ))}
          </div>
        ) : projects.length === 0 ? (
          <Empty className="border py-20">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderKanban />
              </EmptyMedia>
              <EmptyTitle>No projects yet</EmptyTitle>
              <EmptyDescription>
                Create a project, connect an S3 bucket folder, define your labels and start annotating.
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <CreateProjectDialog
                trigger={
                  <Button>
                    <Plus /> Create New Project
                  </Button>
                }
              />
            </EmptyContent>
          </Empty>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {projects.map((p) => (
              <ProjectCard key={p.id} project={p} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
}

function ProjectCard({ project }: { project: Project }) {
  const { storage, stats, last_sync, label_schema } = project;
  const total = last_sync?.video_count ?? 0;
  // Annotations can outlive videos removed from the bucket; never show more than the bucket holds.
  const completed = Math.min(stats.completed, total);
  const pct = total ? Math.round((completed / total) * 100) : 0;
  const href = storage.is_configured ? `/projects/${project.id}` : `/projects/${project.id}/settings`;

  return (
    <Link
      href={href}
      className="group relative flex flex-col gap-4 rounded-xl border bg-card p-5 transition-colors hover:border-foreground/20 hover:bg-muted/30 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="truncate font-medium">{project.name}</h2>
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {project.description || `Updated ${formatRelative(project.updated_at)}`}
          </p>
        </div>
        <ArrowUpRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5 group-hover:-translate-y-0.5" />
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <CalendarDays className="size-3.5 shrink-0" />
          Created {formatDate(project.created_at)}
        </span>
        {!storage.is_configured && (
          <Badge variant="outline" className="text-amber-600 dark:text-amber-400">
            <CloudOff /> Storage not configured
          </Badge>
        )}
      </div>

      <div className="mt-auto space-y-2">
        <div className="flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">
            {last_sync ? (
              <>
                <span className="font-medium text-foreground tabular-nums">{completed}</span> / {total} completed
                {stats.in_progress > 0 && ` · ${stats.in_progress} in progress`}
              </>
            ) : storage.is_configured ? (
              "Not scanned yet — open to load the queue"
            ) : (
              "Add a bucket to get started"
            )}
          </span>
          {total > 0 && <span className="tabular-nums text-muted-foreground">{pct}%</span>}
        </div>
        <Progress
          value={pct}
          aria-label={`${pct}% completed`}
          className="h-1.5 bg-neutral-200 dark:bg-white [&_[data-slot=progress-indicator]]:bg-emerald-500"
        />
        <div className="flex items-center gap-3 pt-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Tags className="size-3.5" />
            {label_schema.event_types.length} types · {label_schema.fields.length} attributes
          </span>
          <span className="ml-auto tabular-nums">{stats.total_events} events</span>
        </div>
      </div>
    </Link>
  );
}
