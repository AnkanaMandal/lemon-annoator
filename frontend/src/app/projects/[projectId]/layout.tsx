import { Suspense } from "react";

import { ProjectHeader, ProjectHeaderFallback } from "@/components/project/project-header";

export default function ProjectLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-svh flex-col overflow-hidden">
      <Suspense fallback={<ProjectHeaderFallback />}>
        <ProjectHeader />
      </Suspense>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
