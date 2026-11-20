import { describe, expect, it } from "vite-plus/test";

import { getThemeDefinition } from "../../themePalette";
import { themeDisplayLabel } from "./themeDisplayLabel";

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
