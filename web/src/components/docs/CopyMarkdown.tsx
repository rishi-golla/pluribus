"use client";

import { Check, Copy } from "lucide-react";
import { useEffect, useState } from "react";

/** Puts text on the clipboard, falling back to a hidden text area where the Clipboard API is missing or refused (plain http) */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = Object.assign(document.createElement("textarea"), { value: text, readOnly: true });
    area.style.cssText = "position:fixed;top:0;left:0;opacity:0";
    document.body.append(area);
    area.focus();
    area.setSelectionRange(0, text.length);
    const ok = document.execCommand("copy");
    area.remove();
    return ok;
  }
}

/** Copies a guide's own markdown, as it is in the repository, so it can be pasted into an editor or a chat */
export function CopyMarkdown({ markdown }: { markdown: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  useEffect(() => {
    if (state === "idle") return;
    const t = setTimeout(() => setState("idle"), 2000);
    return () => clearTimeout(t);
  }, [state]);
  return (
    <button
      type="button"
      onClick={async () => setState((await copyText(markdown)) ? "copied" : "failed")}
      title="Copy this page as Markdown"
      className="inline-flex h-9 shrink-0 cursor-pointer items-center gap-2 rounded-lg border border-line-2 bg-s2 px-3 text-[13px] font-medium text-t2 transition-colors hover:bg-s3 hover:text-t1"
    >
      {state === "copied" ? <Check size={15} strokeWidth={2} className="text-brand" /> : <Copy size={15} strokeWidth={1.75} />}
      <span aria-live="polite">{state === "copied" ? "Copied" : state === "failed" ? "Failed" : "Copy"}</span>
    </button>
  );
}
