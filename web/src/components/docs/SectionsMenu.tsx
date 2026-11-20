"use client";

import { useSyncExternalStore } from "react";
import BranchedMenu, { type BranchedMenuItem } from "./BranchedMenu";

const onHash = (notify: () => void) => {
  window.addEventListener("hashchange", notify);
  return () => window.removeEventListener("hashchange", notify);
};

/** A guide's sections as a branched menu. The address bar's hash is the selection, so links and the back button move it too */
export function SectionsMenu({ items }: { items: BranchedMenuItem[] }) {
  const hash = useSyncExternalStore(
    onHash,
    () => decodeURIComponent(window.location.hash.slice(1)),
    () => "",
  );
  const known = items.some((it) => it.value === hash || it.children?.some((kid) => kid.value === hash));
  return (
    <BranchedMenu
      items={items}
      defaultOpen={items.findIndex((it) => it.children)}
      active={known ? hash : (items[0]?.value ?? "")}
      onSelect={(id) => {
        window.location.hash = id;
      }}
      onToggle={(i, open) => {
        if (open) window.location.hash = items[i].value ?? "";
      }}
      color="var(--color-t1)"
      accentColor="var(--color-brand)"
      lineColor="#2e2e2e"
      width={260}
      rowHeight={32}
      indent={34}
      trunk={10}
      radius={9}
      fontSize={13}
    />
  );
}
