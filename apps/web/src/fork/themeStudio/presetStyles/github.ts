import type { ThemePresetSeed } from "../presets";

// fork: GitHub. Colors after the GitHub light and dark themes for VS Code (MIT, GitHub Inc.).
// No decoration: flat panels, hairlines, the system fonts.
const SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

export const GITHUB_SEED: ThemePresetSeed = {
  id: "studio-github",
  label: "GitHub",
  appearance: "light",
  palette: {
    canvas: "#ffffff",
    accent: "#0969da",
    colors: {
      surface: "#ffffff",
      surfaceRaised: "#f6f8fa",
      surfaceOverlay: "#ffffff",
      secondary: "#f6f8fa",
      secondaryForeground: "#1f2328",
      muted: "#f6f8fa",
      accentSurface: "#ddf4ff",
      accentSurfaceForeground: "#0a3069",
      toolbarControl: "#f6f8fa",
      toolbarControlHover: "#eaeef2",
      text: "#1f2328",
      textMuted: "#59636e",
      secondaryLabel: "#59636e",
      mutedForeground: "#59636e",
      border: "#d1d9e0",
      input: "#d1d9e0",
      focus: "#0969da",
      accentForeground: "#ffffff",
      sidebar: "#f6f8fa",
      sidebarForeground: "#1f2328",
      sidebarMutedForeground: "#59636e",
      sidebarBorder: "#d1d9e0",
      codeBackground: "#f6f8fa",
      codeForeground: "#1f2328",
    },
  },
  variant: {
    canvas: "#0d1117",
    accent: "#1f6feb",
    colors: {
      surface: "#0d1117",
      surfaceRaised: "#151b23",
      surfaceOverlay: "#151b23",
      secondary: "#212830",
      secondaryForeground: "#e6edf3",
      muted: "#151b23",
      accentSurface: "#0c2d6b",
      accentSurfaceForeground: "#cae8ff",
      toolbarControl: "#212830",
      toolbarControlHover: "#2a313c",
      text: "#e6edf3",
      textMuted: "#9198a1",
      secondaryLabel: "#959ca5",
      mutedForeground: "#9198a1",
      border: "#3d444d",
      input: "#3d444d",
      focus: "#1f6feb",
      accentForeground: "#ffffff",
      sidebar: "#010409",
      sidebarForeground: "#e6edf3",
      sidebarMutedForeground: "#959ca5",
      sidebarBorder: "#3d444d",
      codeBackground: "#151b23",
      codeForeground: "#e6edf3",
    },
  },
  look: { fontUi: SANS, fontCode: MONO, radius: 6, shadow: 20, density: 100 },
};
