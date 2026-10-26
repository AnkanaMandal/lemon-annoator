import { Citrus } from "lucide-react";
import Link from "next/link";

import { ThemeToggle } from "@/components/theme-toggle";
import { UserMenu } from "@/components/user-menu";
import { cn } from "@/lib/utils";

export const APP_NAME = "Lemon";

export function Logo({ className }: { className?: string }) {
  return (
    <Link href="/" className={cn("flex items-center gap-2.5 font-semibold tracking-tight", className)}>
      <span className="grid size-9 place-items-center rounded-xl bg-yellow-300 text-yellow-950 shadow-sm ring-1 ring-yellow-500/40 ring-inset">
        <Citrus className="size-5" strokeWidth={2.25} />
      </span>
      <span className="text-lg">{APP_NAME}</span>
    </Link>
  );
}

/** Top bar shared by every page. Children are rendered between the logo and the theme toggle. */
export function AppHeader({ children, actions }: { children?: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-3 border-b border-foreground/12 bg-muted/60 px-4 sm:gap-4 sm:px-6 shadow-[0_1px_2px_0_rgb(0_0_0/0.04)] backdrop-blur supports-[backdrop-filter]:bg-muted/50 dark:border-foreground/10 dark:bg-card/80 dark:shadow-[0_1px_0_0_rgb(0_0_0/0.4)] dark:supports-[backdrop-filter]:bg-card/70">
      <Logo />
      {children && (
        <>
          <span className="hidden text-xl font-light text-muted-foreground/40 select-none sm:inline">/</span>
          <div className="flex min-w-0 flex-1 items-center gap-4">{children}</div>
        </>
      )}
      <div className={cn("flex items-center gap-2.5", !children && "ml-auto")}>
        {actions}
        <ThemeToggle />
        <UserMenu />
      </div>
    </header>
  );
}
