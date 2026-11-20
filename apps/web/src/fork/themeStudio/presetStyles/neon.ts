import type { ThemePresetSeed } from "../presets";

// fork: Neon. Deep purple, pink and cyan edges, a horizon grid. The glow is a static
// box-shadow or text-shadow; nothing animates.
const SANS = '"Avenir Next", Avenir, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif';
const MONO = 'Menlo, "SF Mono", Consolas, "Liberation Mono", monospace';

const CSS = `:root { --t3x-pink: #ff3cac; --t3x-cyan: #00f0ff; --t3x-yellow: #ffd23f; }

[data-workspace-area="conversation"] {
  background-image:
    linear-gradient(transparent 62%, rgba(255, 60, 172, 0.12) 62%, transparent),
    repeating-linear-gradient(90deg, transparent 0 30px, rgba(0, 240, 255, 0.07) 30px 31px);
}

/* Glow is kept to a few things: the user's bubble, the composer, the current row and code blocks. */
[data-slot="sidebar-inner"] { border-right: 1px solid var(--t3x-pink); }
[data-thread-item] [data-sidebar-row][aria-current="page"] {
  color: var(--t3x-cyan);
  text-shadow: 0 0 5px rgba(0, 240, 255, 0.6);
  box-shadow: inset 2px 0 0 var(--t3x-cyan);
}
[data-chat-header] { border-bottom: 1px solid rgba(0, 240, 255, 0.45) !important; }

[data-message-role="user"] [data-user-message-bubble] {
  background: rgba(255, 60, 172, 0.08) !important;
  border: 1px solid var(--t3x-pink) !important;
  border-radius: 4px !important;
  box-shadow: 0 0 9px rgba(255, 60, 172, 0.55), inset 0 0 6px rgba(255, 60, 172, 0.25) !important;
}
.chat-markdown h1, .chat-markdown h2, .chat-markdown h3 { color: var(--t3x-yellow); }
.chat-markdown a { color: var(--t3x-cyan) !important; text-decoration: underline; }
.chat-markdown-codeblock {
  background: rgba(0, 0, 0, 0.45) !important;
  border: 1px solid var(--t3x-cyan) !important;
  border-radius: 3px !important;
  box-shadow: 0 0 8px rgba(0, 240, 255, 0.3);
}
.chat-markdown table { border: 1px solid rgba(0, 240, 255, 0.5); }
.chat-markdown th { color: var(--t3x-cyan); border-bottom: 1px solid var(--t3x-cyan); }

[data-slot="composer-host"] {
  background: rgba(10, 5, 24, 0.85) !important;
  border: 1px solid var(--t3x-cyan) !important;
  border-radius: 4px !important;
  box-shadow: 0 0 9px rgba(0, 240, 255, 0.45) !important;
}
[data-slot="composer-host"]:focus-within { border-color: var(--t3x-pink) !important; box-shadow: 0 0 10px rgba(255, 60, 172, 0.6) !important; }
.composer-tiptap { caret-color: var(--t3x-pink); }

[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"],
[data-slot="select-popup"], [data-slot="alert-dialog-popup"], [data-slot="toast-popup"] {
  border: 1px solid var(--t3x-pink) !important;
}
svg.lucide { stroke-width: 1.75; }
`;

export const NEON_SEED: ThemePresetSeed = {
  id: "studio-neon",
  label: "Neon",
  appearance: "dark",
  palette: {
    canvas: "#140a26",
    accent: "#ff3cac",
    colors: {
      text: "#e9dcff",
      textMuted: "#b9a8de",
      secondaryLabel: "#b9a8de",
      mutedForeground: "#b9a8de",
      iconMuted: "#9d89cc",
      border: "#3a1f63",
      input: "#55308f",
      focus: "#00f0ff",
      accentForeground: "#140a26",
      surface: "#1a0e30",
      surfaceRaised: "#221240",
      surfaceOverlay: "#221240",
      secondary: "#221240",
      secondaryForeground: "#e9dcff",
      muted: "#1a0e30",
      messageSurface: "#2a1450",
      messageForeground: "#e9dcff",
      messageAction: "#ff3cac",
      messageActionForeground: "#140a26",
      messageActionHover: "#ff6ac1",
      codeBackground: "#0b0518",
      codeForeground: "#00f0ff",
      sidebar: "#10071f",
      sidebarForeground: "#e9dcff",
      sidebarMutedForeground: "#b9a8de",
      sidebarControlSurface: "#1a0e30",
      sidebarRowHover: "#221240",
      sidebarRowActive: "#2a1450",
      sidebarRowSelected: "#2a1450",
      sidebarBorder: "#3a1f63",
    },
  },
  look: { fontUi: SANS, fontCode: MONO, radius: 4, shadow: 0, density: 100 },
  css: CSS,
};
