import { createFileRoute } from "@tanstack/react-router";

import { ThemeStudioPanel } from "../fork/themeStudio/ThemeStudioPanel"; // fork: theme studio

function SettingsThemeRoute() {
  return <ThemeStudioPanel />;
}

export const Route = createFileRoute("/_chat/settings/theme")({
  component: SettingsThemeRoute,
});
