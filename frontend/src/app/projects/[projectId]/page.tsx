import { Suspense } from "react";

import { AnnotateWorkspace, WorkspaceSkeleton } from "@/components/annotate/workspace";

// Sign-in happens in the browser (AuthGate), so the server never renders signed-in pages and
// instant-navigation validation can't check them.
export const instant = false;

export const metadata = { title: "Annotate" };

export default function AnnotatePage() {
  return (
    <Suspense fallback={<WorkspaceSkeleton />}>
      <AnnotateWorkspace />
    </Suspense>
  );
}
