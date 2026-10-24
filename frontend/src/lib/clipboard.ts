import { toast } from "sonner";

export async function copyText(text: string, label = "Copied to clipboard") {
  try {
    await navigator.clipboard.writeText(text);
    toast.success(label, { duration: 1500 });
  } catch {
    toast.error("Couldn't access the clipboard", { description: text });
  }
}
