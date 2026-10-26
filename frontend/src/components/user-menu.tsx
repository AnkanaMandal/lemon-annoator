"use client";

import { LogOut, User } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { signOut, useAuth } from "@/lib/supabase";

export function UserMenu() {
  const auth = useAuth();
  if (auth.status !== "signed-in") return null;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="ghost" aria-label="Account" className="size-10 rounded-lg p-0">
          <span className="grid size-7 place-items-center rounded-full bg-muted text-xs font-semibold uppercase">
            {auth.name.slice(0, 1) || <User className="size-4" />}
          </span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-56">
        <DropdownMenuLabel className="grid font-normal">
          <span className="truncate font-medium">{auth.name}</span>
          <span className="truncate text-xs text-muted-foreground">{auth.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem onSelect={() => void signOut()}>
          <LogOut /> Sign out
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
