"use client";

import { xml } from "@codemirror/lang-xml";
import { EditorView } from "@codemirror/view";
import { useTheme } from "next-themes";
import dynamic from "next/dynamic";
import { useMemo } from "react";

import { Skeleton } from "@/components/ui/skeleton";

// CodeMirror touches the DOM on import; load it in the browser only.
const CodeMirror = dynamic(() => import("@uiw/react-codemirror"), {
  ssr: false,
  loading: () => <Skeleton className="h-[440px] rounded-lg" />,
});

const appearance = EditorView.theme({
  "&": { fontSize: "13px", backgroundColor: "transparent" },
  ".cm-scroller": { fontFamily: "var(--font-geist-mono), ui-monospace, monospace", lineHeight: "1.6" },
  ".cm-gutters": { backgroundColor: "transparent", borderRight: "1px solid var(--border)" },
  "&.cm-focused": { outline: "none" },
});

export function LabelConfigEditor({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
}) {
  const { resolvedTheme } = useTheme();
  const extensions = useMemo(() => [xml(), appearance, EditorView.lineWrapping], []);

  return (
    <div className="overflow-hidden rounded-lg border bg-muted/20 focus-within:ring-3 focus-within:ring-ring/50">
      <CodeMirror
        value={value}
        onChange={onChange}
        height="440px"
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        extensions={extensions}
        placeholder={placeholder}
        basicSetup={{ foldGutter: true, highlightActiveLine: true, autocompletion: false }}
        aria-label="Label config XML"
      />
    </div>
  );
}
