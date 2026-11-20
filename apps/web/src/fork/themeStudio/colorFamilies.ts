import type { ThemeColorRole } from "../../themePalette";

// fork: the groups of color roles the theme studio lists, moved here from the floating theme
// editor it replaced. A family is the roles that follow one visible role when it changes.

/** The two colors the studio always shows; every other role sits under "All colors". */
const ALWAYS_VISIBLE_ROLES: ReadonlyArray<ThemeColorRole> = ["canvas", "accent"];

export type ColorFamily = Readonly<{
  id: string;
  label: string;
  role: ThemeColorRole;
  roles: ReadonlyArray<ThemeColorRole>;
}>;

export const COLOR_GROUPS: ReadonlyArray<{
  id: string;
  title: string;
  families: ReadonlyArray<ColorFamily>;
}> = [
  {
    id: "foundation",
    title: "Foundation",
    families: [
      {
        id: "background",
        label: "Background",
        role: "canvas",
        roles: ["canvas", "chrome", "toolbar"],
      },
      { id: "surface", label: "Surface", role: "surface", roles: ["surface"] },
      {
        id: "raised-surface",
        label: "Raised surface",
        role: "surfaceRaised",
        roles: ["surfaceRaised"],
      },
      {
        id: "overlay",
        label: "Overlay",
        role: "surfaceOverlay",
        roles: ["surfaceOverlay"],
      },
      {
        id: "text",
        label: "Text",
        role: "text",
        roles: ["text", "toolbarForeground", "toolbarControlForeground"],
      },
      {
        id: "muted-text",
        label: "Muted text",
        role: "mutedForeground",
        roles: [
          "textMuted",
          "mutedForeground",
          "placeholder",
          "secondaryLabel",
          "iconMuted",
          "sidebarMutedForeground",
        ],
      },
      {
        id: "border",
        label: "Border",
        role: "border",
        roles: ["border", "toolbarBorder", "sidebarBorder"],
      },
      { id: "input", label: "Input", role: "input", roles: ["input"] },
    ],
  },
  {
    id: "brand-content",
    title: "Brand & content",
    families: [
      {
        id: "subtle-surface",
        label: "Subtle surface",
        role: "secondary",
        roles: ["secondary", "secondaryForeground", "muted", "toolbarControl"],
      },
      {
        id: "highlight-surface",
        label: "Highlight surface",
        role: "accentSurface",
        roles: ["accentSurface", "accentSurfaceForeground", "toolbarControlHover"],
      },
      {
        id: "accent",
        label: "Accent",
        role: "accent",
        roles: [
          "accent",
          "accentForeground",
          "focus",
          "update",
          "updateForeground",
          "updateSurface",
          "terminalCursor",
        ],
      },
      {
        id: "action",
        label: "Action",
        role: "messageAction",
        roles: ["messageAction", "messageActionForeground", "messageActionHover"],
      },
      {
        id: "message-surface",
        label: "Message surface",
        role: "messageSurface",
        roles: ["messageSurface", "messageForeground"],
      },
      {
        id: "code-surface",
        label: "Code surface",
        role: "codeBackground",
        roles: ["codeBackground", "codeForeground"],
      },
    ],
  },
  {
    id: "search",
    title: "Search",
    families: [
      {
        id: "search-matches",
        label: "Search matches",
        role: "searchMatchBackground",
        roles: ["searchMatchBackground", "searchMatchForeground"],
      },
      {
        id: "current-match",
        label: "Current match",
        role: "searchMatchActiveBackground",
        roles: ["searchMatchActiveBackground", "searchMatchActiveForeground"],
      },
    ],
  },
  {
    id: "context",
    title: "Context",
    families: [
      {
        id: "sidebar-background",
        label: "Sidebar background",
        role: "sidebar",
        roles: ["sidebar", "sidebarForeground"],
      },
      {
        id: "sidebar-controls",
        label: "Sidebar controls",
        role: "sidebarControlSurface",
        roles: ["sidebarControlSurface"],
      },
      {
        id: "sidebar-selection",
        label: "Sidebar selection",
        role: "sidebarRowSelected",
        roles: ["sidebarRowHover", "sidebarRowActive", "sidebarRowSelected"],
      },
      {
        id: "terminal-background",
        label: "Terminal background",
        role: "terminalBackground",
        roles: [
          "terminalBackground",
          "terminalForeground",
          "terminalSelection",
          "terminalScrollbar",
          "terminalScrollbarHover",
        ],
      },
    ],
  },
  {
    id: "status",
    title: "Status",
    families: [
      {
        id: "error",
        label: "Error",
        role: "error",
        roles: ["error", "errorForeground", "errorSurface"],
      },
      {
        id: "warning",
        label: "Warning",
        role: "warning",
        roles: ["warning", "warningForeground", "warningSurface"],
      },
    ],
  },
];

const COLOR_FAMILIES = COLOR_GROUPS.flatMap((group) => group.families);
const COLOR_FAMILY_BY_ROLE = new Map(
  COLOR_FAMILIES.flatMap((family) => family.roles.map((role) => [role, family] as const)),
);

export function colorFamilyOfRole(role: ThemeColorRole): ColorFamily | null {
  return COLOR_FAMILY_BY_ROLE.get(role) ?? null;
}

/**
 * Where a role found by picking from the app is shown: the visible role of its family, and
 * whether "All colors" has to be open to show it.
 */
export function locateColorRole(role: ThemeColorRole): {
  readonly role: ThemeColorRole;
  readonly needsAllColors: boolean;
} {
  const visible = colorFamilyOfRole(role)?.role ?? role;
  return { role: visible, needsAllColors: !ALWAYS_VISIBLE_ROLES.includes(visible) };
}
