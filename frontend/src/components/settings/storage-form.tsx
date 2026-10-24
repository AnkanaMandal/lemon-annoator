"use client";

import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, ChevronDown, Eye, EyeOff, PlugZap, ShieldAlert, XCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { SyncPanel } from "@/components/settings/sync-panel";
import { Spinner } from "@/components/ui/spinner";
import { useUpdateProject } from "@/hooks/queries";
import { ApiError, api, errorMessage } from "@/lib/api";
import type { ConnectionTestResult, Project, StorageUpdate } from "@/lib/types";
import { cn } from "@/lib/utils";

const REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "ca-central-1",
  "sa-east-1",
  "eu-west-1",
  "eu-west-2",
  "eu-west-3",
  "eu-central-1",
  "eu-north-1",
  "eu-south-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ap-northeast-2",
  "ap-east-1",
  "me-south-1",
  "af-south-1",
];

interface FormState {
  bucket: string;
  prefix: string;
  region: string;
  access_key_id: string;
  secret_access_key: string;
  session_token: string;
  endpoint_url: string;
}

function fromProject(p: Project): FormState {
  return {
    bucket: p.storage.bucket,
    prefix: p.storage.prefix,
    region: p.storage.region,
    access_key_id: p.storage.access_key_id,
    secret_access_key: "",
    session_token: "",
    endpoint_url: p.storage.endpoint_url,
  };
}

