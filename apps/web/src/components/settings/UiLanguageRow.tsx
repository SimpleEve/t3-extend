import { DEFAULT_UNIFIED_SETTINGS, type UiLanguageSetting } from "@t3tools/contracts/settings";

import { useT } from "../../hooks/useT";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingResetButton, SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

// Each language is named in itself so a reader can find their own in any interface language.
const LANGUAGE_NAMES: Readonly<Record<Exclude<UiLanguageSetting, "system">, string>> = {
  en: "English",
  "zh-Hans": "简体中文",
};

function isUiLanguageSetting(value: unknown): value is UiLanguageSetting {
  return value === "system" || value === "en" || value === "zh-Hans";
}

export function UiLanguageRow() {
  const t = useT();
  const uiLanguage = useScopedSettings((settings) => settings.uiLanguage);
  const updateSettings = useUpdateScopedSettings();
  const optionLabel = (value: UiLanguageSetting) =>
    value === "system" ? t("Follow system") : LANGUAGE_NAMES[value];

  return (
    <SettingsRow
      {...searchableSetting("ui-language")}
      description={t("Choose the language of menus, settings, and labels.")}
      resetAction={
        uiLanguage !== DEFAULT_UNIFIED_SETTINGS.uiLanguage ? (
          <SettingResetButton
            label="language"
            onClick={() => updateSettings({ uiLanguage: DEFAULT_UNIFIED_SETTINGS.uiLanguage })}
          />
        ) : null
      }
      control={
        <div className="w-full sm:w-40">
          <Select
            value={uiLanguage}
            onValueChange={(value) => {
              if (isUiLanguageSetting(value)) updateSettings({ uiLanguage: value });
            }}
          >
            <SelectTrigger size="sm" className="w-full min-w-0" aria-label={t("Language")}>
              <SelectValue>{optionLabel(uiLanguage)}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem value="system">{optionLabel("system")}</SelectItem>
              <SelectItem value="en" lang="en">
                {t(LANGUAGE_NAMES.en)}
              </SelectItem>
              <SelectItem value="zh-Hans" lang="zh-Hans">
                {t(LANGUAGE_NAMES["zh-Hans"])}
              </SelectItem>
            </SelectPopup>
          </Select>
        </div>
      }
    />
  );
}
