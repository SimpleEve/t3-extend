import type { UiLanguageSetting } from "@t3tools/contracts/settings";
import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { ListChoiceRow as SettingsChoiceRow } from "../../../../components/ui/ListChoiceRow";
import { useT } from "../../../../hooks/useT";
import { uiLanguageSettingOf } from "../../../../persistence/mobile-preferences";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../../../state/preferences";
import { SettingsSection } from "../../components/SettingsSection";

// fork: each language is named in itself so a reader can find their own in any interface language.
const LANGUAGE_NAMES: Readonly<Record<Exclude<UiLanguageSetting, "system">, string>> = {
  en: "English",
  "zh-Hans": "简体中文",
};

const LANGUAGE_OPTIONS: ReadonlyArray<UiLanguageSetting> = ["system", "en", "zh-Hans"];

export function LanguageAppearanceSection() {
  const t = useT();
  const preferences = useAtomValue(mobilePreferencesAtom);
  const savePreferences = useAtomSet(updateMobilePreferencesAtom);
  const isReady = AsyncResult.isSuccess(preferences);
  const uiLanguage = uiLanguageSettingOf(isReady ? preferences.value : null);

  return (
    <SettingsSection
      title={t("Language")}
      footer={t("Choose the language of menus, settings, and labels.")}
    >
      <View accessibilityRole="radiogroup">
        {LANGUAGE_OPTIONS.map((option, index) => (
          <SettingsChoiceRow
            key={option}
            label={option === "system" ? t("Follow system") : LANGUAGE_NAMES[option]}
            disabled={!isReady}
            selected={uiLanguage === option}
            onPress={() => savePreferences({ uiLanguage: option })}
            separated={index > 0}
          />
        ))}
      </View>
    </SettingsSection>
  );
}
