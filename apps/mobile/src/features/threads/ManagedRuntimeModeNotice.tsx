import {
  clampManagedRuntimeMode,
  managedRuntimeModeDenial,
  type ManagedPolicySummary,
  type RuntimeMode,
} from "@t3tools/contracts";
import { View } from "react-native";
import { useT } from "../../hooks/useT"; // fork: i18n

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import {
  updateComposerDraftSettings,
  useComposerDraftSettings,
} from "../../state/use-composer-drafts";
import { runtimeModeChoicesForSupportedModes } from "./thread-settings-options";

/**
 * Shown while a thread's mode is above its environment's managed ceiling, where the server
 * refuses every turn. Switching sets the draft's mode, which the next send applies first.
 */
export function ManagedRuntimeModeNotice(props: {
  readonly threadKey: string;
  readonly threadRuntimeMode: RuntimeMode;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
  readonly policy: ManagedPolicySummary | undefined;
}) {
  const t = useT();
  const draftSettings = useComposerDraftSettings(props.threadKey);
  const runtimeMode = draftSettings.runtimeMode ?? props.threadRuntimeMode;
  const denial = managedRuntimeModeDenial(props.policy, runtimeMode, t); // fork: interface language
  if (denial === undefined) return null;
  const choices = runtimeModeChoicesForSupportedModes(props.supportedRuntimeModes);
  const target = clampManagedRuntimeMode(
    props.policy,
    runtimeMode,
    choices.map((choice) => choice.mode),
  );
  const targetLabel = choices.find((choice) => choice.mode === target)?.label;
  return (
    <View className="gap-2 px-4 pb-3">
      <AppText textRole="footnote" className="text-foreground-muted">
        {t("{denial} Switch this thread's mode to continue.", { denial })}
      </AppText>
      {target === undefined || targetLabel === undefined ? null : (
        <Button
          label={t("Switch to {mode}", { mode: t(targetLabel) })}
          onPress={() => updateComposerDraftSettings(props.threadKey, { runtimeMode: target })}
        />
      )}
    </View>
  );
}
