import { describe, expect, it } from "vite-plus/test";

import { localNotificationsRows, notificationsRow } from "../../fork/push/notificationsRow"; // fork: UnifiedPush
import { loadUiCatalog, translatorFor } from "@t3tools/client-runtime/i18n"; // fork: notifications rows
import { decodeOptions } from "gt-react-native";

import en from "../../i18n/translations/en.json";
import zh from "../../i18n/translations/zh.json";
import type { MessageResolver } from "../../i18n/messages";
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
// fork: GT's search keywords in Chinese, looked up by their English source as the app's catalog does.
const zhCatalog: Readonly<Record<string, unknown>> = zh;
const zhBySource = new Map(
  Object.entries(en).flatMap(([key, value]) => {
    const text = zhCatalog[key];
    return typeof value === "string" && typeof text === "string" ? [[value, text] as const] : [];
  }),
);
const resolveZh = ((message: string) => {
  const source = decodeOptions(message)?.$_source;
  const text = typeof source === "string" ? source : message;
  return zhBySource.get(text) ?? text;
}) as MessageResolver;

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
        filterSettingsSections(sections, query, locale === "en" ? undefined : resolveZh).flatMap(
          (section) => section.rows.map((row) => row.id),
        ),
      ).toEqual(["SettingsNotifications"]);
    }
  });
});
