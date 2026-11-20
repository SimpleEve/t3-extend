import type { ThemePresetSeed } from "../presets";

// fork: Docs. A plain document look: white, system sans, hairlines, 6px corners. The user's
// message reads as a comment with a grey title bar. It has a dark pair, so the two halves
// of the theme follow the appearance.
const SANS =
  '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", "PingFang SC", "Microsoft YaHei", Helvetica, Arial, sans-serif';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace';

const CSS = `:root {
  --t3x-d-line: #d0d7de;
  --t3x-d-line-soft: #d1d9e0;
  --t3x-d-head: #f6f8fa;
  --t3x-d-link: #0969da;
  --t3x-d-muted: #59636e;
  --t3x-d-mark: #fd8c73;
}
:root.dark {
  --t3x-d-line: #30363d;
  --t3x-d-line-soft: #21262d;
  --t3x-d-head: #161b22;
  --t3x-d-link: #4493f8;
  --t3x-d-muted: #9198a1;
  --t3x-d-mark: #f78166;
}

[data-slot="sidebar-inner"] { border-right: 1px solid var(--t3x-d-line); }
[data-thread-item] [data-sidebar-row] { border-radius: 6px !important; }
[data-thread-item] [data-sidebar-row][aria-current="page"] {
  background: var(--background) !important;
  box-shadow: inset 2px 0 0 var(--t3x-d-mark);
  font-weight: 600;
}
[data-chat-header] { border-bottom: 1px solid var(--t3x-d-line) !important; font-weight: 600; }

[data-message-role="user"] [data-user-message-bubble] {
  max-width: none;
  width: 100%;
  overflow: hidden;
  background: transparent !important;
  border: 1px solid var(--t3x-d-line) !important;
  border-radius: 6px !important;
  box-shadow: none !important;
}
[data-message-role="user"] [data-user-message-bubble]::before {
  content: "You";
  content: "You" / "";
  display: block;
  margin: -12px -12px 10px;
  padding: 8px 12px;
  background: var(--t3x-d-head);
  border-bottom: 1px solid var(--t3x-d-line);
  color: var(--t3x-d-muted);
  font-size: 12px;
  font-weight: 600;
}
:lang(zh) [data-message-role="user"] [data-user-message-bubble]::before {
  content: "你";
  content: "你" / "";
}

.chat-markdown h1, .chat-markdown h2 {
  border-bottom: 1px solid var(--t3x-d-line-soft);
  padding-bottom: 0.3em;
  font-weight: 600;
}
.chat-markdown h3 { font-weight: 600; }
.chat-markdown a { color: var(--t3x-d-link) !important; text-decoration: none; }
.chat-markdown a:hover { text-decoration: underline; }
.chat-markdown blockquote { border-left: 4px solid var(--t3x-d-line) !important; color: var(--t3x-d-muted); }
.chat-markdown-codeblock { border: 1px solid transparent !important; border-radius: 6px !important; }
.chat-markdown table { border-collapse: collapse; }
.chat-markdown th, .chat-markdown td { border: 1px solid var(--t3x-d-line); padding: 6px 13px !important; }
.chat-markdown th { background: var(--t3x-d-head); font-weight: 600; }

[data-slot="composer-host"] {
  border: 1px solid var(--t3x-d-line) !important;
  border-radius: 6px !important;
  box-shadow: none !important;
}
[data-slot="composer-host"]:focus-within { border-color: var(--t3x-d-link) !important; box-shadow: 0 0 0 1px var(--t3x-d-link) !important; }

[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"],
[data-slot="select-popup"], [data-slot="alert-dialog-popup"], [data-slot="toast-popup"] {
  border: 1px solid var(--t3x-d-line) !important;
  border-radius: 6px !important;
}
svg.lucide { stroke-width: 1.75; }
`;

export const DOCS_SEED: ThemePresetSeed = {
  id: "studio-docs",
  label: "Docs",
  appearance: "light",
  palette: {
    canvas: "#ffffff",
    accent: "#1a7f37",
    colors: {
      surface: "#ffffff",
      surfaceRaised: "#ffffff",
      surfaceOverlay: "#ffffff",
      secondary: "#f6f8fa",
      secondaryForeground: "#1f2328",
      muted: "#f6f8fa",
      accentSurface: "#eaeef2",
      accentSurfaceForeground: "#1f2328",
      toolbarControl: "#f6f8fa",
      toolbarControlHover: "#eaeef2",
      text: "#1f2328",
      textMuted: "#59636e",
      secondaryLabel: "#59636e",
      mutedForeground: "#59636e",
      border: "#d0d7de",
      input: "#d0d7de",
      focus: "#0969da",
      accentForeground: "#ffffff",
      sidebar: "#f6f8fa",
      sidebarForeground: "#1f2328",
      sidebarMutedForeground: "#59636e",
      sidebarBorder: "#d0d7de",
      codeBackground: "#f6f8fa",
      codeForeground: "#1f2328",
    },
  },
  variant: {
    canvas: "#0d1117",
    accent: "#238636",
    colors: {
      surface: "#0d1117",
      surfaceRaised: "#161b22",
      surfaceOverlay: "#161b22",
      secondary: "#21262d",
      secondaryForeground: "#e6edf3",
      muted: "#161b22",
      accentSurface: "#21262d",
      accentSurfaceForeground: "#e6edf3",
      toolbarControl: "#21262d",
      toolbarControlHover: "#30363d",
      text: "#e6edf3",
      textMuted: "#9198a1",
      secondaryLabel: "#9198a1",
      mutedForeground: "#9198a1",
      border: "#30363d",
      input: "#30363d",
      focus: "#4493f8",
      accentForeground: "#ffffff",
      sidebar: "#010409",
      sidebarForeground: "#e6edf3",
      sidebarMutedForeground: "#9198a1",
      sidebarBorder: "#30363d",
      codeBackground: "#161b22",
      codeForeground: "#e6edf3",
    },
  },
  look: { fontUi: SANS, fontCode: MONO, radius: 6, shadow: 20, density: 100 },
  css: CSS,
};
