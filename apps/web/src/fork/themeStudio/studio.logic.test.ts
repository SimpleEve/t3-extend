import { describe, expect, it, vi } from "vite-plus/test";

import { readThemePreference } from "../../hooks/useTheme";

import {
  getPresetThemes,
  getThemeDefinition,
  isKnownThemePreference,
  parseThemeFile,
  parseThemeHalves,
} from "../../themePalette";
import {
  beginScheme,
  editableAppearance,
  hasUnsavedChanges,
  halvesWithout,
  overriddenSettings,
  placeTheme,
  STOCK_THEME_ID,
  studioOrigin,
  studioThemeKind,
  restoreSchemeToPreset,
  schemeBase,
  sameAppearanceOf,
  withSchemeColors,
  withSchemeCss,
  withSchemeLook,
} from "./studio.logic";
import { locateColorRole } from "./colorFamilies";
import { inspectorReducer } from "./colorInspector.logic";
import { intentFromEditorSession } from "./themeStudioStore";

const terminal = getThemeDefinition("studio-terminal")!;
const mine = (savedThemes: ReturnType<typeof getPresetThemes> = []) =>
  beginScheme({ base: terminal, savedThemes, mineLabel: "Terminal (mine)", restorable: true });

describe("editing a preset", () => {
  it("forks it into a scheme that remembers the preset and leaves the preset alone", () => {
    const scheme = mine();
    expect(scheme).toMatchObject({
      id: "studio-terminal-mine",
      label: "Terminal (mine)",
      basedOn: "studio-terminal",
      look: terminal.look,
      css: terminal.css,
    });
    const edited = withSchemeLook(scheme, "radius", 12);
    expect(edited.look?.radius).toBe(12);
    expect(terminal.look?.radius).toBe(0);
    expect(getThemeDefinition("studio-terminal")).toBe(terminal);
  });

  it("edits a saved scheme in place instead of forking again", () => {
    const saved = mine();
    expect(
      beginScheme({ base: saved, savedThemes: [saved], mineLabel: "x", restorable: true }),
    ).toBe(saved);
  });

  it("gives a second fork its own id and name", () => {
    const first = mine();
    const second = mine([first]);
    expect(second.id).toBe("studio-terminal-mine-2");
    expect(second.label).toBe("Terminal (mine) 2");
  });

  it("keeps ids and names within their limits", () => {
    const long = { ...terminal, id: "a".repeat(48) };
    const forked = beginScheme({
      base: long,
      savedThemes: [],
      mineLabel: "n".repeat(60),
      restorable: false,
    });
    expect(forked.id.length).toBeLessThanOrEqual(48);
    expect(forked.label.length).toBeLessThanOrEqual(48);
    expect(forked).not.toHaveProperty("basedOn");
    expect(() => parseThemeFile({ version: 1, ...asFile(forked) })).not.toThrow();
  });
});

function asFile(theme: ReturnType<typeof mine>) {
  return { id: theme.id, name: theme.label, appearance: theme.appearance, colors: theme.colors };
}

describe("restoring to the preset", () => {
  it("puts colors, CSS and look back but keeps the scheme's name and id", () => {
    const scheme = withSchemeCss(
      withSchemeLook(
        withSchemeColors(mine(), "dark", { ...terminal.colors, accent: "#ff0000" }),
        "density",
        120,
      ),
      "",
    );
    expect(sameAppearanceOf(scheme, terminal)).toBe(false);

    const restored = restoreSchemeToPreset({ ...scheme, label: "My terminal" }, terminal);
    expect(restored.label).toBe("My terminal");
    expect(restored.id).toBe("studio-terminal-mine");
    expect(restored.basedOn).toBe("studio-terminal");
    expect(sameAppearanceOf(restored, terminal)).toBe(true);
  });

  it("drops a variant the preset does not have", () => {
    const withVariant = withSchemeColors(mine(), "light", terminal.colors);
    expect(withVariant.variants?.light).toBeDefined();
    expect(restoreSchemeToPreset(withVariant, terminal).variants).toBeUndefined();
  });
});

