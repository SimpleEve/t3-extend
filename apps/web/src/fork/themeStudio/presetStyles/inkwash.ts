import type { ThemePresetSeed } from "../presets";

// fork: Ink wash. Rice paper, regular script, ink-gradient rules and a vermilion seal.
// It reads best in Chinese; with Latin text the serif fallbacks keep the same quiet colors.
const KAI =
  '"Kaiti SC", "STKaiti", "KaiTi", "Kai", "Songti SC", "STSong", "SimSun", Georgia, serif';
const CODE = 'Menlo, "SF Mono", Consolas, "Liberation Mono", monospace';

const CSS = `:root { --ink: #1d1b18; --ink-soft: #5e5849; --paper: #f1ebdc; --seal: #b8322a; }

[data-workspace-area="conversation"] {
  background-image: radial-gradient(ellipse at 85% 112%, rgba(29, 27, 24, 0.1), transparent 55%);
  background-attachment: local;
  border-top: 3px solid transparent;
  border-image: linear-gradient(90deg, transparent, var(--ink) 15%, rgba(29, 27, 24, 0.3) 70%, transparent) 1;
}
[data-slot="sidebar-inner"] { background-image: linear-gradient(90deg, rgba(29, 27, 24, 0.05), transparent 70%); }
[data-thread-item] [data-sidebar-row] { border-radius: 0 !important; }
[data-thread-item] [data-sidebar-row][aria-current="page"] {
  background: linear-gradient(90deg, rgba(29, 27, 24, 0.16), transparent 92%) !important;
}

[data-chat-header] { letter-spacing: 0.14em; border-bottom: 0 !important; }
[data-chat-header] nav { display: flex; align-items: center; }
[data-chat-header] nav::after {
  content: "E";
  display: inline-grid;
  place-items: center;
  width: 1.5em;
  height: 1.5em;
  margin-left: 0.8em;
  border-radius: 2px;
  background: var(--seal);
  color: var(--paper);
  font-size: 0.75em;
  letter-spacing: 0;
  vertical-align: middle;
}
:lang(zh) [data-chat-header] nav::after { content: "延"; }

[data-message-role="user"] [data-user-message-bubble] {
  background: transparent !important;
  border: 0 !important;
  border-right: 3px solid var(--seal) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  padding: 2px 12px 2px 8px;
}

.chat-markdown h1, .chat-markdown h2, .chat-markdown h3 { font-weight: 400; letter-spacing: 0.14em; }
.chat-markdown h1 { border-bottom: 1px solid var(--ink); padding-bottom: 0.2em; }
.chat-markdown a { color: var(--seal) !important; text-decoration: underline; text-underline-offset: 3px; }
.chat-markdown blockquote { border-left: 2px solid var(--ink) !important; }
.chat-markdown-codeblock {
  background: rgba(29, 27, 24, 0.06) !important;
  border: 0 !important;
  border-left: 2px solid var(--ink) !important;
  border-radius: 0 !important;
  font-family: ${CODE};
}
.chat-markdown table { border-top: 1px solid var(--ink); border-bottom: 1px solid var(--ink); }
.chat-markdown th { font-weight: 400; letter-spacing: 0.12em; border-bottom: 1px solid var(--ink); }

[data-slot="composer-host"] {
  background: transparent !important;
  border: 0 !important;
  border-bottom: 1px solid var(--ink) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
[data-slot="button"] { border-radius: 2px; }
[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"],
[data-slot="select-popup"], [data-slot="alert-dialog-popup"] {
  border: 1px solid rgba(29, 27, 24, 0.55) !important;
  border-radius: 2px !important;
  box-shadow: 0 6px 18px rgba(29, 27, 24, 0.14) !important;
}
svg.lucide { stroke-width: 1.25; stroke-linecap: round; }
`;

export const INKWASH_SEED: ThemePresetSeed = {
  id: "studio-inkwash",
  label: "Ink wash",
  appearance: "light",
  palette: {
    canvas: "#f1ebdc",
    accent: "#b8322a",
    colors: {
      surface: "#f1ebdc",
      surfaceRaised: "#ece5d3",
      surfaceOverlay: "#f4efe2",
      secondary: "#e8e1cf",
      secondaryForeground: "#1d1b18",
      muted: "#e8e1cf",
      accentSurface: "#e8d9c4",
      accentSurfaceForeground: "#1d1b18",
      toolbarControl: "#e8e1cf",
      toolbarControlHover: "#ddd5bf",
      text: "#1d1b18",
      textMuted: "#5e5849",
      secondaryLabel: "#5e5849",
      mutedForeground: "#5e5849",
      border: "#d8cfbb",
      input: "#c4b9a0",
      focus: "#b8322a",
      accentForeground: "#ffffff",
      sidebar: "#ece5d3",
      sidebarForeground: "#1d1b18",
      sidebarMutedForeground: "#5e5849",
      sidebarBorder: "#d8cfbb",
      codeBackground: "#e8e1cf",
      codeForeground: "#1d1b18",
    },
  },
  look: { fontUi: KAI, fontCode: CODE, radius: 2, shadow: 20, density: 100 },
  css: CSS,
};
