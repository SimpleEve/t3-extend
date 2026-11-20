import type { ThemePresetSeed } from "../presets";

// fork: Blueprint. Prussian blue with a static drafting grid (CSS gradients only), thin light
// lines and dashes.
const MONO =
  'Menlo, "SF Mono", Consolas, "Liberation Mono", "PingFang SC", "Microsoft YaHei", monospace';

const CSS = `:root {
  --bp-line: #8fb3e8;
  --bp-ink: #e8f1ff;
  --bp-grid:
    linear-gradient(rgba(255, 255, 255, 0.07) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.07) 1px, transparent 1px),
    linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
    linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
}

body,
[data-slot="sidebar-inset"],
[data-workspace-area="conversation"],
[data-chat-header],
[data-slot="sidebar-inner"] {
  background-image: var(--bp-grid);
  background-size: 40px 40px, 40px 40px, 8px 8px, 8px 8px;
}

[data-slot="sidebar-inner"] { border-right: 1px dashed var(--bp-line); }
[data-slot="sidebar-footer"] { border-top: 1px dashed var(--bp-line); }
[data-thread-item] [data-sidebar-row] { border-radius: 0 !important; }
[data-thread-item] [data-sidebar-row][aria-current="page"] {
  outline: 1px solid var(--bp-ink);
  outline-offset: -1px;
  background: rgba(232, 241, 255, 0.08) !important;
}

[data-chat-header] {
  border-bottom: 1px solid var(--bp-line) !important;
  letter-spacing: 0.06em;
}
[data-chat-header] nav { display: flex; align-items: baseline; }
[data-chat-header] nav::before { content: "FIG. 1 ─ "; color: var(--bp-line); }
:lang(zh) [data-chat-header] nav::before { content: "图 1 ─ "; }

[data-message-role="user"] [data-user-message-bubble] {
  background: transparent !important;
  border: 1px solid var(--bp-ink) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

.chat-markdown h1, .chat-markdown h2, .chat-markdown h3 {
  font-weight: 400;
  letter-spacing: 0.08em;
  text-decoration: underline;
  text-underline-offset: 5px;
  text-decoration-thickness: 1px;
}
.chat-markdown a { color: #ffd27a !important; text-decoration: underline dashed; }
.chat-markdown-codeblock { border: 1px dashed var(--bp-line) !important; border-radius: 0 !important; }
.chat-markdown table, .chat-markdown th, .chat-markdown td { border-color: rgba(143, 179, 232, 0.55) !important; }
.chat-markdown th { border-bottom: 1px solid var(--bp-line); letter-spacing: 0.06em; }

[data-slot="composer-host"] {
  background: rgba(23, 61, 114, 0.92) !important;
  border: 1px solid var(--bp-ink) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
[data-slot="composer-host"]:focus-within { outline: 1px dashed #ffd27a; outline-offset: 2px; }

[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"],
[data-slot="select-popup"], [data-slot="alert-dialog-popup"], [data-slot="toast-popup"] {
  border: 1px solid var(--bp-ink) !important;
  box-shadow: 0 0 0 4px #173d72, 0 0 0 5px var(--bp-line) !important;
}
svg.lucide { stroke-width: 1.25; }
`;

export const BLUEPRINT_SEED: ThemePresetSeed = {
  id: "studio-blueprint",
  label: "Blueprint",
  appearance: "dark",
  palette: {
    canvas: "#173d72",
    accent: "#ffd27a",
    colors: {
      text: "#e8f1ff",
      textMuted: "#aac5ee",
      secondaryLabel: "#aac5ee",
      mutedForeground: "#aac5ee",
      iconMuted: "#8fb3e8",
      border: "#3f6aa8",
      input: "#5f8cd0",
      focus: "#ffd27a",
      accentForeground: "#10294d",
      surface: "#1a4380",
      surfaceRaised: "#1d4a8c",
      surfaceOverlay: "#1d4a8c",
      secondary: "#1d4a8c",
      secondaryForeground: "#e8f1ff",
      muted: "#1a4380",
      accentSurface: "#24518f",
      accentSurfaceForeground: "#e8f1ff",
      toolbarControl: "#1d4a8c",
      toolbarControlHover: "#24518f",
      messageSurface: "#1d4a8c",
      messageForeground: "#e8f1ff",
      messageAction: "#ffd27a",
      messageActionForeground: "#10294d",
      messageActionHover: "#ffc255",
      codeBackground: "#0f2c55",
      codeForeground: "#ffd27a",
      sidebar: "#12335f",
      sidebarForeground: "#e8f1ff",
      sidebarMutedForeground: "#aac5ee",
      sidebarControlSurface: "#173d72",
      sidebarRowHover: "#1a4380",
      sidebarRowActive: "#1d4a8c",
      sidebarRowSelected: "#1d4a8c",
      sidebarBorder: "#3f6aa8",
    },
  },
  look: { fontUi: MONO, fontCode: MONO, radius: 0, shadow: 0, density: 100 },
  css: CSS,
};