describe("what counts as a change", () => {
  it("is nothing without a draft", () => {
    expect(hasUnsavedChanges(null, null, terminal)).toBe(false);
  });

  it("compares a fork nobody saved with the preset it came from", () => {
    expect(hasUnsavedChanges(mine(), null, terminal)).toBe(false);
    expect(hasUnsavedChanges(withSchemeLook(mine(), "radius", 12), null, terminal)).toBe(true);
    // Editing a value and putting it back is no change.
    const there = withSchemeLook(mine(), "radius", 9);
    expect(
      hasUnsavedChanges(withSchemeLook(there, "radius", terminal.look?.radius), null, terminal),
    ).toBe(false);
  });

  it("compares a saved scheme with its stored copy, including the name", () => {
    const saved = mine();
    expect(hasUnsavedChanges({ ...saved }, saved, terminal)).toBe(false);
    expect(hasUnsavedChanges(withSchemeLook(saved, "shadow", 10), saved, terminal)).toBe(true);
    expect(hasUnsavedChanges(withSchemeCss(saved, "a{}"), saved, terminal)).toBe(true);
    expect(hasUnsavedChanges({ ...saved, label: "Renamed" }, saved, terminal)).toBe(true);
  });

  it("clears a look setting and the look itself once nothing is left", () => {
    const bare = { ...mine(), look: { radius: 3 } };
    const cleared = withSchemeLook(bare, "radius", undefined);
    expect(cleared).not.toHaveProperty("look");
  });

  it("counts a background image chosen, replaced or removed as a change", () => {
    const saved = mine();
    const hash = "a".repeat(64);
    const chosen = withSchemeLook(saved, "background", hash);
    expect(chosen.look?.background).toBe(hash);
    expect(hasUnsavedChanges(chosen, saved, terminal)).toBe(true);
    expect(
      hasUnsavedChanges(withSchemeLook(chosen, "background", "b".repeat(64)), chosen, terminal),
    ).toBe(true);
    // Removing the only setting leaves no look, and a scheme that never had an image is unchanged.
    const { look: _look, ...unstyled } = saved;
    const imageOnly = withSchemeLook(unstyled, "background", hash);
    expect(imageOnly.look).toEqual({ background: hash });
    expect(withSchemeLook(imageOnly, "background", undefined)).not.toHaveProperty("look");
  });
});

describe("palettes", () => {
  it("edits the appearance on screen, or the scheme's own when it has no such palette", () => {
    expect(editableAppearance(terminal, "light")).toBe("dark");
    expect(editableAppearance(terminal, "dark")).toBe("dark");
    const docs = getThemeDefinition("studio-docs")!;
    expect(editableAppearance(docs, "dark")).toBe("dark");
  });
});

