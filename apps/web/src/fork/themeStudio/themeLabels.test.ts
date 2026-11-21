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

  it('shows the "(mine)" of a scheme made in another language in the current one', () => {
    const zh = (text: string, params?: Readonly<Record<string, string | number>>) =>
      text === "{name} (mine)" ? `${params?.name}（我的）` : text === "Terminal" ? "终端" : text;
    const saved = (label: string) => ({
      ...getThemeDefinition("studio-terminal")!,
      id: "mine-1",
      label,
    });
    expect(themeDisplayLabel(saved("T3 Extend (mine)"), zh)).toBe("T3 Extend（我的）");
    expect(themeDisplayLabel(saved("T3 Extend (mine) 2"), zh)).toBe("T3 Extend（我的） 2");
    expect(themeDisplayLabel(saved("Terminal (mine)"), zh)).toBe("终端（我的）");
    expect(themeDisplayLabel(saved("My Terminal"), zh)).toBe("My Terminal");
    expect(themeDisplayLabel(saved("Quiet (mine) copy"), zh)).toBe("Quiet (mine) copy");
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
