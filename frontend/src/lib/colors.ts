// Distinct hues that read well on both light and dark backgrounds.
const PALETTE = [
  "#3b82f6",
  "#f59e0b",
  "#10b981",
  "#ef4444",
  "#8b5cf6",
  "#ec4899",
  "#14b8a6",
  "#f97316",
  "#84cc16",
  "#06b6d4",
];

export const UNLABELED_COLOR = "#a1a1aa";

export function eventColor(eventName: string | null, eventTypes: string[]): string {
  if (!eventName) return UNLABELED_COLOR;
  const i = eventTypes.indexOf(eventName);
  if (i >= 0) return PALETTE[i % PALETTE.length];
  // Type removed from the schema: stable hash so it keeps a colour.
  let h = 0;
  for (const c of eventName) h = (h * 31 + c.charCodeAt(0)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length];
}
