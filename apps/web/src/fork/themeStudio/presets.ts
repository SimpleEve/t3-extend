import type { ThemeLook } from "@t3tools/contracts";
import type { ThemeAppearance, ThemeColors } from "@t3tools/shared/themePalettes";

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
const SERIF_STACK = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Songti SC", serif';
const CODE_STACK = '"SF Mono", Menlo, "Cascadia Mono", Consolas, "Liberation Mono", monospace';

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
  {
    id: "studio-oled",
    label: "OLED Black",
    appearance: "dark",
    palette: { canvas: "#000000", accent: "#5cc8ff" },
    look: { radius: 10, shadow: 0, fontCode: CODE_STACK },
  },
  {
    id: "studio-paper",
    label: "Paper",
    appearance: "light",
    palette: { canvas: "#f6f1e7", accent: "#b5532b" },
    look: {
      fontUi: SERIF_STACK,
      fontCode: CODE_STACK,
      radius: 4,
      shadow: 30,
      chatWidth: "comfortable",
    },
  },
  {
    id: "studio-fjord",
    label: "Fjord",
    appearance: "dark",
    palette: { canvas: "#272d38", accent: "#7fb3c5" },
    variant: { canvas: "#edf0f3", accent: "#3f7f99" },
    look: { radius: 8, shadow: 70 },
  },
  {
    id: "studio-tide",
    label: "Tide",
    appearance: "light",
    palette: { canvas: "#f3efe2", accent: "#2a7f9e" },
    variant: { canvas: "#0b2a33", accent: "#4cc3c9" },
    look: { radius: 12, shadow: 60, chatWidth: "wide" },
  },
  {
    id: "studio-clay",
    label: "Clay",
    appearance: "dark",
    palette: { canvas: "#241b17", accent: "#e08a4b" },
    variant: { canvas: "#faf3ec", accent: "#c0622a" },
    look: { radius: 14, shadow: 100, fontUi: SERIF_STACK },
  },
  {
    id: "studio-graphite",
    label: "Graphite",
    appearance: "dark",
    palette: { canvas: "#1c1d1f", accent: "#9aa7ff" },
    look: { radius: 6, density: 95, shadow: 50 },
  },
  {
    id: "studio-frosted",
    label: "Frosted",
    appearance: "dark",
    palette: { canvas: "#14161c", accent: "#7ab8ff" },
    look: { radius: 16, shadow: 140, glass: 45 },
    needsBackground: true,
  },
  {
    id: "studio-compact",
    label: "Compact",
    appearance: "light",
    palette: { canvas: "#f7f7f8", accent: "#2f7d6d" },
    variant: { canvas: "#17191a", accent: "#4fb8a0" },
    look: { radius: 6, density: 85, shadow: 40, chatWidth: "wide" },
  },
];