describe("a preset that was retired", () => {
  const retired = [
    "studio-oled",
    "studio-paper",
    "studio-fjord",
    "studio-tide",
    "studio-clay",
    "studio-graphite",
    "studio-frosted",
    "studio-compact",
  ];

  it("leaves a scheme made from it working, with no preset to restore", () => {
    for (const id of retired) {
      expect(getThemeDefinition(id)).toBeNull();
      const scheme = { ...mine(), basedOn: id };
      expect(getThemeDefinition(scheme.basedOn)).toBeNull();
      expect(
        beginScheme({ base: scheme, savedThemes: [scheme], mineLabel: "x", restorable: true }),
      ).toBe(scheme);
    }
  });

  it("treats a selected retired preset like an unpublished theme", () => {
    for (const id of retired) expect(isKnownThemePreference(id)).toBe(false);
    expect(
      parseThemeHalves(JSON.stringify({ light: "studio-paper", dark: "studio-terminal" })),
    ).toEqual({ dark: "studio-terminal" });
    expect(
      studioOrigin({
        themeId: "studio-oled",
        find: getThemeDefinition,
        applied: null,
        stock: terminal,
      }),
    ).toEqual({ origin: terminal, restorable: false });
  });

  it("does not take a saved theme with a retired id for the preset a scheme came from", () => {
    const imported = { ...mine(), id: "studio-paper", label: "Imported" };
    const scheme = { ...mine(), basedOn: "studio-paper" };
    // getThemeDefinition falls through to saved themes, so it finds the import.
    const find = (id: string) => (id === imported.id ? imported : getThemeDefinition(id));
    expect(find("studio-paper")).toBe(imported);
    expect(schemeBase(scheme.basedOn, find, [imported, scheme])).toBeNull();
    expect(schemeBase("studio-terminal", find, [imported, scheme])).toBe(terminal);
    expect(schemeBase(undefined, find, [imported])).toBeNull();
  });

  it("forgets a stored choice of a retired preset, and leaves other unknown ids alone", () => {
    const stored = new Map<string, string>([["t3code:theme", "studio-paper"]]);
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => stored.get(key) ?? null,
        setItem: (key: string, value: string) => stored.set(key, value),
        removeItem: (key: string) => stored.delete(key),
      },
    });
    try {
      expect(readThemePreference()).toBe("system");
      expect(stored.has("t3code:theme")).toBe(false);
      // An unpublished environment theme may come back, so its id stays.
      stored.set("t3code:theme", "from-a-server");
      expect(readThemePreference()).toBe("system");
      expect(stored.get("t3code:theme")).toBe("from-a-server");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the new presets under their own ids", () => {
    const ids = getPresetThemes().map((preset) => preset.id);
    expect(ids).toHaveLength(11);
    expect(ids.filter((id) => retired.includes(id))).toEqual([]);
  });
});

describe("user settings a look overrides", () => {
  it("names fonts and chat width, nothing else", () => {
    expect(overriddenSettings(undefined)).toEqual([]);
    expect(overriddenSettings({ radius: 2, density: 90 })).toEqual([]);
    expect(overriddenSettings({ background: "a".repeat(64), glass: 40 })).toEqual([]);
    expect(overriddenSettings({ fontUi: "Georgia", chatWidth: "wide" })).toEqual([
      "fontUi",
      "chatWidth",
    ]);
  });
});

describe("the theme library's editor buttons", () => {
  it("open the studio on the theme to edit, or on a copy for Duplicate and Create", () => {
    expect(
      intentFromEditorSession({ editingThemeId: "mine", seedThemeId: null, seedName: null }),
    ).toEqual({ themeId: "mine", duplicate: false, name: null });
    expect(
      intentFromEditorSession({
        editingThemeId: null,
        seedThemeId: "studio-neon",
        seedName: "Neon copy",
      }),
    ).toEqual({ themeId: "studio-neon", duplicate: true, name: "Neon copy" });
    expect(
      intentFromEditorSession({ editingThemeId: null, seedThemeId: null, seedName: null }),
    ).toEqual({ themeId: null, duplicate: true, name: null });
  });
});

describe("separate light and dark themes", () => {
  it("puts an edited theme in the half in use and keeps the other half", () => {
    expect(placeTheme({ light: "a", dark: "b" }, "light", "c")).toEqual({
      kind: "half",
      appearance: "light",
      themeId: "c",
    });
    // One half alone is still a mix: the whole theme must not replace it.
    expect(placeTheme({ dark: "b" }, "light", "c")).toMatchObject({ kind: "half" });
  });

  it("replaces the whole theme only when there is no mix to keep", () => {
    expect(placeTheme({}, "dark", "c")).toEqual({ kind: "whole", themeId: "c" });
  });

  it("drops a removed theme from the halves and keeps the rest", () => {
    expect(halvesWithout({ light: "a", dark: "b" }, "a")).toEqual({ dark: "b" });
    expect(halvesWithout({ light: "a", dark: "a" }, "a")).toEqual({});
    expect(halvesWithout({ dark: "b" }, "a")).toEqual({ dark: "b" });
  });
});

