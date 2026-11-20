import { describe, expect, it } from "vite-plus/test";

import { getThemeDefinition } from "../../themePalette";
import { copyName, themeDisplayLabel } from "./themeDisplayLabel";

describe("theme names in a language", () => {
  const t = (text: string) => `«${text}»`;

  it("translates our presets and the built-in themes, and leaves a person's own names alone", () => {
    expect(themeDisplayLabel(getThemeDefinition("studio-terminal")!, t)).toBe("«Terminal»");
    expect(themeDisplayLabel(getThemeDefinition("grove")!, t)).toBe("«Grove»");
    expect(
      themeDisplayLabel(
        { ...getThemeDefinition("studio-terminal")!, id: "terminal-mine", label: "Terminal" },
        t,
      ),
    ).toBe("Terminal");
  });
});

describe("the name of a copy", () => {
  it("puts the suffix through the translator and leaves the name itself alone", () => {
    const t = (text: string, params?: Readonly<Record<string, string | number>>) =>
      text === "{name} copy" ? `${params?.name}（副本）` : text;
    expect(copyName("Paper (mine)", t)).toBe("Paper (mine)（副本）");
    expect(copyName("纸张", t)).toBe("纸张（副本）");
  });
});
