import type { ThemePresetSeed } from "../presets";

// fork: Brutalist. Thick black borders, hard offset shadows, clashing flat blocks.
const MONO =
  'Menlo, "SF Mono", Consolas, "Courier New", "PingFang SC", "Microsoft YaHei", monospace';

const CSS = `:root { --t3x-yellow: #ffe500; --t3x-pink: #ff5ca8; --t3x-mint: #7cf0d0; --t3x-shadow: 4px 4px 0 #000; }

.chat-markdown, .composer-tiptap { font-weight: 500; }

[data-slot="sidebar-inner"] { border-right: 3px solid #000; --primary: #000000; }
[data-thread-details-card], [data-assistant-outputs] { border: 3px solid #000 !important; border-radius: 0 !important; box-shadow: var(--t3x-shadow) !important; background: #fff !important; }
[data-thread-item] [data-sidebar-row] {
  border: 2px solid #000 !important;
  border-radius: 0 !important;
  background: #fff !important;
  margin-bottom: 4px;
  font-weight: 700;
}
[data-thread-item] [data-sidebar-row][aria-current="page"] {
  background: var(--t3x-pink) !important;
  box-shadow: 3px 3px 0 #000;
}
[data-sidebar-row]:focus-visible { outline: 3px solid #000; outline-offset: 2px; }

[data-chat-header] {
  border-bottom: 3px solid #000 !important;
  font-weight: 800;
  text-transform: uppercase;
  letter-spacing: 0.03em;
}

[data-message-role="user"] [data-user-message-bubble] {
  background: var(--t3x-yellow) !important;
  border: 3px solid #000 !important;
  border-radius: 0 !important;
  box-shadow: var(--t3x-shadow) !important;
  font-weight: 700;
}
[data-message-role="assistant"] .chat-markdown {
  background: #fff;
  border: 3px solid #000;
  box-shadow: var(--t3x-shadow);
  padding: 12px 16px;
}

.chat-markdown h1, .chat-markdown h2, .chat-markdown h3 { text-transform: uppercase; font-weight: 800; letter-spacing: 0.01em; }
.chat-markdown a { color: #000 !important; text-decoration: underline; text-decoration-thickness: 3px; background: var(--t3x-mint); }
.chat-markdown-codeblock { border: 3px solid #000 !important; border-radius: 0 !important; box-shadow: var(--t3x-shadow); }
.chat-markdown table { border: 3px solid #000; }
.chat-markdown th { background: var(--t3x-mint); border-bottom: 3px solid #000; text-transform: uppercase; }
.chat-markdown td { border-top: 2px solid #000; }
.chat-markdown :is(th, td) { padding: 6px 12px !important; }

[data-slot="composer-host"] {
  background: #fff !important;
  border: 3px solid #000 !important;
  border-radius: 0 !important;
  box-shadow: var(--t3x-shadow) !important;
}
[data-slot="composer-host"]:focus-within { background: var(--t3x-yellow) !important; }

[data-slot="button"], [data-slot="input"], [data-slot="select-trigger"], [data-slot="textarea"] {
  border: 2px solid #000 !important;
  border-radius: 0 !important;
  font-weight: 700;
}
[data-slot="button"]:not(:disabled):hover { box-shadow: 3px 3px 0 #000; transform: translate(-1px, -1px); }
[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"],
[data-slot="select-popup"], [data-slot="alert-dialog-popup"], [data-slot="toast-popup"],
[data-slot="tooltip-popup"] {
  border: 3px solid #000 !important;
  border-radius: 0 !important;
  box-shadow: var(--t3x-shadow) !important;
}
svg.lucide { stroke-width: 2.5; stroke-linecap: square; stroke-linejoin: miter; }
`;

export const BRUTALIST_SEED: ThemePresetSeed = {
  id: "studio-brutalist",
  label: "Brutalist",
  appearance: "light",
  palette: {
    canvas: "#fff8d6",
    accent: "#ff5ca8",
    colors: {
      text: "#000000",
      textMuted: "#333333",
      secondaryLabel: "#303030",
      mutedForeground: "#333333",
      placeholder: "#595959",
      border: "#000000",
      input: "#000000",
      focus: "#000000",
      accentForeground: "#000000",
      surface: "#ffffff",
      surfaceRaised: "#ffffff",
      surfaceOverlay: "#ffffff",
      secondary: "#ffffff",
      secondaryForeground: "#000000",
      muted: "#fff0a8",
      messageSurface: "#ffe500",
      messageForeground: "#000000",
      messageAction: "#ff5ca8",
      messageActionForeground: "#000000",
      messageActionHover: "#ff3d95",
      codeBackground: "#ffffff",
      codeForeground: "#000000",
      warningForeground: "#8a3a00",
      sidebar: "#7cf0d0",
      sidebarForeground: "#000000",
      sidebarMutedForeground: "#1a1a1a",
      sidebarControlSurface: "#ffffff",
      sidebarRowHover: "#ffffff",
      sidebarRowActive: "#ff5ca8",
      sidebarRowSelected: "#ff5ca8",
      sidebarBorder: "#000000",
    },
  },
  look: { fontUi: MONO, fontCode: MONO, radius: 0, shadow: 0, density: 100 },
  css: CSS,
};
