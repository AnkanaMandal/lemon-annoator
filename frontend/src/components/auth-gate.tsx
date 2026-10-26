"use client";

import { useQueryClient } from "@tanstack/react-query";
import { KeyRound } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Logo } from "@/components/app-header";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ui/spinner";
import { supabase, useAuth } from "@/lib/supabase";

/** Shows the sign-in screen until a Supabase session exists, then the app. */
export function AuthGate({ children }: { children: React.ReactNode }) {
  const auth = useAuth();
  const qc = useQueryClient();

  // Another account's cached data must never show after signing out or switching user.
  const userId = auth.status === "signed-in" ? auth.userId : null;
  const lastUser = useRef(userId);
  useEffect(() => {
    if (lastUser.current && lastUser.current !== userId) qc.clear();
    lastUser.current = userId;
  }, [userId, qc]);

  if (auth.status === "loading") {
    return (
      <div className="grid min-h-svh place-items-center">
        <Spinner className="size-6 text-muted-foreground" />
      </div>
    );
  }
  if (auth.status === "unconfigured") return <NotConfigured />;
  if (auth.status === "signed-out") return <SignIn />;
  return children;
}

function Screen({ children }: { children: React.ReactNode }) {
  return (
    <main className="flex min-h-svh flex-col items-center justify-center gap-8 px-4 py-10">
      <Logo />
      <Card className="w-full max-w-sm">{children}</Card>
    </main>
  );
}

function SignIn() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending(true);
    setError(null);
    const { error } = await supabase().auth.signInWithPassword({ email: email.trim(), password });
    // On success the auth state changes and this screen is replaced by the app.
    if (error) {
      setError(error.message);
      setPending(false);
    }
  };

  return (
    <Screen>
      <CardHeader>
        <CardTitle>Sign in</CardTitle>
        <CardDescription>Use the account the project owner created for you.</CardDescription>
      </CardHeader>
      <CardContent>
        <form className="grid gap-4" onSubmit={submit}>
          <div className="grid gap-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="password">Password</Label>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" disabled={pending || !email.trim() || !password}>
            {pending ? <Spinner /> : <KeyRound />} Sign in
          </Button>
        </form>
      </CardContent>
    </Screen>
  );
}

function NotConfigured() {
  return (
    <Screen>
      <CardHeader>
        <CardTitle>Sign-in is not configured</CardTitle>
      </CardHeader>
      <CardContent>
        <Alert>
          <AlertTitle>Missing Supabase settings</AlertTitle>
          <AlertDescription>
            <p>
              Set <code className="font-mono">NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
              <code className="font-mono">NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY</code> in{" "}
              <code className="font-mono">frontend/.env.local</code> (or in Vercel), then restart or redeploy.
            </p>
          </AlertDescription>
        </Alert>
      </CardContent>
    </Screen>
  );
}
