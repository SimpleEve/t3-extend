import { THEME_LOOK_LIMITS, ThemeLook } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  parseThemeLook,
  sanitizeThemeLook,
  themeLookCssVariables,
  themeLooksEqual,
  withThemeLookValue,
} from "./forkThemeLook.ts";

const schemaAccepts = Schema.is(ThemeLook);
const HASH = "a".repeat(64);

describe("parseThemeLook", () => {
  it("accepts every field and treats an empty look as none", () => {
    const look = {
      fontUi: '"PingFang SC", system-ui',
      fontCode: "Menlo, monospace",
      radius: 0,
      density: 95,
      shadow: 0,
      chatWidth: "wide",
      glass: 40,
      background: HASH,
    };
    expect(parseThemeLook(look)).toEqual(look);
    expect(schemaAccepts(look)).toBe(true);
    expect(parseThemeLook({})).toBeUndefined();
    expect(parseThemeLook(undefined)).toBeUndefined();
  });

  // The importer and the server schema must refuse the same values.
  it.each([
    ["radius too large", { radius: THEME_LOOK_LIMITS.radius.max + 1 }],
    ["density too small", { density: THEME_LOOK_LIMITS.density.min - 1 }],
    ["fractional shadow", { shadow: 99.5 }],
    ["glass as text", { glass: "40" }],
    ["unknown chat width", { chatWidth: "huge" }],
    ["font stack that loads a file", { fontUi: "url(https://example.com/a.woff)" }],
    ["font stack with a declaration", { fontCode: "Menlo; color: red" }],
    ["empty font stack", { fontUi: "" }],
    ["background that is not a hash", { background: "../../etc/passwd" }],
    ["background with capital digits", { background: "A".repeat(64) }],
  ])("refuses %s", (_label, look) => {
    expect(() => parseThemeLook(look)).toThrow();
    expect(schemaAccepts(look)).toBe(false);
  });

  it("refuses a setting it does not know instead of dropping it", () => {
    expect(() => parseThemeLook({ radius: 4, corners: 4 })).toThrow(/not a supported look/);
    expect(() => parseThemeLook("rounded")).toThrow();
  });
});

describe("sanitizeThemeLook", () => {
  it("keeps valid values, clamps numbers and drops the rest", () => {
    expect(
      sanitizeThemeLook({
        fontUi: "Georgia, serif",
        fontCode: "bad(stack)",
        radius: 99,
        density: 50.4,
        shadow: "strong",
        chatWidth: "huge",
        glass: Number.NaN,
        background: "not-a-hash",
        extra: true,
      }),
    ).toEqual({ fontUi: "Georgia, serif", radius: 24, density: 80 });
    expect(sanitizeThemeLook({ background: HASH })).toEqual({ background: HASH });
    expect(sanitizeThemeLook(null)).toBeUndefined();
    expect(sanitizeThemeLook({ chatWidth: "huge" })).toBeUndefined();
  });
});

describe("look values", () => {
  it("sets, clears and compares one setting", () => {
    const withRadius = withThemeLookValue(undefined, "radius", 2);
    expect(withRadius).toEqual({ radius: 2 });
    expect(themeLooksEqual(withRadius, { radius: 2 })).toBe(true);
    expect(themeLooksEqual(withRadius, { radius: 3 })).toBe(false);
    expect(themeLooksEqual(undefined, {})).toBe(true);
    expect(withThemeLookValue(withRadius, "radius", undefined)).toBeUndefined();
  });
});

describe("themeLookCssVariables", () => {
  it("clears every variable when there is no look", () => {
    expect(Object.values(themeLookCssVariables(undefined)).every((value) => value === null)).toBe(
      true,
    );
  });

  it("writes the shape variables and scales shadows by strength", () => {
    const stock = themeLookCssVariables({ shadow: 100 });
    const flat = themeLookCssVariables({ shadow: 0 });
    expect(stock["--shadow-md"]).toBe(
      "0 4px 6px -1px rgb(0 0 0 / 0.100), 0 2px 4px -2px rgb(0 0 0 / 0.100)",
    );
    expect(flat["--shadow-md"]).toBe(
      "0 4px 6px -1px rgb(0 0 0 / 0.000), 0 2px 4px -2px rgb(0 0 0 / 0.000)",
    );
    expect(themeLookCssVariables({ radius: 0, density: 80 })).toMatchObject({
      "--radius": "0rem",
      "--spacing": "0.2rem",
    });
  });

  it("lets the larger corner sizes shrink with the radius, so zero is square everywhere", () => {
    // index.css derives each tier as `--radius ± step × --radius-grow`, clamped at zero.
    const grow = (radius: number) => themeLookCssVariables({ radius })["--radius-grow"];
    expect(grow(0)).toBe("0");
    expect(grow(4)).toBe("0.5");
    expect(grow(8)).toBe("1");
    expect(grow(24)).toBe("1");
    expect(themeLookCssVariables(undefined)["--radius-grow"]).toBeNull();
    expect(themeLookCssVariables({ radius: 0 })["--control-radius"]).toBe("0rem");
  });

  it("derives panel opacity and blur from glass, and none from zero", () => {
    expect(themeLookCssVariables({ glass: 40 })).toMatchObject({
      "--theme-panel-alpha": "60%",
      "--theme-panel-blur": "10px",
    });
    expect(themeLookCssVariables({ glass: 0 })["--theme-panel-alpha"]).toBeNull();
  });
});
