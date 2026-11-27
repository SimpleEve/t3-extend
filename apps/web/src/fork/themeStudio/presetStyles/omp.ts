import type { ThemePresetSeed } from "../presets";

// fork: omp (oh-my-pi 19.0.1): dark is its `titanium` theme, light is its `light` theme. Light text
// colors are a little deeper than omp's, same hue, to reach 4.5:1 on its grey and tinted grounds.
// Fonts are installed monospace ones.
const MONO =
  '"JetBrains Mono", "SF Mono", "Cascadia Mono", Menlo, "Sarasa Mono SC", "PingFang SC", monospace';

const CSS = `:root {
  --t3x-omp-bg: #151820;
  --t3x-omp-widget: #1c2029;
  --t3x-omp-text: #e8ecf4;
  --t3x-omp-muted: #9ca3b0;
  --t3x-omp-dim: #6b7280;
  --t3x-omp-border: #2a3038;
  --t3x-omp-border-muted: #1f252d;
  --t3x-omp-accent: #00b4ff;
  --t3x-omp-selected: #006a94;
  --t3x-omp-success: #00ff88;
  --t3x-omp-error: #ff4757;
  --t3x-omp-user: #0f1216;
  --t3x-omp-tool-pending: #0f1216;
  --t3x-omp-tool-success: #0f1216;
  --t3x-omp-tool-error: #1a0f10;
  --t3x-omp-heading: #00b4ff;
  --t3x-omp-link: #00b4ff;
  --t3x-omp-code: #00ff88;
  --t3x-omp-bullet: #00b4ff;
  --t3x-omp-quote: #9ca3b0;
  --t3x-omp-card-border: #6b7280;
}
:root:not(.dark) {
  --t3x-omp-bg: #f8f8f8;
  --t3x-omp-widget: #ffffff;
  --t3x-omp-text: #3b3b3b;
  --t3x-omp-muted: #676767;
  --t3x-omp-dim: #767676;
  --t3x-omp-border: #547da7;
  --t3x-omp-border-muted: #b0b0b0;
  --t3x-omp-accent: #4d6d6d;
  --t3x-omp-selected: #d0d0e0;
  --t3x-omp-success: #4b704b;
  --t3x-omp-error: #9e4f4f;
  --t3x-omp-user: #e8e8e8;
  --t3x-omp-tool-pending: #e8e8f0;
  --t3x-omp-tool-success: #e8f0e8;
  --t3x-omp-tool-error: #f0e8e8;
  --t3x-omp-heading: #826120;
  --t3x-omp-link: #476a8e;
  --t3x-omp-code: #4d6d6d;
  --t3x-omp-bullet: #4b704b;
  --t3x-omp-quote: #676767;
  --t3x-omp-card-border: #767676;
}

:root { font-variant-ligatures: none; }
:root ::selection { background: var(--t3x-omp-selected); color: var(--t3x-omp-text); }

[data-thread-item] [data-sidebar-row][aria-current="page"] { box-shadow: inset 2px 0 0 var(--t3x-omp-accent); }

/* Your message is a full-width block with its own ground: no frame, no rounded corners. */
[data-message-role="user"] [data-user-message-bubble] {
  max-width: none;
  width: 100%;
  background: var(--t3x-omp-user) !important;
  color: var(--t3x-omp-text) !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}

/* Replies have no frame; only the colors of the markdown are omp's. */
.chat-markdown h1, .chat-markdown h2, .chat-markdown h3, .chat-markdown h4, .chat-markdown h5, .chat-markdown h6 {
  color: var(--t3x-omp-heading);
}
.chat-markdown a { color: var(--t3x-omp-link) !important; text-decoration: underline; }
.chat-markdown li::marker { color: var(--t3x-omp-bullet); }
.chat-markdown code { color: var(--t3x-omp-code) !important; }
.chat-markdown pre code, .chat-markdown-codeblock code { color: inherit !important; }
.chat-markdown blockquote { color: var(--t3x-omp-quote); border-color: var(--t3x-omp-border) !important; }
.chat-markdown hr { border-color: var(--t3x-omp-border); }

/* Thinking: a dim italic line, and its text when opened. */
[data-v2-item-type="reasoning"], [data-v2-item-type="reasoning"] * {
  font-style: italic;
  color: var(--t3x-omp-muted) !important;
}

.chat-markdown-codeblock {
  border: 1px solid var(--t3x-omp-border) !important;
  border-radius: 3px !important;
}
.chat-markdown-codeblock-header {
  background: var(--t3x-omp-widget);
  border-bottom: 1px solid var(--t3x-omp-border);
  padding-bottom: 6px !important;
  color: var(--t3x-omp-muted) !important;
}

[data-slot="composer-host"] {
  border: 1px solid var(--t3x-omp-border-muted) !important;
  border-radius: 4px !important;
  box-shadow: none !important;
}
[data-slot="composer-host"]:focus-within { border-color: var(--t3x-omp-accent) !important; }

/* A tool call is a small card. Its ground and its border follow its state. */
[data-tool-status] {
  margin-block: 3px;
  padding: 3px 8px !important;
  background: var(--t3x-omp-tool-pending);
  border: 1px solid var(--t3x-omp-card-border);
  border-radius: 4px !important;
}
[data-tool-status="running"] { border-color: var(--t3x-omp-accent); }
[data-tool-status="success"] { background: var(--t3x-omp-tool-success); }
[data-tool-status="error"] { background: var(--t3x-omp-tool-error); border-color: var(--t3x-omp-error); }
[data-tool-status] [data-work-log-details] {
  border-top: 1px solid var(--t3x-omp-border-muted);
  margin-top: 4px;
  padding-top: 4px;
}
`;