describe("what the studio copies or opens", () => {
  const grove = { ...terminal, id: "grove", label: "Grove" };
  const stock = { ...terminal, id: STOCK_THEME_ID, label: "Stock" };
  const find = (id: string) => (id === "grove" ? grove : id === terminal.id ? terminal : null);

  it("copies the stock theme when its card was clicked, not the theme in use", () => {
    expect(studioOrigin({ themeId: STOCK_THEME_ID, find, applied: grove, stock })).toEqual({
      origin: stock,
      restorable: false,
    });
  });

  it("copies the theme that was named, or the one in use when none was", () => {
    expect(studioOrigin({ themeId: terminal.id, find, applied: grove, stock })).toEqual({
      origin: terminal,
      restorable: true,
    });
    expect(studioOrigin({ themeId: null, find, applied: grove, stock })).toEqual({
      origin: grove,
      restorable: true,
    });
    expect(studioOrigin({ themeId: null, find, applied: null, stock })).toEqual({
      origin: stock,
      restorable: false,
    });
  });
});

describe("what kind of theme the header names", () => {
  const ids = {
    presetIds: new Set(["studio-terminal"]),
    builtInIds: new Set(["grove"]),
    savedIds: new Set(["studio-terminal-mine", "imported"]),
  };

  it("tells presets, built-in themes, saved schemes and published themes apart", () => {
    const kind = (id: string, stock = false) => studioThemeKind({ id, stock, ...ids });
    expect(kind("studio-terminal")).toBe("preset");
    // A built-in theme is not published by anyone, so it must not be called that.
    expect(kind("grove")).toBe("builtIn");
    expect(kind("studio-terminal-mine")).toBe("scheme");
    expect(kind("imported")).toBe("scheme");
    expect(kind("agent-look")).toBe("published");
    expect(kind(STOCK_THEME_ID, true)).toBe("default");
  });
});

describe("finding a color picked from the app", () => {
  it("lands on the visible role of the family the role belongs to", () => {
    // `chrome` follows the Background row, which is always shown.
    expect(locateColorRole("chrome")).toEqual({ role: "canvas", needsAllColors: false });
    expect(locateColorRole("accent")).toEqual({ role: "accent", needsAllColors: false });
    // `toolbarBorder` follows the Border family, which sits under "All colors".
    expect(locateColorRole("toolbarBorder")).toEqual({ role: "border", needsAllColors: true });
  });
});

describe("picking a color from the app", () => {
  const idle = { phase: "idle", selection: null } as const;

  it("shows where the color is used before Settings comes back, and keeps the pick after", () => {
    const picking = inspectorReducer(idle, { type: "start" });
    expect(picking).toEqual({ phase: "picking", selection: null });
    const showing = inspectorReducer(picking, { type: "picked", role: "chrome" });
    expect(showing.phase).toBe("showing");
    // `chrome` follows the Background row, so that row is the one to find.
    expect(showing.selection).toMatchObject({ role: "canvas" });
    expect(showing.selection?.roles).toContain("chrome");
    const back = inspectorReducer(showing, { type: "back" });
    expect(back).toEqual({ phase: "idle", selection: showing.selection });
  });

  it("treats Esc as going back once something is picked, and as cancelling before that", () => {
    const picking = inspectorReducer(idle, { type: "start" });
    expect(inspectorReducer(picking, { type: "escape" })).toEqual(idle);
    const showing = inspectorReducer(picking, { type: "picked", role: "accent" });
    expect(inspectorReducer(showing, { type: "escape" }).selection).toEqual(showing.selection);
    expect(inspectorReducer(showing, { type: "escape" }).phase).toBe("idle");
  });

  it("ignores a pick that arrives outside picking, and counts each pick", () => {
    expect(inspectorReducer(idle, { type: "picked", role: "accent" })).toBe(idle);
    const first = inspectorReducer(inspectorReducer(idle, { type: "start" }), {
      type: "picked",
      role: "accent",
    });
    const second = inspectorReducer(inspectorReducer(first, { type: "back" }), { type: "start" });
    expect(second.selection).toBeNull();
    expect(
      inspectorReducer(second, { type: "picked", role: "accent" }).selection?.pick,
    ).toBeGreaterThan(0);
  });
});