export function StorageForm({ project }: { project: Project }) {
  const [form, setForm] = useState<FormState>(() => fromProject(project));
  const [baseline, setBaseline] = useState<FormState>(() => fromProject(project));
  const [clearSecret, setClearSecret] = useState(false);
  const [showSecret, setShowSecret] = useState(false);
  const [advanced, setAdvanced] = useState(Boolean(project.storage.endpoint_url || project.storage.has_session_token));
  const [testResult, setTestResult] = useState<{ ok: ConnectionTestResult } | { error: unknown } | null>(null);
  const update = useUpdateProject(project.id);

  const hasSecret = project.storage.has_secret_access_key && !clearSecret;
  const dirty = JSON.stringify(form) !== JSON.stringify(baseline) || clearSecret;

  const set = (patch: Partial<FormState>) => {
    setForm((f) => ({ ...f, ...patch }));
    setTestResult(null);
  };

  /** Accepts "s3://bucket/some/prefix" pasted into the bucket field. */
  const onBucketChange = (value: string) => {
    const m = value.trim().match(/^s3:\/\/([^/]+)\/?(.*)$/i);
    if (m) set({ bucket: m[1], prefix: m[2] || form.prefix });
    else set({ bucket: value.trim() });
  };

  const payload = (): StorageUpdate => {
    const body: StorageUpdate = {
      bucket: form.bucket,
      prefix: form.prefix,
      region: form.region,
      access_key_id: form.access_key_id,
      endpoint_url: form.endpoint_url,
    };
    if (form.secret_access_key) body.secret_access_key = form.secret_access_key.trim();
    else if (clearSecret) body.secret_access_key = "";
    if (form.session_token) body.session_token = form.session_token.trim();
    return body;
  };

  const tester = useMutation({
    mutationFn: () => api.testStorage(project.id, payload()),
    onSuccess: (ok) => setTestResult({ ok }),
    onError: (error) => setTestResult({ error }),
  });

  const save = () =>
    update.mutate(
      { storage: payload() },
      {
        onSuccess: (p) => {
          const next = fromProject(p);
          setForm(next);
          setBaseline(next);
          setClearSecret(false);
          toast.success("Storage settings saved");
        },
        onError: (err) => {
          const { title, hint } = errorMessage(err);
          toast.error(title, { description: hint ?? undefined });
        },
      },
    );

  const detectedRegion =
    testResult && "error" in testResult && testResult.error instanceof ApiError
      ? (testResult.error.details.detected_region as string | undefined)
      : undefined;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Cloud storage</CardTitle>
        <CardDescription>
          Videos are streamed straight from S3 with short-lived presigned URLs. Nothing is downloaded to this machine.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid grid-cols-1 gap-5">
        <SyncPanel project={project} unsavedChanges={dirty} />
        <SectionLabel className="mt-2">Location</SectionLabel>
        <div className="-mt-2 grid gap-4 sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,0.8fr)]">
          <Field label="Bucket name" htmlFor="bucket" hint="Paste s3://bucket/folder to fill both fields.">
            <Input
              id="bucket"
              placeholder="my-video-bucket"
              value={form.bucket}
              onChange={(e) => onBucketChange(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <Field label="Folder prefix" htmlFor="prefix" hint="Leave empty to scan the whole bucket.">
            <Input
              id="prefix"
              placeholder="videos/2024/"
              value={form.prefix}
              onChange={(e) => set({ prefix: e.target.value })}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <Field label="Region" htmlFor="region" hint="e.g. us-east-1">
            <Input
              id="region"
              list="aws-regions"
              placeholder="us-east-1"
              value={form.region}
              onChange={(e) => set({ region: e.target.value.trim() })}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
            <datalist id="aws-regions">
              {REGIONS.map((r) => (
                <option key={r} value={r} />
              ))}
            </datalist>
          </Field>
        </div>

        <SectionLabel>Credentials</SectionLabel>
        <div className="-mt-2 grid gap-4 sm:grid-cols-2">
          <Field label="Access Key ID" htmlFor="akid" hint="Leave both keys empty to use your local AWS profile.">
            <Input
              id="akid"
              placeholder="AKIA…"
              value={form.access_key_id}
              onChange={(e) => set({ access_key_id: e.target.value.trim() })}
              autoComplete="off"
              spellCheck={false}
              className="font-mono"
            />
          </Field>
          <Field
            label="Secret Access Key"
            htmlFor="secret"
            hint={
              hasSecret ? (
                <>
                  Saved. Leave blank to keep it ·{" "}
                  <button type="button" className="underline underline-offset-2" onClick={() => setClearSecret(true)}>
                    clear
                  </button>
                </>
              ) : clearSecret ? (
                "Will be cleared on save."
              ) : undefined
            }
          >
            <div className="relative">
              <Input
                id="secret"
                type={showSecret ? "text" : "password"}
                placeholder={hasSecret ? "••••••••••••••••" : "wJalrXUtnFEMI/…"}
                value={form.secret_access_key}
                onChange={(e) => set({ secret_access_key: e.target.value })}
                autoComplete="new-password"
                spellCheck={false}
                className="pr-9 font-mono"
              />
              <button
                type="button"
                onClick={() => setShowSecret((s) => !s)}
                className="absolute inset-y-0 right-0 grid w-9 place-items-center text-muted-foreground hover:text-foreground"
                aria-label={showSecret ? "Hide secret" : "Show secret"}
              >
                {showSecret ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>
        </div>

        <button
          type="button"
          className="flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
          onClick={() => setAdvanced((a) => !a)}
        >
          <ChevronDown className={cn("size-3.5 transition-transform", advanced && "rotate-180")} />
          Advanced
        </button>
        {advanced && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Session token"
              htmlFor="token"
              hint={
                project.storage.has_session_token
                  ? "Saved. Leave blank to keep it."
                  : "Only for temporary (STS) credentials."
              }
            >
              <Input
                id="token"
                type="password"
                value={form.session_token}
                onChange={(e) => set({ session_token: e.target.value })}
                autoComplete="off"
                className="font-mono"
              />
            </Field>
            <Field
              label="Custom endpoint URL"
              htmlFor="endpoint"
              hint="For S3-compatible stores: MinIO, Cloudflare R2, Wasabi…"
            >
              <Input
                id="endpoint"
                placeholder="https://<account>.r2.cloudflarestorage.com"
                value={form.endpoint_url}
                onChange={(e) => set({ endpoint_url: e.target.value.trim() })}
                autoComplete="off"
                spellCheck={false}
                className="font-mono"
              />
            </Field>
          </div>
        )}

        {testResult && "ok" in testResult && (
          <Alert className="border-emerald-500/30 bg-emerald-500/5">
            <CheckCircle2 className="text-emerald-600 dark:text-emerald-400" />
            <AlertTitle>
              Connected — {testResult.ok.video_count} video{testResult.ok.video_count === 1 ? "" : "s"} found
              {testResult.ok.truncated && " (listing truncated)"}
            </AlertTitle>
            <AlertDescription className="min-w-0">
              {testResult.ok.sample_keys.length > 0 ? (
                <ul className="mt-1 min-w-0 space-y-0.5 font-mono text-xs">
                  {testResult.ok.sample_keys.map((k) => (
                    <li key={k} className="truncate" title={k}>
                      {k}
                    </li>
                  ))}
                </ul>
              ) : (
                <span>The bucket is reachable but no video files match this prefix.</span>
              )}
            </AlertDescription>
          </Alert>
        )}
        {testResult && "error" in testResult && (
          <Alert variant="destructive" className="border-destructive/30 bg-destructive/5">
            <XCircle />
            <AlertTitle>{errorMessage(testResult.error).title}</AlertTitle>
            <AlertDescription className="min-w-0">
              <p>{errorMessage(testResult.error).hint}</p>
              {detectedRegion && (
                <Button size="xs" variant="outline" className="mt-2" onClick={() => set({ region: detectedRegion })}>
                  Use {detectedRegion}
                </Button>
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="flex gap-2 rounded-lg border border-dashed p-3 text-xs text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <p>
            Keys are stored in plain text in{" "}
            <code className="font-mono">app_data/projects/{project.id}/project.json</code> on this machine and are never
            sent back to the browser. Use an IAM user with read-only access to this bucket.
          </p>
        </div>
      </CardContent>
      <CardFooter className="justify-end gap-2 border-t">
        <Button variant="outline" onClick={() => tester.mutate()} disabled={!form.bucket || tester.isPending}>
          {tester.isPending ? <Spinner /> : <PlugZap />} Test connection
        </Button>
        <Button onClick={save} disabled={!dirty || update.isPending}>
          {update.isPending && <Spinner />} Save storage
        </Button>
      </CardFooter>
    </Card>
  );
}

function SectionLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <h3 className={cn("text-xs font-medium tracking-wide text-muted-foreground uppercase", className)}>{children}</h3>
  );
}

export function Field({
  label,
  htmlFor,
  hint,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="grid min-w-0 grid-cols-1 content-start gap-1.5">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
