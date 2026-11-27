import { expect, it } from "vite-plus/test";

import { applyThemeCss } from "../../themeCss";
import { getPresetThemes } from "../../themePalette";

// A preset's CSS goes into the one adopted sheet that holds the active theme's text, so its
// `:root` variables and attribute rules cannot reach another preset or the default theme.
const PRESETS = getPresetThemes();
const OMP = PRESETS.find((preset) => preset.id === "studio-omp");
const QUIET = PRESETS.find((preset) => preset.id === "studio-quiet");
if (OMP?.css === undefined || QUIET?.css === undefined) {
  throw new Error("Expected the omp and quiet presets to both ship CSS");
}

it("keeps a preset's rules out of the theme that replaces it", () => {
  const probe = document.createElement("div");
  probe.dataset.toolStatus = "error";
  document.body.append(probe);
  using _probe = { [Symbol.dispose]: () => probe.remove() };
  using _css = { [Symbol.dispose]: () => applyThemeCss(undefined) };
  const root = document.documentElement;

  applyThemeCss(OMP.css);
  expect(getComputedStyle(root).getPropertyValue("--t3x-omp-bg").trim()).not.toBe("");
  expect(getComputedStyle(root).fontVariantLigatures).toBe("none");
  expect(getComputedStyle(probe).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");

  applyThemeCss(QUIET.css);
  expect(
    document.adoptedStyleSheets
      .flatMap((sheet) => Array.from(sheet.cssRules, (rule) => rule.cssText))
      .join("\n"),
  ).not.toContain("--t3x-omp");
  expect(getComputedStyle(root).getPropertyValue("--t3x-omp-bg").trim()).toBe("");
  expect(getComputedStyle(root).fontVariantLigatures).not.toBe("none");
  expect(getComputedStyle(probe).backgroundColor).toBe("rgba(0, 0, 0, 0)");

  applyThemeCss(undefined);
  expect(
    document.adoptedStyleSheets.flatMap((sheet) =>
      Array.from(sheet.cssRules, (rule) => rule.cssText),
    ),
  ).toEqual([]);
});
