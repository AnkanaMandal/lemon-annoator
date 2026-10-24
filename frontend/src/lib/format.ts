/** 83.4567 -> "01:23.457" (or "1:01:23.457" past an hour). */
export function formatTime(seconds: number, opts: { ms?: boolean } = {}): string {
  const { ms = true } = opts;
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const totalMs = Math.round(seconds * 1000);
  const h = Math.floor(totalMs / 3_600_000);
  const m = Math.floor((totalMs % 3_600_000) / 60_000);
  const s = Math.floor((totalMs % 60_000) / 1000);
  const msPart = String(totalMs % 1000).padStart(3, "0");
  const base = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  const withH = h > 0 ? `${h}:${base}` : base;
  return ms ? `${withH}.${msPart}` : withH;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null) return "";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = bytes;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(value < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatRelative(iso: string | null | undefined): string {
  if (!iso) return "never";
  const diff = Date.now() - new Date(iso).getTime();
  const sec = Math.round(diff / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 30) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function frameAt(seconds: number, fps: number): number {
  return Math.floor(seconds * fps + 1e-6);
}

export function newId(): string {
  return typeof crypto !== "undefined" && "randomUUID" in crypto
    ? crypto.randomUUID().slice(0, 12)
    : Math.random().toString(36).slice(2, 14);
}

/** "24 Oct 2026" (in the viewer's locale order). */
export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}
