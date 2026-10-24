"use client";

import { Clapperboard, Settings2 } from "lucide-react";
import Link from "next/link";
import { useParams, usePathname } from "next/navigation";

import { AppHeader } from "@/components/app-header";
import { ExportButton } from "@/components/project/export-button";
import { Skeleton } from "@/components/ui/skeleton";
import { useProject } from "@/hooks/queries";
import { useHydrated } from "@/hooks/use-hydrated";
import { cn } from "@/lib/utils";

export function ProjectHeader() {
  const { projectId } = useParams<{ projectId: string }>();
  const pathname = usePathname();
  const hydrated = useHydrated();
  const projectQ = useProject(projectId);
  const project = hydrated ? projectQ.data : undefined; // match the server HTML during hydration

  const tabs = [
    { href: `/projects/${projectId}`, label: "Annotate", icon: Clapperboard },
    { href: `/projects/${projectId}/settings`, label: "Settings", icon: Settings2 },
  ];

  return (
    <AppHeader actions={<ExportButton projectId={projectId} />}>
      {project ? (
        <span className="hidden max-w-[20rem] truncate text-base font-medium sm:inline">{project.name}</span>
      ) : (
        <Skeleton className="hidden h-5 w-32 sm:block" />
      )}
      <nav className="flex shrink-0 items-center gap-1 sm:ml-2">
        {tabs.map(({ href, label, icon: Icon }) => {
          const active = pathname === href;
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex h-10 items-center gap-2 rounded-lg px-3.5 text-[15px] transition-colors",
                active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
              )}
            >
              <Icon className="size-[18px]" />
              <span className="hidden sm:inline">{label}</span>
            </Link>
          );
        })}
      </nav>
    </AppHeader>
  );
}

export function ProjectHeaderFallback() {
  return (
    <header className="flex h-16 shrink-0 items-center gap-4 border-b px-6">
      <Skeleton className="h-9 w-28" />
      <Skeleton className="h-4 w-40" />
    </header>
  );
}
