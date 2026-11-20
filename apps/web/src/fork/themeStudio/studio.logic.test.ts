import { describe, expect, it } from "vite-plus/test";

import { getPresetThemes, getThemeDefinition, parseThemeFile } from "../../themePalette";
import {
  beginScheme,
  editableAppearance,
  hasUnsavedChanges,
  overriddenSettings,
  restoreSchemeToPreset,
  sameAppearanceOf,
  withSchemeColors,
  withSchemeCss,
  withSchemeLook,
} from "./studio.logic";

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
});

describe("palettes", () => {
  it("edits the appearance on screen, or the scheme's own when it has no such palette", () => {
    expect(editableAppearance(terminal, "light")).toBe("dark");
    expect(editableAppearance(terminal, "dark")).toBe("dark");
    const fjord = getThemeDefinition("studio-fjord")!;
    expect(editableAppearance(fjord, "light")).toBe("light");
  });
});

describe("user settings a look overrides", () => {
  it("names fonts and chat width, nothing else", () => {
    expect(overriddenSettings(undefined)).toEqual([]);
    expect(overriddenSettings({ radius: 2, density: 90 })).toEqual([]);
    expect(overriddenSettings({ fontUi: "Georgia", chatWidth: "wide" })).toEqual([
      "fontUi",
      "chatWidth",
    ]);
  });
});
