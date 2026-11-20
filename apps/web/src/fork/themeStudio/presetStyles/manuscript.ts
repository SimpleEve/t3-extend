import type { ThemePresetSeed } from "../presets";

// fork: Manuscript. Lined paper with a red margin; replies in a typewriter face, the user's
// own messages in red pen. The tilt is small and only on the user's bubble.
const TYPEWRITER =
  '"American Typewriter", "Courier New", Courier, "Songti SC", "SimSun", monospace';
const HAND =
  '"Bradley Hand", "Segoe Print", "Kaiti SC", "STKaiti", "KaiTi", "Comic Sans MS", cursive';

const CSS = `:root { --pen: #b0281e; --paper-line: #e1eaf2; --margin-line: #e9a3a0; }

[data-workspace-area="conversation"] {
  background-image:
    linear-gradient(90deg, transparent 26px, var(--margin-line) 26px, var(--margin-line) 28px, transparent 28px),
    repeating-linear-gradient(transparent 0 27px, var(--paper-line) 27px 28px);
  background-attachment: local;
}
[data-slot="sidebar-inner"] { border-right: 1px solid #e3dccb; }
[data-thread-item] [data-sidebar-row] { border-radius: 2px !important; }
[data-thread-item] [data-sidebar-row][aria-current="page"] {
  background: #fff3a8 !important;
  transform: rotate(-0.6deg);
}

[data-chat-header] { border-bottom: 1px solid #d8cfba !important; }

[data-message-role="user"] [data-user-message-bubble] {
  background: transparent !important;
  color: var(--pen) !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  font-family: ${HAND};
  font-size: 1.18em;
  transform: rotate(-0.6deg);
  transform-origin: right center;
}
[data-message-role="user"] [data-user-message-bubble] * { color: inherit; }

.chat-markdown h1, .chat-markdown h2, .chat-markdown h3 {
  font-weight: 400;
  text-decoration: underline wavy var(--pen);
  text-underline-offset: 5px;
  text-decoration-thickness: 1px;
}
.chat-markdown a { color: var(--pen) !important; text-decoration: underline; }
.chat-markdown-codeblock {
  background: rgba(255, 255, 255, 0.75) !important;
  border: 1px solid #d8cfba !important;
  border-radius: 2px !important;
}
.chat-markdown :not(pre) > code { background: rgba(255, 243, 168, 0.6) !important; }
.chat-markdown table { background: rgba(251, 247, 236, 0.92); }

[data-slot="composer-host"] {
  background: rgba(251, 247, 236, 0.96) !important;
  border: 0 !important;
  border-bottom: 1px solid #2a2a2a !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"],
[data-slot="select-popup"], [data-slot="alert-dialog-popup"] {
  border: 1px solid #d8cfba !important;
  box-shadow: 2px 3px 0 rgba(42, 42, 42, 0.18) !important;
}
svg.lucide { stroke-width: 1.5; stroke-linecap: round; }
`;

export const MANUSCRIPT_SEED: ThemePresetSeed = {
  id: "studio-manuscript",
  label: "Manuscript",
  appearance: "light",
  palette: {
    canvas: "#fbf7ec",
    accent: "#b0281e",
    colors: {
      surface: "#fbf7ec",
      surfaceRaised: "#f6f0df",
      surfaceOverlay: "#fbf7ec",
      secondary: "#f2ebd9",
      secondaryForeground: "#2a2a2a",
      muted: "#f2ebd9",
      accentSurface: "#f5e6c4",
      accentSurfaceForeground: "#2a2a2a",
      toolbarControl: "#f2ebd9",
      toolbarControlHover: "#e9e0c8",
      text: "#2a2a2a",
      textMuted: "#6a6252",
      secondaryLabel: "#6a6252",
      mutedForeground: "#6a6252",
      border: "#ddd4bf",
      input: "#cdc2a8",
      focus: "#b0281e",
      accentForeground: "#ffffff",
      sidebar: "#f2ebd9",
      sidebarForeground: "#2a2a2a",
      sidebarMutedForeground: "#6a6252",
      sidebarRowActive: "#fff3a8",
      sidebarRowSelected: "#fff3a8",
      sidebarBorder: "#e3dccb",
      codeBackground: "#f4eedd",
      codeForeground: "#2a2a2a",
    },
  },
  look: { fontUi: TYPEWRITER, fontCode: TYPEWRITER, radius: 2, shadow: 20, density: 100 },
  css: CSS,
};
