import type { ThemePresetSeed } from "../presets";

// fork: Retro windows. Grey bevelled panels on a teal desktop. Every popup (dialogs, menus,
// popovers, selects, tooltips, toasts) gets the same bevel, so nothing looks borrowed from
// another theme. Bevels are inset box-shadows, so layout does not move.
const SYSTEM = 'Tahoma, Geneva, Verdana, "PingFang SC", "Microsoft YaHei", sans-serif';
const FIXED = '"Courier New", Courier, "SF Mono", Menlo, monospace';

const CSS = `:root {
  --w-face: #c0c0c0;
  --w-light: #ffffff;
  --w-hi: #dfdfdf;
  --w-shadow: #808080;
  --w-dark: #404040;
  --w-desk: #008080;
  --w-title: linear-gradient(90deg, #000080, #2a6ab8);
  --w-raised: inset 1px 1px 0 var(--w-light), inset -1px -1px 0 var(--w-dark), inset 2px 2px 0 var(--w-hi), inset -2px -2px 0 var(--w-shadow);
  --w-sunken: inset 1px 1px 0 var(--w-shadow), inset -1px -1px 0 var(--w-light), inset 2px 2px 0 var(--w-dark), inset -2px -2px 0 var(--w-hi);
}

/* the desktop frame, and a gap between the two panels */
html::after {
  content: "";
  position: fixed;
  inset: 0;
  border: 6px solid var(--w-desk);
  pointer-events: none;
  z-index: 2147483000;
}
[data-slot="sidebar-inner"] {
  position: relative;
  padding-top: 28px;
  border-top: 2px solid var(--w-light);
  border-left: 2px solid var(--w-light);
  border-bottom: 2px solid var(--w-dark);
  border-right: 6px solid var(--w-desk);
  box-shadow: var(--w-raised);
}
[data-slot="sidebar-inner"]::before {
  content: "Threads";
  position: absolute;
  top: 6px;
  left: 44px;
  right: 6px;
  height: 18px;
  padding: 0 6px;
  background: var(--w-title);
  color: #ffffff;
  font-size: 11px;
  font-weight: 700;
  line-height: 18px;
  z-index: 1;
}
:lang(zh) [data-slot="sidebar-inner"]::before { content: "对话"; }

[data-chat-header] {
  background: var(--w-title) !important;
  color: #ffffff;
  margin: 6px 6px 0 0;
  border: 0 !important;
  box-shadow: var(--w-raised);
}
[data-chat-header] :is(nav, nav *, svg.lucide, button) { color: #ffffff !important; }
[data-chat-header] [data-slot="badge"], [data-chat-header] [data-slot="badge"] * { color: #000000 !important; }

[data-workspace-area="conversation"] {
  background: #ffffff !important;
  margin: 0 6px 6px 0;
  box-shadow: var(--w-sunken);
}
[data-slot="sidebar-inset"] { background: var(--w-face); }

[data-thread-item] [data-sidebar-row] { border-radius: 0 !important; border: 1px solid transparent; }
[data-thread-item] [data-sidebar-row][aria-current="page"] {
  background: #000080 !important;
  outline: 1px dotted #ffffff;
  outline-offset: -2px;
}
[data-thread-item] [data-sidebar-row][aria-current="page"], [data-thread-item] [data-sidebar-row][aria-current="page"] * { color: #ffffff !important; }

[data-message-role="user"] [data-user-message-bubble] {
  background: #ffffe1 !important;
  color: #000000 !important;
  border: 1px solid #000000 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
.chat-markdown a { color: #0000ee !important; text-decoration: underline; }
.chat-markdown h1, .chat-markdown h2, .chat-markdown h3 { font-weight: 700; }
.chat-markdown-codeblock { border: 0 !important; border-radius: 0 !important; box-shadow: var(--w-sunken); font-family: ${FIXED}; }
.chat-markdown table { border: 1px solid var(--w-dark); }
.chat-markdown th { background: var(--w-face); box-shadow: var(--w-raised); }
.chat-markdown :is(th, td) { padding: 4px 10px !important; }

[data-slot="composer-host"], [data-slot="input"], [data-slot="textarea"], [data-slot="select-trigger"],
[data-slot="input-group"] {
  background: #ffffff !important;
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: var(--w-sunken) !important;
  color: #000000;
}

[data-slot="button"] {
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: var(--w-raised) !important;
  background-color: var(--w-face) !important;
  color: #000000 !important;
  --control-icon-color: #000000;
}
[data-slot="button"]:active { box-shadow: var(--w-sunken) !important; }
[data-slot="button"]:disabled { color: var(--w-shadow) !important; text-shadow: 1px 1px 0 var(--w-light); }
[data-slot="sidebar-inner"] [data-slot="button"], [data-chat-header] [data-slot="button"] {
  box-shadow: none !important;
  background-color: transparent !important;
}
[data-slot="sidebar-inner"] [data-slot="button"]:hover { box-shadow: var(--w-raised) !important; }
[data-chat-header] [data-slot="button"]:hover { box-shadow: inset 1px 1px 0 var(--w-light), inset -1px -1px 0 var(--w-dark) !important; background-color: rgba(255, 255, 255, 0.15) !important; }
[data-chat-header] [data-slot="button"] { color: #ffffff !important; --control-icon-color: #ffffff; }
[data-chat-header] [data-slot="badge"] { background: var(--w-face) !important; }

[data-slot="dialog-popup"], [data-slot="popover-popup"], [data-slot="menu-popup"],
[data-slot="select-popup"], [data-slot="alert-dialog-popup"], [data-slot="toast-popup"],
[data-slot="sheet-popup"], [data-slot="tooltip-popup"] {
  background: var(--w-face) !important;
  color: #000000 !important;
  border: 2px solid !important;
  border-color: var(--w-light) var(--w-dark) var(--w-dark) var(--w-light) !important;
  border-radius: 0 !important;
  box-shadow: 1px 1px 0 #000000, inset -1px -1px 0 var(--w-shadow), inset 1px 1px 0 var(--w-hi) !important;
  backdrop-filter: none !important;
}
[data-thread-details-card], [data-assistant-outputs] {
  border: 0 !important;
  border-radius: 0 !important;
  box-shadow: var(--w-raised) !important;
  background: var(--w-face) !important;
}
[data-slot="tooltip-popup"] { background: #ffffe1 !important; border-width: 1px !important; box-shadow: none !important; }
[data-slot="dialog-header"], [data-slot="alert-dialog-header"] { background: var(--w-title); color: #ffffff; margin: -1px -1px 0; padding: 4px 8px; }
[data-slot="dialog-header"] *, [data-slot="alert-dialog-header"] * { color: #ffffff !important; }
[data-slot="dialog-backdrop"], [data-slot="alert-dialog-backdrop"] { background: rgba(0, 128, 128, 0.55) !important; backdrop-filter: none !important; }
[data-slot="menu-item"][data-highlighted], [data-slot="menu-sub-trigger"][data-highlighted],
[data-slot="menu-radio-item"][data-highlighted], [data-slot="menu-checkbox-item"][data-highlighted],
[data-slot="select-item"][data-highlighted] {
  background: #000080 !important;
  color: #ffffff !important;
}
[data-slot="menu-item"][data-highlighted] *, [data-slot="select-item"][data-highlighted] * { color: #ffffff !important; }
[data-slot="menu-separator"] { background: var(--w-shadow); box-shadow: 0 1px 0 var(--w-light); }

::-webkit-scrollbar { width: 16px; height: 16px; }
::-webkit-scrollbar-track { background: var(--w-hi); }
::-webkit-scrollbar-thumb { background: var(--w-face); box-shadow: var(--w-raised); }
svg.lucide { stroke-width: 1.75; stroke-linecap: square; stroke-linejoin: miter; }
`;

