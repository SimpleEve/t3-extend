import type { ThemeLook } from "@t3tools/contracts";
import type { ThemeAppearance, ThemeColors } from "@t3tools/shared/themePalettes";

import { BLUEPRINT_SEED } from "./presetStyles/blueprint";
import { BRUTALIST_SEED } from "./presetStyles/brutalist";
import { BROADSHEET_SEED } from "./presetStyles/broadsheet";
import { DOCS_SEED } from "./presetStyles/docs";
import { EDITOR_SEED } from "./presetStyles/editor";
import { GITHUB_SEED } from "./presetStyles/github";
import { MOCHI_SEED } from "./presetStyles/mochi";
import { NORD_SEED } from "./presetStyles/nord";
import { OMP_SEED } from "./presetStyles/omp";
import { ONE_DARK_SEED } from "./presetStyles/onedark";
import { SOLARIZED_SEED } from "./presetStyles/solarized";
import { INKWASH_SEED } from "./presetStyles/inkwash";
import { MANUSCRIPT_SEED } from "./presetStyles/manuscript";
import { NEON_SEED } from "./presetStyles/neon";
import { QUIET_SEED } from "./presetStyles/quiet";
import { RETRO_SEED } from "./presetStyles/retro";
import { SWISS_SEED } from "./presetStyles/swiss";

// fork: presets for the theme studio. They are data only; themePalette.ts builds the palettes.
// Fonts are installed or system names, never loaded from the network. Names and colors are our own.

type PresetPalette = Readonly<{
  canvas: string;
  accent: string;
  /** Roles to set exactly instead of deriving them from canvas and accent. */
  colors?: Partial<ThemeColors>;
}>;

export type ThemePresetSeed = Readonly<{
  id: string;
  label: string;
  appearance: ThemeAppearance;
  palette: PresetPalette;
  /** The other appearance, when the preset has one. */
  variant?: PresetPalette;
  look: ThemeLook;
  css?: string;
  /** Shown on the card: what to expect. */
  needsBackground?: boolean;
}>;

const MONO_STACK =
  '"JetBrains Mono", "SF Mono", "Cascadia Mono", Menlo, "Sarasa Mono SC", "PingFang SC", monospace';

// The colors are the ones of the Terminal theme people already use; the font, square corners and
// flat shadows moved into the look, and the rest stays as CSS.
const TERMINAL_COLORS: ThemeColors = {
  canvas: "#0a0e0b",
  chrome: "#070a08",
  toolbar: "#0a0e0b",
  toolbarForeground: "#b8efc8",
  toolbarBorder: "#1a2a1f",
  toolbarControl: "#0f1712",
  toolbarControlForeground: "#b8efc8",
  toolbarControlHover: "#15211a",
  surface: "#0d1410",
  surfaceRaised: "#0f1712",
  surfaceOverlay: "#0f1813",
  text: "#c6f2d2",
  textMuted: "#6c977a",
  border: "#1f3326",
  input: "#1f3326",
  focus: "#3ee27a",
  accent: "#3ee27a",
  accentForeground: "#03140a",
  secondary: "#111b15",
  secondaryForeground: "#c6f2d2",
  muted: "#0f1712",
  mutedForeground: "#6c977a",
  placeholder: "#4a6b55",
  secondaryLabel: "#7fae8e",
  iconMuted: "#5d8a6b",
  error: "#ff5f56",
  errorForeground: "#ff7b73",
  errorSurface: "#2a0f0d",
  warning: "#ffbd2e",
  warningForeground: "#ffcc5c",
  warningSurface: "#2a2008",
  update: "#3ee27a",
  updateForeground: "#6ff09c",
  updateSurface: "#0e2416",
  accentSurface: "#10201a",
  accentSurfaceForeground: "#c6f2d2",
  messageSurface: "#0d1410",
  messageForeground: "#c6f2d2",
  messageAction: "#3ee27a",
  messageActionForeground: "#03140a",
  messageActionHover: "#33c96a",
  codeBackground: "#070a08",
  codeForeground: "#b8efc8",
  searchMatchBackground: "#3a4a12",
  searchMatchForeground: "#e8ffd0",
  searchMatchActiveBackground: "#ffbd2e",
  searchMatchActiveForeground: "#1a1204",
  sidebar: "#060907",
  sidebarForeground: "#b8efc8",
  sidebarMutedForeground: "#6c977a",
  sidebarControlSurface: "#0a0e0b",
  sidebarRowHover: "#0f1a13",
  sidebarRowActive: "#132218",
  sidebarRowSelected: "#10201a",
  sidebarBorder: "#142219",
  terminalBackground: "#070a08",
  terminalForeground: "#c6f2d2",
  terminalCursor: "#3ee27a",
  terminalSelection: "#1d4a2c",
  terminalScrollbar: "#1a2a1f",
  terminalScrollbarHover: "#2a4433",
};

