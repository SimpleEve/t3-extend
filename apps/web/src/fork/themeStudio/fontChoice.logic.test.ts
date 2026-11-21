import { isThemeLookFontStack } from "@t3tools/shared/forkThemeLook";
import { describe, expect, it } from "vite-plus/test";

import { curatedFamilies, familyOfStack, nextStack, stackOfFamily } from "./fontChoice.logic";

describe("familyOfStack", () => {
  it.each([
    [undefined, ""],
    ["", ""],
    ['"Georgia", serif', "Georgia"],
    ["Georgia, serif", "Georgia"],
    // A preset's own stack shows its first family, never "custom".
    ['"JetBrains Mono", "SF Mono", "Cascadia Mono", Menlo, monospace', "JetBrains Mono"],
    ["'Iowan Old Style', Palatino, serif", "Iowan Old Style"],
    ["serif, sans-serif", "serif"],
    ["monospace", "monospace"],
  ])("%s starts with %j", (stack, family) => {
    expect(familyOfStack(stack)).toBe(family);
  });
});

describe("stackOfFamily", () => {
  it("quotes the family and falls back to a generic a theme may carry", () => {
    expect(stackOfFamily("Georgia", "ui")).toBe('"Georgia", serif');
    expect(stackOfFamily("PingFang SC", "ui")).toBe('"PingFang SC", sans-serif');
    expect(stackOfFamily("Noto Sans SC", "ui")).toBe('"Noto Sans SC", sans-serif');
    expect(stackOfFamily("Songti SC", "ui")).toBe('"Songti SC", serif');
    expect(stackOfFamily("Hiragino Sans GB", "ui")).toBe('"Hiragino Sans GB", sans-serif');
    expect(stackOfFamily("JetBrains Mono", "code")).toBe('"JetBrains Mono", monospace');
    // A code font is monospace whatever its name sounds like.
    expect(stackOfFamily("Georgia", "code")).toBe('"Georgia", monospace');
  });

  it.each(["Georgia", "PingFang SC", "Noto Serif SC", "Segoe UI"])(
    "%s is a stack a theme accepts",
    (family) => {
      expect(isThemeLookFontStack(stackOfFamily(family, "ui"))).toBe(true);
    },
  );

  it("refuses a name that could carry more than a family", () => {
    expect(stackOfFamily("Evil; color: red", "ui")).toBeUndefined();
    expect(stackOfFamily("url(https://example.com/a)", "ui")).toBeUndefined();
    expect(stackOfFamily("   ", "ui")).toBeUndefined();
    expect(stackOfFamily('Say "hi"', "ui")).toBe('"Say hi", sans-serif');
  });
});

describe("nextStack", () => {
  it("follows the Appearance setting by storing nothing", () => {
    expect(nextStack('"Georgia", serif', "", "ui")).toEqual({ change: true, stack: undefined });
    expect(nextStack(undefined, "", "ui")).toEqual({ change: false, stack: undefined });
  });

  it("keeps a preset's longer stack when its own first family is chosen again", () => {
    const preset = '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif';
    expect(nextStack(preset, "Iowan Old Style", "ui")).toEqual({ change: false, stack: preset });
    expect(nextStack(preset, "Georgia", "ui")).toEqual({ change: true, stack: '"Georgia", serif' });
  });

  it("leaves the value alone for a family that cannot be stored", () => {
    expect(nextStack('"Georgia", serif', "Bad;Name", "ui")).toEqual({
      change: false,
      stack: '"Georgia", serif',
    });
  });
});

describe("curatedFamilies", () => {
  it("lists only the common families this device has, in their own order", () => {
    const installed = new Set(["Georgia", "PingFang SC", "Menlo", "JetBrains Mono", "Arial"]);
    const has = (family: string) => installed.has(family);
    expect(curatedFamilies("ui", has)).toEqual(["PingFang SC", "Georgia"]);
    expect(curatedFamilies("code", has)).toEqual(["Menlo", "JetBrains Mono"]);
    expect(curatedFamilies("code", () => false)).toEqual([]);
  });
});
