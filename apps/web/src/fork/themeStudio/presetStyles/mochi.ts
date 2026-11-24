import type { ThemePresetSeed } from "../presets";

// fork: Mochi. A soft, friendly look of our own: cream paper, candy pink, lilac, big round corners
// and rounded line icons. The user's message is a lilac bubble. It has a dark pair (plum).
// Only the mood is borrowed from playful chat apps; no names, marks or pictures. Fonts are system ones;
// Trebuchet MS is the friendly face that ships with macOS and Windows.
const SANS =
  '"SF Pro Rounded", "Trebuchet MS", "PingFang SC", "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif';
const MONO = 'Menlo, "SF Mono", "Cascadia Mono", Consolas, "Courier New", monospace';

const CSS = `:root {
  --t3x-m-ink: #3b2230;
  --t3x-m-pink: #ff8fb3;
  --t3x-m-pink-soft: #ffe0ec;
  --t3x-m-lilac: #efe6ff;
  --t3x-m-line: #f3d8cc;
}
:root.dark {
  --t3x-m-ink: #ffeef5;
  --t3x-m-pink-soft: #5a2f48;
  --t3x-m-lilac: #4a3a6b;
  --t3x-m-line: #4a3a50;
}

[data-slot="sidebar-inner"] { border-right: 2px solid var(--t3x-m-line); }
:root:not(.dark) [data-slot="sidebar-inner"] { --primary: #c4326f; }
[data-thread-item] [data-sidebar-row] { border-radius: 14px !important; }
[data-thread-item] [data-sidebar-row][aria-current="page"] { background: var(--t3x-m-pink-soft) !important; }
[data-chat-header] { border-bottom: 2px dotted var(--t3x-m-line) !important; }

[data-message-role="user"] [data-user-message-bubble] {
  background: var(--t3x-m-lilac) !important;
  color: var(--t3x-m-ink) !important;
  border: 2px solid var(--t3x-m-line) !important;
  border-radius: 22px 22px 6px 22px !important;
  box-shadow: 0 3px 0 var(--t3x-m-line) !important;
}
[data-message-role="user"] [data-user-message-bubble] * { color: inherit; }

.chat-markdown a { color: #c4326f !important; text-decoration: underline; text-decoration-thickness: 2px; text-underline-offset: 3px; }
:root.dark .chat-markdown a { color: #ff9ec0 !important; }
.chat-markdown h1::before, .chat-markdown h2::before {
  content: "✿ ";
  content: "✿ " / "";
  color: var(--t3x-m-pink);
}
.chat-markdown-codeblock { border: 2px dashed var(--t3x-m-line) !important; border-radius: 16px !important; }

[data-slot="composer-host"] {
  border: 2px solid var(--t3x-m-line) !important;
  border-radius: 24px !important;
  box-shadow: 0 4px 0 var(--t3x-m-line) !important;
}
[data-slot="composer-host"]:focus-within { border-color: var(--t3x-m-pink) !important; }

[data-slot="button"], [data-slot="badge"] { border-radius: 999px !important; }
[data-slot="input"], [data-slot="textarea"], [data-slot="select-trigger"] { border-radius: 14px !important; }
[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"],
[data-slot="select-popup"], [data-slot="alert-dialog-popup"], [data-slot="toast-popup"] {
  border: 2px solid var(--t3x-m-line) !important;
  border-radius: 22px !important;
}
.messages-timeline-scroll::-webkit-scrollbar { width: 12px; }
.messages-timeline-scroll::-webkit-scrollbar-thumb { background: var(--t3x-m-line); border-radius: 999px; }
svg.lucide { stroke-width: 2; stroke-linecap: round; stroke-linejoin: round; }
`;

export const MOCHI_SEED: ThemePresetSeed = {
  id: "studio-mochi",
  label: "Mochi",
  appearance: "light",
  palette: {
    canvas: "#fff8f1",
    accent: "#ff8fb3",
    colors: {
      surface: "#fffaf5",
      surfaceRaised: "#fff1e6",
      surfaceOverlay: "#ffffff",
      secondary: "#ffe9f0",
      secondaryForeground: "#3b2230",
      muted: "#ffeee3",
      accentSurface: "#ffe0ec",
      accentSurfaceForeground: "#3b2230",
      toolbarControl: "#ffe9f0",
      toolbarControlHover: "#ffdbe8",
      text: "#3b2230",
      textMuted: "#7d5a69",
      secondaryLabel: "#735160",
      mutedForeground: "#7d5a69",
      border: "#f3d8cc",
      input: "#e9c4b8",
      focus: "#e8548a",
      accentForeground: "#3b2230",
      messageSurface: "#efe6ff",
      messageForeground: "#3b2230",
      messageAction: "#ff8fb3",
      messageActionForeground: "#3b2230",
      sidebar: "#fff0e6",
      sidebarForeground: "#3b2230",
      sidebarMutedForeground: "#735160",
      sidebarBorder: "#f3d8cc",
      codeBackground: "#fff1e6",
      codeForeground: "#3b2230",
    },
  },
  variant: {
    canvas: "#2a1f2d",
    accent: "#ff8fb3",
    colors: {
      surface: "#2a1f2d",
      surfaceRaised: "#35283a",
      surfaceOverlay: "#3a2c40",
      secondary: "#3d2f44",
      secondaryForeground: "#ffeef5",
      muted: "#35283a",
      accentSurface: "#5a2f48",
      accentSurfaceForeground: "#ffeef5",
      toolbarControl: "#3d2f44",
      toolbarControlHover: "#4a3a52",
      text: "#ffeef5",
      textMuted: "#cdaec0",
      secondaryLabel: "#cdaec0",
      mutedForeground: "#cdaec0",
      border: "#4a3a50",
      input: "#5c4a63",
      focus: "#ff8fb3",
      accentForeground: "#2a1f2d",
      messageSurface: "#4a3a6b",
      messageForeground: "#ffeef5",
      messageAction: "#ff8fb3",
      messageActionForeground: "#2a1f2d",
      sidebar: "#231a26",
      sidebarForeground: "#ffeef5",
      sidebarMutedForeground: "#cdaec0",
      sidebarBorder: "#4a3a50",
      codeBackground: "#231a26",
      codeForeground: "#ffeef5",
    },
  },
  look: { fontUi: SANS, fontCode: MONO, radius: 18, shadow: 40, density: 104 },
  css: CSS,
};
