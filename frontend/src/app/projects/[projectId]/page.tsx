import { Suspense } from "react";

import { AnnotateWorkspace, WorkspaceSkeleton } from "@/components/annotate/workspace";

export const metadata = { title: "Annotate" };

export default function AnnotatePage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton />}>
      <AnnotateWorkspace />
    </Suspense>
  );
}
