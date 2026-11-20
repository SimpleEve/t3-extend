import { createPortal } from "react-dom";

import { Button } from "../../components/ui/button";
import { useT } from "../../hooks/useT";

// fork: shown over the app while the Settings modal is hidden for picking a color, first asking
// for a click and then saying where the picked color is used. It carries
// `data-theme-editor-panel`, which `themeInspector.ts` skips, and lets clicks through except on
// its own button.
export function PickHint({
  phase,
  label,
  onBack,
}: {
  phase: "picking" | "showing";
  label: string;
  onBack: () => void;
}) {
  const t = useT();
  return createPortal(
    <div
      className="pointer-events-none fixed inset-x-0 top-4 z-[70] flex justify-center px-4"
      data-theme-editor-panel
      role="status"
    >
      <div className="flex items-center gap-3 rounded-lg border border-border bg-popover px-3 py-1.5 text-sm text-popover-foreground shadow-lg">
        <p>
          {phase === "picking"
            ? t("Click an area of the app to pick its color. Esc cancels.")
            : t("Highlighting where “{label}” is used. Click anywhere or press Esc to go back.", {
                label,
              })}
        </p>
        {phase === "showing" ? (
          <div className="pointer-events-auto">
            <Button size="xs" variant="outline" onClick={onBack}>
              {t("Back to Settings")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>,
    document.body,
  );
}