export const OMP_SEED: ThemePresetSeed = {
  id: "studio-omp",
  label: "omp",
  appearance: "dark",
  palette: {
    canvas: "#151820",
    accent: "#00b4ff",
    colors: {
      chrome: "#0f1216",
      toolbar: "#0f1216",
      toolbarForeground: "#e8ecf4",
      toolbarBorder: "#1f252d",
      toolbarControl: "#1c2029",
      toolbarControlForeground: "#e8ecf4",
      toolbarControlHover: "#252b36",
      surface: "#151820",
      surfaceRaised: "#1c2029",
      surfaceOverlay: "#1c2029",
      text: "#e8ecf4",
      textMuted: "#9ca3b0",
      border: "#2a3038",
      input: "#2a3038",
      focus: "#00b4ff",
      accentForeground: "#06121a",
      secondary: "#1c2029",
      secondaryForeground: "#e8ecf4",
      muted: "#1c2029",
      mutedForeground: "#9ca3b0",
      placeholder: "#8b93a1",
      secondaryLabel: "#9ca3b0",
      iconMuted: "#8b93a1",
      error: "#ff4757",
      errorForeground: "#ff4757",
      errorSurface: "#1a0f10",
      warning: "#ffb347",
      warningForeground: "#ffb347",
      warningSurface: "#2a2008",
      update: "#00ff88",
      updateForeground: "#00ff88",
      updateSurface: "#0c2a1c",
      accentSurface: "#12283a",
      accentSurfaceForeground: "#e8ecf4",
      messageSurface: "#0f1216",
      messageForeground: "#e8ecf4",
      messageAction: "#00b4ff",
      messageActionForeground: "#06121a",
      messageActionHover: "#33c4ff",
      codeBackground: "#0f1216",
      codeForeground: "#e8ecf4",
      searchMatchBackground: "#0d3a52",
      searchMatchForeground: "#e8ecf4",
      searchMatchActiveBackground: "#ffb347",
      searchMatchActiveForeground: "#151820",
      sidebar: "#0f1216",
      sidebarForeground: "#e8ecf4",
      sidebarMutedForeground: "#9ca3b0",
      sidebarControlSurface: "#151820",
      sidebarRowHover: "#181c24",
      sidebarRowActive: "#1c2029",
      sidebarRowSelected: "#1c2029",
      sidebarBorder: "#1f252d",
      terminalBackground: "#0f1216",
      terminalForeground: "#e8ecf4",
      terminalCursor: "#00b4ff",
      terminalSelection: "#0082b3",
      terminalScrollbar: "#2a3038",
      terminalScrollbarHover: "#3a424c",
    },
  },
  variant: {
    canvas: "#f8f8f8",
    accent: "#4d6d6d",
    colors: {
      chrome: "#f8f8f8",
      toolbar: "#f8f8f8",
      toolbarForeground: "#3b3b3b",
      toolbarBorder: "#d0d0d0",
      toolbarControl: "#e8e8e8",
      toolbarControlForeground: "#3b3b3b",
      toolbarControlHover: "#dcdcdc",
      surface: "#ffffff",
      surfaceRaised: "#ffffff",
      surfaceOverlay: "#ffffff",
      text: "#3b3b3b",
      textMuted: "#676767",
      border: "#b0b0b0",
      input: "#b0b0b0",
      focus: "#4d6d6d",
      accentForeground: "#ffffff",
      secondary: "#e8e8e8",
      secondaryForeground: "#3b3b3b",
      muted: "#e8e8e8",
      mutedForeground: "#676767",
      placeholder: "#6a6a6a",
      secondaryLabel: "#585858",
      iconMuted: "#6c6c6c",
      error: "#9e4f4f",
      errorForeground: "#9e4f4f",
      errorSurface: "#f0e8e8",
      warning: "#826120",
      warningForeground: "#826120",
      warningSurface: "#f6eedd",
      update: "#4b704b",
      updateForeground: "#4b704b",
      updateSurface: "#e8f0e8",
      accentSurface: "#d0d0e0",
      accentSurfaceForeground: "#3b3b3b",
      messageSurface: "#e8e8e8",
      messageForeground: "#3b3b3b",
      messageAction: "#4d6d6d",
      messageActionForeground: "#ffffff",
      messageActionHover: "#3f5a5a",
      codeBackground: "#ffffff",
      codeForeground: "#3b3b3b",
      searchMatchBackground: "#f3e3a8",
      searchMatchForeground: "#3b3b3b",
      searchMatchActiveBackground: "#d9b45a",
      searchMatchActiveForeground: "#3b3b3b",
      sidebar: "#f0f0f0",
      sidebarForeground: "#3b3b3b",
      sidebarMutedForeground: "#565656",
      sidebarControlSurface: "#ffffff",
      sidebarRowHover: "#e8e8e8",
      sidebarRowActive: "#d0d0e0",
      sidebarRowSelected: "#d0d0e0",
      sidebarBorder: "#d0d0d0",
      terminalBackground: "#f8f8f8",
      terminalForeground: "#3b3b3b",
      terminalCursor: "#4d6d6d",
      terminalSelection: "#d0d0e0",
      terminalScrollbar: "#c4c4c4",
      terminalScrollbarHover: "#a8a8a8",
    },
  },
  look: { fontUi: MONO, fontCode: MONO, radius: 3, shadow: 0, density: 100 },
  css: CSS,
};
