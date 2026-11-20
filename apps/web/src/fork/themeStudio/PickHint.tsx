import { createPortal } from "react-dom";

import { useT } from "../../hooks/useT";

// fork: shown over the app while the Settings modal is hidden for picking a color. It carries
// `data-theme-editor-panel`, which `themeInspector.ts` skips, and lets clicks through.
export function PickHint() {
  const t = useT();
  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 top-4 z-[70] flex justify-center px-4"
      data-theme-editor-panel
      role="status"
    >
      <p className="rounded-lg border border-border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-lg">
        {t("Click an area of the app to pick its color. Esc cancels.")}
      </p>
    </div>,
    document.body,
  );
}
