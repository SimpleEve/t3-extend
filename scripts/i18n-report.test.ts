import { describe, expect, it } from "vite-plus/test";

import { scanHardCodedText } from "./i18n-report.ts";

const hitsOf = (code: string, fileName = "apps/web/src/Example.tsx") =>
  scanHardCodedText(code, fileName).hits.map(({ kind, text }) => `${kind}: ${text}`);

describe("scanHardCodedText", () => {
  it.each([
    ["JSX text, collapsing line breaks", "<p>Hello\n  world</p>", ["text: Hello world"]],
    ["a string child", '<p>{"Hello world"}</p>', ["child: Hello world"]],
    ["a template child", "<p>{`Hello ${name}`}</p>", ["child: Hello ${…}"]],
    [
      "both branches of a conditional child",
      '<p>{on ? "Turn off" : "Turn on"}</p>',
      ["child: Turn off", "child: Turn on"],
    ],
    ["a fallback child", '<p>{name ?? "Unnamed"}</p>', ["child: Unnamed"]],
    ["a text attribute", '<a title="Open it" />', ["title: Open it"]],
    ["a *Label prop", '<Row emptyLabel="Nothing here" />', ["emptyLabel: Nothing here"]],
    ["a template attribute", "<a aria-label={`Open ${name}`} />", ["aria-label: Open ${…}"]],
    ["text inside a fragment", "<>Hello world</>", ["text: Hello world"]],
  ])("reports %s", (_case, jsx, expected) => {
    expect(hitsOf(`const x = ${jsx};`)).toEqual(expected);
  });

  it.each([
    ["t() calls", '<a title={t("Open it")}>{t("Hello world")}</a>'],
    ["attributes that hold no text", '<a className="flex gap-2" href="https://x.dev" />'],
    ["single letters and punctuation", "<p>x · y</p>"],
    ["HTML entities", "<p>&middot; {failure}</p>"],
    ["code elements", "<code>npx t3 pair</code>"],
    ["always-English text", '<Input placeholder="https://example.com/search" />'],
    ["brand names", "<p>T3 Code</p>"],
    ["a self-translating prop", '<SettingsSection title="Display" />'],
    [
      "a self-translating prop scoped to the file",
      '<Section title="App" />',
      "DeviceToolsPanel.tsx",
    ],
  ])("ignores %s", (_case, jsx, fileName = "Example.tsx") => {
    expect(hitsOf(`const x = ${jsx};`, `apps/web/src/${fileName}`)).toEqual([]);
  });

  it("hands self-translating literals to the catalog check, except what can't match a key", () => {
    const scan = scanHardCodedText(
      'const x = <><SettingsSection title="Display" /><SettingsSection title={`Disk ${name}`} /><SettingsSection title="T3 Code" /></>;',
      "apps/web/src/Example.tsx",
    );
    expect(scan.selfTranslated).toEqual(["Display"]);
    expect(scan.hits.map(({ text }) => text)).toEqual(["Disk ${…}"]);
  });

  it("applies the self-translating allowlist to web only", () => {
    expect(
      hitsOf('const x = <SettingsSection title="Display" />;', "apps/mobile/src/Example.tsx"),
    ).toEqual(["title: Display"]);
  });

  it("reports the line of the text, past multi-byte characters", () => {
    const [hit] = scanHardCodedText(
      "// 中文 😀\nconst x = (\n  <p>\n    Hello world\n  </p>\n);\n",
    ).hits;
    expect(hit?.line).toBe(3);
  });
});
