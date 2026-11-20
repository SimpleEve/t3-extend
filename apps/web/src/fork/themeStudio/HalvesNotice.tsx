import { useT } from "../../hooks/useT";
import type { useThemeStudio } from "./useThemeStudio";

type Studio = ReturnType<typeof useThemeStudio>;

/** Picking a whole theme replaces a light and dark pair, so say so before it happens. */
export function HalvesNotice({ studio }: { studio: Studio }) {
  const t = useT();
  if (!studio.halvesInUse) return null;
  return (
    <p className="text-xs text-muted-foreground" data-theme-halves-notice>
      {studio.resolvedTheme === "dark"
        ? t(
            "Light and dark use different themes. Picking or resetting a theme here replaces both. Editing changes only the dark theme.",
          )
        : t(
            "Light and dark use different themes. Picking or resetting a theme here replaces both. Editing changes only the light theme.",
          )}
    </p>
  );
}
