import { describe, expect, it } from "vite-plus/test";

import {
  callCatalogKey,
  catalogKeySource,
  omittedTranslators,
  riskyComparisons,
  scanCallArities,
  scanCallKeys,
  scanComparisons,
  scanHardCodedText,
  scanIndirectSources,
  scanPropertyText,
  scanTranslatedTable,
  scanTranslatorParameters,
  templateSourcePattern,
} from "./i18n-report.ts";

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
    ["GT's <T> and the values inside it", "<T>Hello <Var>{name}</Var> world</T>"],
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

  it("follows a module string constant into a child, but not through t()", () => {
    const code = (child: string) =>
      `const MESSAGE = "Scan limit reached."; const x = <p>{${child}}</p>;`;
    expect(hitsOf(code("MESSAGE"))).toEqual(["child: Scan limit reached."]);
    expect(hitsOf(code("t(MESSAGE)"))).toEqual([]);
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

describe("scanPropertyText", () => {
  const known = new Set(["Copy link"]);
  const hitsIn = (code: string, fileName = "apps/web/src/example.ts") =>
    scanPropertyText(code, fileName, known).map(({ property, text }) => `${property}: ${text}`);

  it.each([
    ["a menu label", 'const x = { label: "Open with" };', ["label: Open with"]],
    [
      "a *Title property",
      'const x = { failureTitle: "Failed to undo" };',
      ["failureTitle: Failed to undo"],
    ],
    [
      "an error message",
      'new E({ message: "Could not load this item." });',
      ["message: Could not load this item."],
    ],
    [
      "an interpolated template, even when its shape is a key",
      "const x = { title: `Updated ${name}` };",
      ["title: Updated ${…}"],
    ],
    [
      "both branches of a conditional",
      'const x = { label: on ? "Turn off" : "Turn on" };',
      ["label: Turn off", "label: Turn on"],
    ],
  ])("reports %s", (_case, code, expected) => {
    expect(hitsIn(code)).toEqual(expected);
  });

  it.each([
    ["a literal the catalog holds", 'const x = { label: "Copy link" };'],
    ["a t() call", 'const x = { label: t("Open with") };'],
    ["an id-like word", 'const x = { label: "preview" };'],
    ["a class list", 'const x = { headerTitle: "text-xl font-semibold" };'],
    [
      "an operation label for logs",
      'useAtomCommand(command, { label: "server settings update" });',
    ],
    ["properties outside the UI set", 'const x = { reason: "Remote is unavailable." };'],
  ])("ignores %s", (_case, code) => {
    expect(hitsIn(code)).toEqual([]);
  });

  it("skips allowlisted files and properties", () => {
    expect(
      hitsIn('const x = { label: "TypeScript Lang" };', "apps/web/src/composer-code-languages.ts"),
    ).toEqual([]);
    expect(
      hitsIn(
        'const x = { text: "Continue where you left off." };',
        "apps/web/src/components/chat/useComposerResume.ts",
      ),
    ).toEqual([]);
  });
});

describe("riskyComparisons", () => {
  const risky = (
    files: ReadonlyArray<readonly [string, string]>,
    translated: ReadonlyArray<string>,
  ) =>
    riskyComparisons(
      files.map(([file, code]) => [file, scanComparisons(code, file)] as const),
      new Set(translated),
    ).map(({ file, operator, text }) => `${file} ${operator} ${text}`);

  it.each([
    ["===", 'if (label === "Detached HEAD") {}', "==="],
    ["!==", 'if (label !== "Detached HEAD") {}', "!=="],
    ["a switch case", 'switch (label) { case "Detached HEAD": break; }', "case"],
    [".includes()", 'labels.includes("Detached HEAD");', ".includes()"],
    [".startsWith()", 'label.startsWith("Detached HEAD");', ".startsWith()"],
    [".has()", 'labels.has("Detached HEAD");', ".has()"],
  ])("reports %s against a translated source", (_case, code, operator) => {
    expect(risky([["a.ts", code]], ["Detached HEAD"])).toEqual([`a.ts ${operator} Detached HEAD`]);
  });

  it("resolves an upper-case constant declared in another file", () => {
    expect(
      risky(
        [
          ["a.ts", 'export const DETACHED_LABEL = "Detached HEAD";'],
          ["b.ts", "if (label === DETACHED_LABEL) {}"],
        ],
        ["Detached HEAD"],
      ),
    ).toEqual(["b.ts === Detached HEAD"]);
  });

  it.each([
    ["a source nothing translates", 'if (label === "Detached HEAD") {}', []],
    ["a single character", 'if (key === "?") {}', ["?"]],
    ["an enum-like word", 'if (state === "Merged") {}', ["Merged"]],
  ])("ignores %s", (_case, code, translated) => {
    expect(risky([["a.ts", code]], translated)).toEqual([]);
  });

  it("skips allowlisted comparisons", () => {
    expect(
      risky(
        [
          [
            "apps/mobile/src/features/threads/git/GitBranchesSheet.tsx",
            'if (x === "Detached HEAD") {}',
          ],
        ],
        ["Detached HEAD"],
      ),
    ).toEqual([]);
  });
});

describe("scanIndirectSources", () => {
  const sourcesIn = (code: string) =>
    scanIndirectSources(code, "apps/web/src/Example.tsx").map(({ source }) => source);

  it.each([
    [
      "a curried translator",
      'translatorFor(getUiLocale())("Open on {label}");',
      ["Open on {label}"],
    ],
    [
      "a constant read by key",
      'const LABELS = { a: "12-hour", b: "24-hour" } as const;\nt(LABELS[format]);',
      ["12-hour", "24-hour"],
    ],
    [
      "a constant read by name",
      'const LABELS = { a: "12-hour", b: "24-hour" };\nt(LABELS.b);',
      ["24-hour"],
    ],
    [
      "a property of an array element",
      'export const STATES = [{ id: "all", label: "All states" }, { id: "open", label: "Open" }];\nt(STATES[i].label);',
      ["All states", "Open"],
    ],
    [
      "translate() with a constant",
      'const NAMES = { en: "English" };\ntranslate(locale, NAMES.en);',
      ["English"],
    ],
    [
      "both branches of a conditional constant read",
      'const A = { x: "Open it", y: "Close it" };\nt(on ? A.x : A.y);',
      ["Open it", "Close it"],
    ],
  ])("finds %s", (_case, code, expected) => {
    expect(sourcesIn(code)).toEqual(expected);
  });

  it.each([
    [
      "direct literals, which the call patterns cover",
      't("Open it"); translate(locale, "Open it");',
    ],
    [
      "a constant declared inside a function",
      'function f() { const L = { a: "Open it" }; return t(L.a); }',
    ],
    ["a plain variable", "t(label);"],
  ])("leaves out %s", (_case, code) => {
    expect(sourcesIn(code)).toEqual([]);
  });
});

describe("catalogKeySource", () => {
  it.each([
    ["a plain key", "Archive thread", "Archive thread"],
    ["a context key", "sidebar section|Active", "Active"],
    [
      "a source with a bar in it",
      "Use !, &&, ||, and parentheses.",
      "Use !, &&, ||, and parentheses.",
    ],
  ])("reads %s", (_case, key, source) => {
    expect(catalogKeySource(key)).toBe(source);
  });
});

describe("scanCallKeys", () => {
  const keysIn = (code: string) =>
    scanCallKeys(code, "apps/web/src/Example.tsx").map((call) => callCatalogKey(call));

  it.each([
    ["a bare call", 't("days");', ["days"]],
    ["a call with params and no context", 't("Hello {name}", { name });', ["Hello {name}"]],
    ["a context", 't("Main", undefined, "worktree badge");', ["worktree badge|Main"]],
    [
      "translate() with a locale first",
      'translate(locale, "days", undefined, "unit");',
      ["unit|days"],
    ],
    [
      "both branches of a condition",
      't(open ? "Collapse all" : "Expand all");',
      ["Collapse all", "Expand all"],
    ],
  ])("finds the catalog key of %s", (_case, code, expected) => {
    expect(keysIn(code)).toEqual(expected);
  });

  it("leaves out a context the code does not spell out, and sources without a word", () => {
    expect(keysIn('t("Main", undefined, context);')).toEqual([null]);
    expect(keysIn('t("1");')).toEqual([]);
  });

  it("tells a bare call from a contextual catalog entry: the key it needs differs", () => {
    // The catalog holds "snooze unit|days"; a call without that context needs plain "days".
    const [call] = scanCallKeys('t("days");', "apps/web/src/Example.tsx");
    expect(callCatalogKey(call!)).toBe("days");
    expect(callCatalogKey(call!)).not.toBe("snooze unit|days");
  });
});

describe("templateSourcePattern", () => {
  it("turns a template into a pattern for the sources it can render", () => {
    const pattern = templateSourcePattern("Set up ${desktop} capture");
    expect(pattern?.test("Set up GNOME capture")).toBe(true);
    expect(pattern?.test("Check T3 Extend SnapShots in GNOME Extensions, then try again.")).toBe(
      false,
    );
  });

  it("drops a template with no word in its fixed text, which would match every sentence", () => {
    expect(templateSourcePattern("${families}, ${defaultStack}")).toBeNull();
    expect(templateSourcePattern("${a}${b}")).toBeNull();
  });
});

describe("omitted translators", () => {
  const parametersIn = (code: string) =>
    scanTranslatorParameters(code, "apps/web/src/example.ts").map(
      ({ name, index }) => `${name}@${index}`,
    );

  it.each([
    [
      "a default English translator",
      'function label(a: string, t: Translator = translatorFor("en")) {}',
      ["label@1"],
    ],
    ["an optional translator", "const label = (a: string, t?: Translator) => a;", ["label@1"]],
    ["a method", "const x = { label(t: Translator = (source) => source) {} };", ["label@0"]],
  ])("finds %s", (_case, code, expected) => {
    expect(parametersIn(code)).toEqual(expected);
  });

  it.each([
    ["a required translator", "function label(t: Translator) {}"],
    [
      "a default that follows the interface language",
      "function label(t: Translator = translatorFor(getUiLocale())) {}",
    ],
    ["a parameter that is not a translator", "function label(a = 1) {}"],
  ])("ignores %s", (_case, code) => {
    expect(parametersIn(code)).toEqual([]);
  });

  it("reports calls that stop before the translator, and only those", () => {
    const file = "apps/web/src/Example.tsx";
    const calls = scanCallArities("a(x); a(x, t); a(...rest); obj.a(x); b(x);", file);
    expect(
      omittedTranslators(new Map([["a", 1]]), [[file, calls]]).map(
        ({ line, name }) => `${name}:${line}`,
      ),
    ).toEqual(["a:1", "a:1"]);
  });

  it("skips an allowlisted call", () => {
    const file = "apps/mobile/src/components/ui/NumberField.tsx";
    const calls = scanCallArities("formatValue(1);", file);
    expect(omittedTranslators(new Map([["formatValue", 1]]), [[file, calls]])).toEqual([]);
  });
});

describe("scanTranslatedTable", () => {
  it("reads the named properties of every object, however deep", () => {
    const sources = scanTranslatedTable(
      'export const ITEMS = [{ id: "a", title: "Welcome page", note: "Skip me" }, { nested: { title: "Open" } }];',
      "apps/web/src/example.ts",
      new Set(["title"]),
    );
    expect(sources.map(({ source }) => source)).toEqual(["Welcome page", "Open"]);
  });
});
