// fork: T3 Extend's thread list views on mobile. The choice and the folds persist on the device.
import { useAtomValue } from "@effect/atom-react";
import { useMemo } from "react";

import { mobilePreferencesAtom, saveMobilePreferences } from "../state/preferences";
import { useAtomCommand } from "../state/use-atom-command";
import { useThreadListViewState } from "./threadListViewState";

export function useThreadListViewPreferences() {
  const save = useAtomCommand(saveMobilePreferences);
  const { ready, viewMode, collapsed, setViewMode, toggleGroup } = useThreadListViewState(
    useAtomValue(mobilePreferencesAtom),
    (update) => void save(update),
  );
  const collapsedKeys = useMemo<ReadonlySet<string>>(() => new Set(collapsed ?? []), [collapsed]);
  // `loaded` gates drawing; choices made before the preference arrives are kept and applied then.
  return { loaded: ready, viewMode, collapsedKeys, setViewMode, toggleGroup } as const;
}
