import { describe, expect, it } from "vite-plus/test";

import { localNotificationsRows, notificationsRow } from "../../fork/push/notificationsRow"; // fork: UnifiedPush
import { filterSettingsSections } from "./settings-search";

const SECTIONS = [
  { rows: [{ id: "usage", label: "Usage" }] },
  {
    title: "Connections",
    rows: [
      { id: "account", label: "T3 Account" },
      { id: "SettingsEnvironments", label: "Environments" },
    ],
  },
  {
    title: "Interface",
    rows: [
      { id: "SettingsAppearance", label: "Appearance" },
      { id: "SettingsKeyboard", label: "Keyboard" },
      { id: "SettingsVoice", label: "Voice" },
    ],
  },
  {
    title: "Server settings",
    rows: [
      { id: "SettingsProviderAccounts", label: "Provider accounts" },
      { id: "SettingsEnvironmentSourceControl", label: "Source control & issues" },
    ],
  },
];

function visible(query: string) {
  return filterSettingsSections(SECTIONS, query).map((section) => [
    section.title ?? null,
    section.rows.map((row) => row.label),
  ]);
}

describe("filterSettingsSections", () => {
  it.each([
    {
      query: "",
      expected: SECTIONS.map((section) => [
        section.title ?? null,
        section.rows.map((row) => row.label),
      ]),
    },
    { query: "   ", expected: visible("") },
    { query: "appear", expected: [["Interface", ["Appearance"]]] },
    { query: "KEYBOARD", expected: [["Interface", ["Keyboard"]]] },
    { query: "dark mode", expected: [["Interface", ["Appearance"]]] },
    { query: "microphone", expected: [["Interface", ["Voice"]]] },
    { query: "agent credits", expected: [["Server settings", ["Source control & issues"]]] },
    {
      query: "server settings",
      expected: [["Server settings", ["Provider accounts", "Source control & issues"]]],
    },
    {
      query: "accounts",
      expected: [["Server settings", ["Provider accounts"]]],
    },
    { query: "usage", expected: [[null, ["Usage"]]] },
    { query: "zzzz", expected: [] },
  ])("$query", ({ query, expected }) => {
    expect(visible(query)).toEqual(expected);
  });

  it("drops sections that start empty", () => {
    expect(filterSettingsSections([{ rows: [] }, ...SECTIONS], "").length).toBe(SECTIONS.length);
  });
});

// fork: a build without T3 Connect lists Notifications next to Environments, and search finds it
// by its name and by "push" in either language.
describe("Notifications without T3 Connect", () => {
  it("is listed only where the page has something to show", () => {
    const t = translatorFor("en");
    expect(localNotificationsRows(t, true).map((row) => row.id)).toEqual(["SettingsNotifications"]);
    expect(localNotificationsRows(t, false)).toEqual([]);
  });

  it.each([
    { locale: "en", queries: ["notifications", "push", "alerts"] },
    { locale: "zh-Hans", queries: ["通知", "推送", "push"] },
  ] as const)("is found by $queries in $locale", async ({ locale, queries }) => {
    await loadUiCatalog(locale);
    const t = translatorFor(locale);
    const sections = [
      { title: t("Connections"), rows: [{ id: "SettingsEnvironments", label: t("Environments") }] },
      { title: t("Agents"), rows: [notificationsRow(t)] },
    ];
    for (const query of queries) {
      expect(
        filterSettingsSections(sections, query, t).flatMap((section) =>
          section.rows.map((row) => row.id),
        ),
      ).toEqual(["SettingsNotifications"]);
    }
  });
});
