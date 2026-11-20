import type { ThemePresetSeed } from "../presets";

// fork: Quiet page. A narrow reading column in a serif face, generous leading, almost no lines
// or boxes. The user's message is a grey quotation. It has a dark pair.
const SERIF =
  '"Iowan Old Style", "Palatino Linotype", Palatino, "Songti SC", "Noto Serif CJK SC", "SimSun", Georgia, serif';
const MONO = 'Menlo, "SF Mono", Consolas, "Liberation Mono", monospace';

const CSS = `:root {
  --q-rule: #dfe2e5;
  --q-quote: #6b6b6b;
  --q-head: #111111;
}
:root.dark {
  --q-rule: #3a3a3a;
  --q-quote: #a3a3a3;
  --q-head: #f2f2f2;
}

[data-timeline-root], [data-chat-composer-form] { max-width: 40rem !important; margin-inline: auto; }
.chat-markdown, .composer-tiptap { line-height: 1.7; }
.chat-markdown p, .chat-markdown li { line-height: 1.7; }

[data-slot="sidebar-inner"] { border-right: 1px solid var(--q-rule); }
[data-thread-item] [data-sidebar-row] { background: transparent !important; border-radius: 3px !important; }
[data-thread-item] [data-sidebar-row][aria-current="page"] { font-weight: 600; }
[data-chat-header] { border-bottom: 0 !important; letter-spacing: 0.04em; justify-content: center; }

[data-message-role="user"] [data-user-message-bubble] {
  max-width: none;
  width: 100%;
  background: transparent !important;
  border: 0 !important;
  border-left: 3px solid var(--q-rule) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  color: var(--q-quote) !important;
  padding: 0 0 0 16px;
}
[data-message-role="user"] [data-user-message-bubble] * { color: inherit; }

.chat-markdown h1, .chat-markdown h2, .chat-markdown h3 {
  color: var(--q-head);
  font-weight: 600;
  letter-spacing: 0;
}
.chat-markdown a { text-decoration: underline; text-underline-offset: 3px; text-decoration-thickness: 1px; }
.chat-markdown-codeblock { border: 1px solid var(--q-rule) !important; border-radius: 3px !important; }
.chat-markdown table { border-collapse: collapse; }
.chat-markdown th { font-weight: 600; border-bottom: 1px solid var(--q-rule); }
.chat-markdown td { border-top: 0; }

[data-slot="composer-host"] {
  background: transparent !important;
  border: 0 !important;
  border-bottom: 1px solid var(--q-rule) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"],
[data-slot="select-popup"], [data-slot="alert-dialog-popup"] {
  border: 1px solid var(--q-rule) !important;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.08) !important;
}
svg.lucide { stroke-width: 1.5; }
`;

export const QUIET_SEED: ThemePresetSeed = {
  id: "studio-quiet",
  label: "Quiet page",
  appearance: "light",
  palette: {
    canvas: "#fdfdfc",
    accent: "#2f6aa8",
    colors: {
      surface: "#fdfdfc",
      surfaceRaised: "#fafaf9",
      surfaceOverlay: "#ffffff",
      secondary: "#f3f3f2",
      secondaryForeground: "#2b2b2b",
      muted: "#f6f6f5",
      accentSurface: "#f0f0ef",
      accentSurfaceForeground: "#2b2b2b",
      toolbarControl: "#f3f3f2",
      toolbarControlHover: "#eaeae9",
      text: "#2b2b2b",
      textMuted: "#6b6b6b",
      secondaryLabel: "#6b6b6b",
      mutedForeground: "#6b6b6b",
      border: "#ececec",
      input: "#dcdcdc",
      focus: "#2f6aa8",
      accentForeground: "#ffffff",
      sidebar: "#fafaf9",
      sidebarForeground: "#4a4a4a",
      sidebarMutedForeground: "#6b6b6b",
      sidebarBorder: "#ececec",
      codeBackground: "#f6f6f5",
      codeForeground: "#2b2b2b",
    },
  },
  variant: {
    canvas: "#242424",
    accent: "#8ab4f8",
    colors: {
      surface: "#242424",
      surfaceRaised: "#2b2b2b",
      surfaceOverlay: "#2e2e2e",
      secondary: "#2f2f2f",
      secondaryForeground: "#d6d6d6",
      muted: "#292929",
      accentSurface: "#303030",
      accentSurfaceForeground: "#d6d6d6",
      toolbarControl: "#2f2f2f",
      toolbarControlHover: "#383838",
      text: "#d6d6d6",
      textMuted: "#a0a0a0",
      secondaryLabel: "#a0a0a0",
      mutedForeground: "#a0a0a0",
      border: "#333333",
      input: "#444444",
      focus: "#8ab4f8",
      accentForeground: "#10243e",
      sidebar: "#1f1f1f",
      sidebarForeground: "#c8c8c8",
      sidebarMutedForeground: "#a0a0a0",
      sidebarBorder: "#333333",
      codeBackground: "#1c1c1c",
      codeForeground: "#d6d6d6",
    },
  },
  look: {
    fontUi: SERIF,
    fontCode: MONO,
    radius: 3,
    shadow: 0,
    density: 100,
    chatWidth: "comfortable",
  },
  css: CSS,
};