export const RETRO_SEED: ThemePresetSeed = {
  id: "studio-retro",
  label: "Retro windows",
  appearance: "light",
  palette: {
    canvas: "#c0c0c0",
    accent: "#000080",
    colors: {
      text: "#000000",
      textMuted: "#404040",
      secondaryLabel: "#404040",
      mutedForeground: "#404040",
      placeholder: "#3c3c3c",
      iconMuted: "#404040",
      border: "#808080",
      input: "#808080",
      focus: "#000080",
      accentForeground: "#ffffff",
      accentSurface: "#dfdfdf",
      accentSurfaceForeground: "#000000",
      toolbarControl: "#c0c0c0",
      toolbarControlHover: "#dfdfdf",
      surface: "#c0c0c0",
      surfaceRaised: "#c0c0c0",
      surfaceOverlay: "#c0c0c0",
      secondary: "#c0c0c0",
      secondaryForeground: "#000000",
      muted: "#c0c0c0",
      messageSurface: "#ffffe1",
      messageForeground: "#000000",
      messageAction: "#000080",
      messageActionForeground: "#ffffff",
      messageActionHover: "#0000a0",
      codeBackground: "#ffffff",
      codeForeground: "#000000",
      sidebar: "#c0c0c0",
      sidebarForeground: "#000000",
      sidebarMutedForeground: "#404040",
      sidebarControlSurface: "#c0c0c0",
      sidebarRowHover: "#dfdfdf",
      sidebarRowActive: "#dfdfdf",
      sidebarRowSelected: "#dfdfdf",
      sidebarBorder: "#808080",
    },
  },
  look: { fontUi: SYSTEM, fontCode: FIXED, radius: 0, shadow: 0, density: 100 },
  css: CSS,
};
