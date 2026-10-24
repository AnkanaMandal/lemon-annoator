import { Suspense } from "react";

import { SettingsSkeleton, SettingsView } from "@/components/settings/settings-view";

export const metadata = { title: "Settings" };

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <div className="mx-auto flex w-full max-w-6xl gap-10 px-4 py-8 sm:px-6">
          <div className="hidden w-56 shrink-0 md:block" />
          <div className="min-w-0 flex-1">
            <SettingsSkeleton />
          </div>
        </div>
      }
    >
      <SettingsView />
    </Suspense>
  );
}
