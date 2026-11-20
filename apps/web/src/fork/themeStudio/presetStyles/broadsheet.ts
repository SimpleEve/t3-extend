import type { ThemePresetSeed } from "../presets";

// fork: Broadsheet. Newsprint, serif, rules. Columns were left out: one short paragraph would
// split across two columns, and code, tables and lists would have to break the flow around it.
const SERIF = '"Georgia", "Times New Roman", "Songti SC", "STSong", "SimSun", serif';
const TYPEWRITER = '"Courier New", Courier, "Songti SC", "SimSun", monospace';

const CSS = `:root {
  --t3x-ink: #161616;
  --t3x-ink-soft: #5a5343;
  --t3x-paper: #f3eee2;
}

.chat-markdown, .composer-tiptap { font-feature-settings: "onum" 1; }

[data-slot="sidebar-inner"] {
  border-right: 1px solid var(--t3x-ink);
  box-shadow: inset -3px 0 0 var(--t3x-paper), inset -4px 0 0 var(--t3x-ink);
}
[data-slot="sidebar-footer"] { border-top: 3px double var(--t3x-ink); }
[data-thread-item] [data-sidebar-row] {
  border-bottom: 1px dotted var(--t3x-ink-soft);
  border-radius: 0 !important;
}
[data-thread-item] [data-sidebar-row][aria-current="page"] {
  box-shadow: inset 3px 0 0 var(--t3x-ink);
  background: rgba(22, 22, 22, 0.07) !important;
  font-weight: 700;
}

[data-chat-header] {
  border-top: 3px double var(--t3x-ink) !important;
  border-bottom: 1px solid var(--t3x-ink) !important;
  font-variant: small-caps;
  letter-spacing: 0.06em;
}
[data-chat-header]::before {
  content: "Local dispatch ·";
  content: "Local dispatch ·" / "";
  align-self: center;
  padding: 0 0.8em 0 1em;
  color: var(--t3x-ink-soft);
  font-style: italic;
  text-transform: none;
}
:lang(zh) [data-chat-header]::before {
  content: "本机讯 ·";
  content: "本机讯 ·" / "";
  letter-spacing: 0.1em;
}

[data-message-role="user"] [data-user-message-bubble] {
  background: transparent !important;
  border: 0 !important;
  border-left: 2px solid var(--t3x-ink) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  font-style: italic;
  max-width: none;
  width: 100%;
  padding-left: 12px !important;
}
[data-message-role="user"] [data-user-message-bubble]::before {
  content: "Letter to the editor:";
  content: "Letter to the editor:" / "";
  display: block;
  font-style: normal;
  font-weight: 700;
  font-variant: small-caps;
  letter-spacing: 0.06em;
}
:lang(zh) [data-message-role="user"] [data-user-message-bubble]::before {
  content: "读者来信――";
  content: "读者来信――" / "";
}

[data-message-role="assistant"] .chat-markdown p:first-of-type:not(:is(li, blockquote) p)::first-letter {
  float: left;
  font-size: 2.7em;
  line-height: 0.8;
  font-weight: 700;
  padding: 0.06em 0.1em 0 0;
}
.chat-markdown :is(ul, ol, pre, table, blockquote, .chat-markdown-codeblock) { clear: both; }
.chat-markdown h1, .chat-markdown h2, .chat-markdown h3 {
  border-bottom: 1px solid var(--t3x-ink);
  padding-bottom: 0.15em;
  letter-spacing: -0.01em;
}
.chat-markdown h1 { border-bottom: 3px double var(--t3x-ink); }
.chat-markdown a { color: #7a1f1a !important; text-decoration: underline; text-underline-offset: 2px; }
.chat-markdown blockquote { border-left: 2px solid var(--t3x-ink) !important; font-style: italic; }
.chat-markdown-codeblock {
  border: 1px solid var(--t3x-ink) !important;
  border-radius: 0 !important;
  font-family: ${TYPEWRITER};
}
.chat-markdown table { border-top: 2px solid var(--t3x-ink); border-bottom: 2px solid var(--t3x-ink); }
.chat-markdown th { border-bottom: 1px solid var(--t3x-ink); font-variant: small-caps; letter-spacing: 0.04em; }

[data-slot="composer-host"] {
  background: transparent !important;
  border: 0 !important;
  border-top: 1px solid var(--t3x-ink) !important;
  border-bottom: 1px solid var(--t3x-ink) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
.composer-tiptap { font-style: italic; }

[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"],
[data-slot="select-popup"], [data-slot="alert-dialog-popup"], [data-slot="toast-popup"] {
  border: 1px solid var(--t3x-ink) !important;
  box-shadow: 3px 3px 0 var(--t3x-ink) !important;
}
[data-slot="button"] { letter-spacing: 0.02em; }
svg.lucide { stroke-width: 1.5; }
`;

export const BROADSHEET_SEED: ThemePresetSeed = {
  id: "studio-broadsheet",
  label: "Broadsheet",
  appearance: "light",
  palette: {
    canvas: "#f3eee2",
    accent: "#161616",
    colors: {
      surface: "#f3eee2",
      surfaceRaised: "#ece5d2",
      surfaceOverlay: "#f6f2e8",
      secondary: "#e8e1cd",
      secondaryForeground: "#161616",
      muted: "#ece5d2",
      accentSurface: "#e2d9c0",
      accentSurfaceForeground: "#161616",
      toolbarControl: "#ece5d2",
      toolbarControlHover: "#e2d9c0",
      text: "#161616",
      textMuted: "#5a5343",
      secondaryLabel: "#5a5343",
      mutedForeground: "#5a5343",
      border: "#c9bfa6",
      input: "#b5aa8e",
      focus: "#8a1c1c",
      sidebar: "#ece5d2",
      sidebarForeground: "#161616",
      sidebarMutedForeground: "#5a5343",
      sidebarRowActive: "#e2d9c0",
      sidebarRowSelected: "#e2d9c0",
      sidebarBorder: "#bdb39b",
      codeBackground: "#ece5d2",
      codeForeground: "#161616",
    },
  },
  look: { fontUi: SERIF, fontCode: TYPEWRITER, radius: 0, shadow: 0, density: 100 },
  css: CSS,
};
