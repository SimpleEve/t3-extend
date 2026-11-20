import { THEME_COLOR_ROLES } from "@t3tools/shared/themePalettes";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  CUSTOM_THEMES_STORAGE_KEY,
  getCustomThemes,
  getPresetThemes,
  getThemeDefinition,
  installCustomTheme,
  invalidateCustomThemes,
  isReservedThemeId,
  parseThemeFile,
  publishedThemeDefinitions,
  serializeThemeFile,
  THEME_FILE_VERSION,
} from "../../themePalette";
import { THEME_PRESET_SEEDS } from "./presets";
import { applyThemeLook, getActiveThemeLook } from "./themeLook";

const FILE = {
  version: THEME_FILE_VERSION,
  id: "mono",
  name: "Mono",
  appearance: "dark",
  colors: { canvas: "#101010", accent: "#33ff66" },
} as const;

describe("theme look in theme files", () => {
  it("round-trips a look and the preset it started from through export and import", () => {
    const look = {
      fontCode: "Menlo, monospace",
      radius: 0,
      density: 90,
      chatWidth: "full",
    } as const;
    const theme = parseThemeFile({ ...FILE, look, basedOn: "studio-terminal" });
    expect(theme.look).toEqual(look);

    const exported = JSON.parse(serializeThemeFile(theme));
    expect(exported.look).toEqual(look);
    expect(exported.basedOn).toBe("studio-terminal");
    expect(parseThemeFile(exported)).toEqual(theme);
  });

  it("leaves a file without a look exactly as before", () => {
    const theme = parseThemeFile(FILE);
    expect(theme).not.toHaveProperty("look");
    expect(JSON.parse(serializeThemeFile(theme))).not.toHaveProperty("look");
  });

  it("refuses a look with an out-of-range value or an unknown key", () => {
    expect(() => parseThemeFile({ ...FILE, look: { radius: 99 } })).toThrow(/radius/);
    expect(() => parseThemeFile({ ...FILE, look: { fontUi: "x; y" } })).toThrow(/fontUi/);
    expect(() => parseThemeFile({ ...FILE, look: { sparkle: 1 } })).toThrow(/not a supported/);
    expect(() => parseThemeFile({ ...FILE, basedOn: "Not An Id" })).toThrow(/basedOn/);
  });

  it("keeps a look on a saved theme and repairs a bad one without losing the theme", () => {
    const stored = new Map<string, string>();
    stored.set(
      CUSTOM_THEMES_STORAGE_KEY,
      JSON.stringify([
        {
          id: "kept",
          label: "Kept",
          appearance: "dark",
          colors: { canvas: "#101010" },
          look: { radius: 2, density: 500, shadow: "x", unknown: 1 },
          basedOn: "studio-oled",
        },
      ]),
    );
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
      },
    });
    invalidateCustomThemes();
    try {
      expect(getCustomThemes()).toMatchObject([
        { id: "kept", look: { radius: 2, density: 120 }, basedOn: "studio-oled" },
      ]);
      installCustomTheme(parseThemeFile({ ...FILE, look: { glass: 20 } }));
      expect(JSON.parse(stored.get(CUSTOM_THEMES_STORAGE_KEY) ?? "[]")[1].look).toEqual({
        glass: 20,
      });
    } finally {
      vi.unstubAllGlobals();
      invalidateCustomThemes();
    }
  });

  it("carries a published theme's look into the palette and ignores a malformed one", () => {
    const [published, malformed] = publishedThemeDefinitions([
      {
        id: "agent-look",
        name: "Agent Look",
        appearance: "dark",
        canvas: "#101010",
        accent: "#7aa2f7",
        look: { radius: 4, shadow: 20 },
      },
      {
        id: "bad-look",
        name: "Bad Look",
        appearance: "dark",
        canvas: "#101010",
        accent: "#7aa2f7",
        look: { radius: 400 } as never,
      },
    ]);
    expect(published?.look).toEqual({ radius: 4, shadow: 20 });
    expect(malformed?.look).toEqual({ radius: 24 });
  });
});

describe("theme presets", () => {
  const presets = getPresetThemes();

  it("resolve like built-in themes, each with a look and every color role", () => {
    expect(presets).toHaveLength(THEME_PRESET_SEEDS.length);
    expect(presets.length).toBeGreaterThanOrEqual(8);
    for (const preset of presets) {
      expect(getThemeDefinition(preset.id)).toBe(preset);
      expect(preset.look && Object.keys(preset.look).length).toBeGreaterThan(0);
      expect(Object.keys(preset.colors).toSorted()).toEqual([...THEME_COLOR_ROLES].toSorted());
      expect(isReservedThemeId(preset.id)).toBe(true);
    }
    expect(new Set(presets.map((preset) => preset.id)).size).toBe(presets.length);
  });

  it("keeps the Terminal colors people already use and moves font, corners and shadows to the look", () => {
    const terminal = getThemeDefinition("studio-terminal");
    expect(terminal?.look).toMatchObject({ radius: 0, shadow: 0 });
    expect(terminal?.look?.fontUi).toContain("JetBrains Mono");
    expect(terminal?.css).toContain("user@t3 ~ $");
    expect(terminal?.css).not.toMatch(/font-family|border-radius|box-shadow/);
    expect(terminal?.colors.accent).toBe(
      parseThemeFile({ ...FILE, colors: { accent: "#3ee27a" } }).colors.accent,
    );
  });

  it("only name installed fonts and never load one", () => {
    for (const seed of THEME_PRESET_SEEDS) {
      expect(`${seed.look.fontUi ?? ""}${seed.look.fontCode ?? ""}`).not.toMatch(
        /url\(|@import|http/,
      );
      expect(seed.css ?? "").not.toMatch(/@import|@font-face|url\(/);
    }
  });

  it("cannot be taken by a saved theme", () => {
    expect(() => parseThemeFile({ ...FILE, id: "studio-oled" })).toThrow(/reserved/);
  });
});

describe("applying a look", () => {
  it("writes shape variables and glass on the root and clears them with the next theme", () => {
    const style = new Map<string, string>();
    const dataset: Record<string, string> = {};
    vi.stubGlobal("document", {
      documentElement: {
        style: {
          setProperty: (name: string, value: string) => style.set(name, value),
          removeProperty: (name: string) => style.delete(name),
        },
        dataset,
      },
    });
    try {
      applyThemeLook({ radius: 0, density: 85, glass: 40, shadow: 0 });
      expect(style.get("--radius")).toBe("0rem");
      expect(style.get("--spacing")).toBe("0.2125rem");
      expect(style.get("--theme-panel-alpha")).toBe("60%");
      expect(style.get("--shadow-md")).toContain("0.000");
      expect(dataset).toHaveProperty("themeGlass");
      expect(getActiveThemeLook()).toEqual({ radius: 0, density: 85, glass: 40, shadow: 0 });

      applyThemeLook(undefined);
      expect([...style.keys()]).toEqual([]);
      expect(dataset).not.toHaveProperty("themeGlass");
      expect(getActiveThemeLook()).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
