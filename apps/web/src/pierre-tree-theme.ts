import type { CSSProperties, PointerEvent } from "react";

// Lucide Folder icon, ISC license.
const FOLDER_ICON_MASK =
  "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='black' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z'/%3E%3C/svg%3E";

export const PIERRE_TREE_UNSAFE_CSS = `
  :host {
    --trees-bg-override: transparent;
    --trees-selected-bg-override: color-mix(in srgb, currentColor 12%, transparent);
    --trees-hover-bg-override: color-mix(in srgb, currentColor 7%, transparent);
    --trees-border-color-override: color-mix(in srgb, currentColor 14%, transparent);
    --trees-font-family-override: var(--font-sans);
    --trees-font-size-override: 0.75rem;
  }
  [data-truncate-content='visible'] { overflow: hidden; text-overflow: ellipsis; }
  [data-truncate-marker] { display: none; }
  button[data-type='item'], button[data-type='item']::before { border-radius: var(--radius-md); }
  svg[data-icon-name='t3-tree-icon-loading'] { opacity: 0.6; }
  svg[data-icon-name^='t3-tree-icon-symlink'] { opacity: 0.6; }
  button[data-type='item']:has(svg[data-icon-name='t3-tree-icon-symlink-broken'], svg[data-icon-name='t3-tree-icon-symlink-unresolved']) > [data-item-section='content'] { opacity: 0.6; }
  /* A looping link is a leaf, so Pierre gives it a file icon, and has no per-path override. */
  button[data-type='item']:has(svg[data-icon-name='t3-tree-icon-symlink-cycle']) > [data-item-section='icon'] > * { visibility: hidden; }
  button[data-type='item']:has(svg[data-icon-name='t3-tree-icon-symlink-cycle']) > [data-item-section='icon'] { position: relative; }
  button[data-type='item']:has(svg[data-icon-name='t3-tree-icon-symlink-cycle']) > [data-item-section='icon']::after {
    content: ''; position: absolute; inset: 0; background-color: var(--trees-fg-muted-override, currentColor);
    mask: url("${FOLDER_ICON_MASK}") center / 14px 14px no-repeat;
  }
  @media (prefers-reduced-motion: no-preference) {
    svg[data-icon-name='t3-tree-icon-loading'] { animation: t3-tree-spin 1s linear infinite; }
  }
  @keyframes t3-tree-spin { to { transform: rotate(360deg); } }
`;

export function pierreTreeStyle(colorScheme: "light" | "dark"): CSSProperties {
  return {
    colorScheme,
    ["--trees-fg-override" as string]: "var(--contrast-foreground)",
    ["--trees-fg-muted-override" as string]: "var(--contrast-muted-foreground)",
    ["--trees-status-ignored-override" as string]: "var(--contrast-muted-foreground)",
  };
}

// Clipped labels are unreadable and the tree cannot scroll sideways, so a clipped row gets its full name as a native tooltip.
export function titleClippedPierreTreeRow(event: PointerEvent<HTMLElement>) {
  const row = event.nativeEvent
    .composedPath()
    .find(
      (node): node is HTMLElement =>
        node instanceof HTMLElement && node.matches("button[data-type='item']"),
    );
  if (!row) return;
  const label = row.getAttribute("aria-label");
  const clipped = Array.from(
    row.querySelectorAll<HTMLElement>("[data-truncate-content='visible']"),
  ).some((element) => element.scrollWidth > element.clientWidth);
  if (label && clipped) row.title = label;
  else row.removeAttribute("title");
}
