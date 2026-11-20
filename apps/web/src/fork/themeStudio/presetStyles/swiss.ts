import type { ThemePresetSeed } from "../presets";

// fork: Swiss grid. White, black and one red; numbered thread rows come from a CSS counter.
const SANS =
  '"Helvetica Neue", Helvetica, Arial, "Nimbus Sans", "PingFang SC", "Microsoft YaHei", sans-serif';
const MONO = 'Menlo, "SF Mono", Consolas, "Liberation Mono", monospace';

const CSS = `:root { --red: #e30613; --black: #111111; }

[data-slot="sidebar-inner"] { counter-reset: swiss-thread; }
[data-thread-item] { counter-increment: swiss-thread; }
[data-thread-item] [data-sidebar-row] { border-radius: 0 !important; font-weight: 500; }
[data-thread-item] [data-sidebar-row]::before {
  content: counter(swiss-thread, decimal-leading-zero);
  order: -1;
  flex: none;
  margin-right: 8px;
  color: #ff6d77;
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
[data-slot="sidebar-inner"] { --primary: #ff4d5a; }
[data-thread-item] [data-sidebar-row][aria-current="page"] { background: var(--red) !important; }
[data-thread-item] [data-sidebar-row][aria-current="page"],
[data-thread-item] [data-sidebar-row][aria-current="page"] *,
[data-thread-item] [data-sidebar-row][aria-current="page"]::before { color: #fff !important; }

[data-chat-header] {
  border-bottom: 4px solid var(--black) !important;
  font-weight: 700;
  letter-spacing: -0.02em;
}

[data-message-role="user"] [data-user-message-bubble] {
  background: var(--red) !important;
  color: #fff !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
  font-weight: 600;
}
[data-message-role="user"] [data-user-message-bubble] * { color: inherit; }

.chat-markdown h1, .chat-markdown h2, .chat-markdown h3 {
  font-weight: 800;
  letter-spacing: -0.045em;
  line-height: 1.05;
}
.chat-markdown h1 { font-size: 2.1em; }
.chat-markdown h2 { font-size: 1.7em; }
.chat-markdown h3 { font-size: 1.35em; }
.chat-markdown a { color: var(--red) !important; text-decoration: underline; text-underline-offset: 3px; }
.chat-markdown-codeblock {
  border: 0 !important;
  border-left: 4px solid var(--red) !important;
  border-radius: 0 !important;
}
.chat-markdown table { border-top: 4px solid var(--black); }
.chat-markdown th { font-weight: 800; letter-spacing: -0.02em; border-bottom: 2px solid var(--black); }

[data-slot="composer-host"] {
  border: 2px solid var(--black) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
[data-slot="composer-host"]:focus-within { border-color: var(--red) !important; }

[data-slot="button"], [data-slot="input"], [data-slot="select-trigger"] { border-radius: 0 !important; }
[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"],
[data-slot="select-popup"], [data-slot="alert-dialog-popup"], [data-slot="toast-popup"] {
  border: 2px solid var(--black) !important;
  box-shadow: none !important;
}
svg.lucide { stroke-width: 2; stroke-linecap: butt; stroke-linejoin: miter; }
`;

export const SWISS_SEED: ThemePresetSeed = {
  id: "studio-swiss",
  label: "Swiss grid",
  appearance: "light",
  palette: {
    canvas: "#ffffff",
    accent: "#e30613",
    colors: {
      text: "#111111",
      textMuted: "#595959",
      secondaryLabel: "#595959",
      mutedForeground: "#595959",
      border: "#d9d9d9",
      input: "#111111",
      focus: "#e30613",
      accentForeground: "#ffffff",
      messageSurface: "#e30613",
      messageForeground: "#ffffff",
      messageAction: "#e30613",
      messageActionForeground: "#ffffff",
      messageActionHover: "#b8050f",
      surface: "#ffffff",
      surfaceRaised: "#f5f5f5",
      surfaceOverlay: "#ffffff",
      secondary: "#f2f2f2",
      secondaryForeground: "#111111",
      muted: "#f2f2f2",
      accentSurface: "#f2f2f2",
      accentSurfaceForeground: "#111111",
      toolbarControl: "#f2f2f2",
      toolbarControlHover: "#e6e6e6",
      codeBackground: "#f2f2f2",
      codeForeground: "#111111",
      sidebar: "#111111",
      sidebarForeground: "#ffffff",
      sidebarMutedForeground: "#b8b8b8",
      sidebarControlSurface: "#1d1d1d",
      sidebarRowHover: "#262626",
      sidebarRowActive: "#e30613",
      sidebarRowSelected: "#e30613",
      sidebarBorder: "#111111",
    },
  },
  look: { fontUi: SANS, fontCode: MONO, radius: 0, shadow: 0, density: 100 },
  css: CSS,
};