const TERMINAL_CSS = `:root {
  --term-green: #3ee27a;
  --term-dim: #1f3326;
}

body, button, input, textarea, select {
  font-variant-ligatures: none;
  letter-spacing: 0;
}

::selection { background: #1d4a2c; color: #eafff0; }

[data-message-role="user"] [data-user-message-bubble] {
  background: transparent !important;
  border: 0 !important;
  border-left: 2px solid var(--term-green) !important;
  padding-left: 12px !important;
}
[data-message-role="user"] [data-user-message-bubble]::before {
  content: "user@t3 ~ $";
  display: block;
  color: var(--term-green);
  font-size: 11px;
  margin-bottom: 4px;
  opacity: 0.85;
}

[data-message-role="assistant"] .chat-markdown {
  border-left: 2px solid var(--term-dim);
  padding-left: 12px;
}
.chat-markdown a { color: var(--term-green) !important; text-decoration: underline dotted; }
.chat-markdown h1, .chat-markdown h2, .chat-markdown h3 { color: var(--term-green); }
.chat-markdown h1::before { content: "# "; opacity: 0.6; }
.chat-markdown h2::before { content: "## "; opacity: 0.6; }
.chat-markdown h3::before { content: "### "; opacity: 0.6; }
.chat-markdown-codeblock { border: 1px dashed var(--term-dim) !important; }

[data-slot="composer-host"] {
  border: 1px solid var(--term-dim) !important;
  background: #070a08 !important;
}
[data-slot="composer-host"]:focus-within { border-color: var(--term-green) !important; }
.composer-tiptap { caret-color: var(--term-green); caret-shape: block; }

[data-chat-header] { border-bottom: 1px dashed var(--term-dim) !important; }
[data-thread-item][data-active="true"], [data-thread-item][aria-current="page"] { border-left: 2px solid var(--term-green); }

[data-slot="button"] { text-transform: lowercase; }
[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"] { border: 1px solid var(--term-green) !important; }

[data-workspace-area="conversation"] {
  background-image: repeating-linear-gradient(0deg, rgba(62, 226, 122, 0.018) 0 1px, transparent 1px 3px);
}

::-webkit-scrollbar { width: 8px; height: 8px; }
::-webkit-scrollbar-thumb { background: #1f3326; }
::-webkit-scrollbar-thumb:hover { background: #2f5a3d; }

svg.lucide { stroke-width: 1.5; stroke-linecap: square; stroke-linejoin: miter; }
`;

/** Presets that were removed. A stored choice of one of them is dropped; a scheme made from one keeps working. */
export const RETIRED_PRESET_IDS: ReadonlySet<string> = new Set([
  "studio-oled",
  "studio-paper",
  "studio-fjord",
  "studio-tide",
  "studio-clay",
  "studio-graphite",
  "studio-frosted",
  "studio-compact",
]);

export const THEME_PRESET_SEEDS: ReadonlyArray<ThemePresetSeed> = [
  {
    id: "studio-terminal",
    label: "Terminal",
    appearance: "dark",
    palette: { canvas: "#0a0e0b", accent: "#3ee27a", colors: TERMINAL_COLORS },
    look: {
      fontUi: MONO_STACK,
      fontCode: MONO_STACK,
      radius: 0,
      shadow: 0,
      density: 95,
    },
    css: TERMINAL_CSS,
  },
  BROADSHEET_SEED,
  SWISS_SEED,
  BRUTALIST_SEED,
  BLUEPRINT_SEED,
  MANUSCRIPT_SEED,
  RETRO_SEED,
  INKWASH_SEED,
  NEON_SEED,
  DOCS_SEED,
  QUIET_SEED,
  EDITOR_SEED,
  ONE_DARK_SEED,
  SOLARIZED_SEED,
  GITHUB_SEED,
  NORD_SEED,
  MOCHI_SEED,
  OMP_SEED,
];
