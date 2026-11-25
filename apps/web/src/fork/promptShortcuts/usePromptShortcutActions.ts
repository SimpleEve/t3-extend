import { useAtomValue } from "@effect/atom-react";
import {
  MAX_PROMPT_SHORTCUTS,
  type EnvironmentId,
  type PromptShortcut,
  type PromptShortcutChange,
} from "@t3tools/contracts";
import { normalizePromptShortcutName } from "@t3tools/shared/promptShortcuts";
import { useGT } from "gt-react";

import { stackedThreadToast, toastManager } from "../../components/ui/toast";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { randomUUID } from "../../lib/utils";
import { readEnvironment, useEnvironmentProviders } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { dedupeProviderSkillsByName } from "@t3tools/client-runtime/providerSkills";

export interface PromptShortcutDraft {
  /** The shortcut being edited, or null for a new one. */
  readonly id: string | null;
  readonly name: string;
  readonly title: string;
  readonly content: string;
}

export function usePromptShortcuts(environmentId: EnvironmentId): ReadonlyArray<PromptShortcut> {
  return useEnvironmentSettings(environmentId, (settings) => settings.promptShortcuts);
}

/** Every skill the environment's enabled providers offer, so saved `$skill` text renders as chips. */
export function useEnvironmentPromptSkills(environmentId: EnvironmentId) {
  const providers = useEnvironmentProviders().get(environmentId);
  return dedupeProviderSkillsByName(
    (providers ?? []).flatMap((provider) => (provider.enabled ? provider.skills : [])),
  );
}

const readShortcuts = (environmentId: EnvironmentId): ReadonlyArray<PromptShortcut> =>
  readEnvironment(environmentId)?.serverConfig?.settings.promptShortcuts ?? [];

/**
 * Edits the environment's shortcut list through the ordinary settings update. Each call sends one
 * upsert or removal and the server applies it to the stored list under its write lock, so rapid
 * edits and other devices never overwrite each other with a whole list built from an older copy.
 */
export function usePromptShortcutActions(environmentId: EnvironmentId) {
  const gt = useGT();
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save prompt shortcuts",
  });
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));

  const change = async (edit: PromptShortcutChange): Promise<boolean> => {
    const result = await update({
      environmentId,
      input: { patch: { changePromptShortcuts: [edit] } },
    });
    return result._tag === "Success";
  };

  /** The saved shortcut, or null when nothing changed (limit reached, or the server refused). */
  const save = async (draft: PromptShortcutDraft): Promise<PromptShortcut | null> => {
    const list = readShortcuts(environmentId);
    const existing = draft.id === null ? undefined : list.find((entry) => entry.id === draft.id);
    if (existing === undefined && list.length >= MAX_PROMPT_SHORTCUTS) return null;
    const now = new Date().toISOString();
    const title = draft.title.trim();
    const shortcut: PromptShortcut = {
      id: existing?.id ?? draft.id ?? randomUUID(),
      name: normalizePromptShortcutName(draft.name),
      title: title === "" ? null : title,
      content: draft.content.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    return (await change({ kind: "upsert", shortcut })) ? shortcut : null;
  };

  /** Puts a removed shortcut back, unless its name was taken meanwhile: that one stays untouched. */
  const restore = async (shortcut: PromptShortcut): Promise<boolean> => {
    if (readShortcuts(environmentId).some((entry) => entry.name === shortcut.name)) {
      toastManager.add({
        type: "warning",
        title: gt("Prompt shortcut not restored"),
        description: gt("Another shortcut is already named ;{name}.", { name: shortcut.name }),
      });
      return false;
    }
    return change({ kind: "upsert", shortcut });
  };

  /** Removing never asks: a toast offers Undo. */
  const remove = async (shortcut: PromptShortcut): Promise<boolean> => {
    const removed = await change({ kind: "remove", id: shortcut.id });
    if (!removed) return false;
    const toastId = toastManager.add(
      stackedThreadToast({
        type: "info",
        title: gt("Prompt shortcut removed"),
        timeout: 6000,
        actionProps: {
          children: gt("Undo"),
          onClick: () => {
            toastManager.close(toastId);
            void restore(shortcut);
          },
        },
      }),
    );
    return true;
  };

  return { canWrite, save, remove, restore };
}
