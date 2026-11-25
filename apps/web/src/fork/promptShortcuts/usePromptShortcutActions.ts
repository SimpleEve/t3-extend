import { useAtomValue } from "@effect/atom-react";
import { MAX_PROMPT_SHORTCUTS, type EnvironmentId, type PromptShortcut } from "@t3tools/contracts";
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
 * Writes the environment's shortcut list through the ordinary settings update, so permissions and
 * validation are the server's. Each call reads the newest list, then replaces it whole.
 */
export function usePromptShortcutActions(environmentId: EnvironmentId) {
  const gt = useGT();
  const update = useAtomCommand(serverEnvironment.updateSettings, {
    label: "save prompt shortcuts",
  });
  const canWrite = useAtomValue(serverEnvironment.updateSettings.permissionAtom(environmentId));

  const write = async (next: ReadonlyArray<PromptShortcut>): Promise<boolean> => {
    const result = await update({ environmentId, input: { patch: { promptShortcuts: next } } });
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
      id: existing?.id ?? randomUUID(),
      name: normalizePromptShortcutName(draft.name),
      title: title === "" ? null : title,
      content: draft.content.trim(),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    const next = existing
      ? list.map((entry) => (entry.id === existing.id ? shortcut : entry))
      : [...list, shortcut];
    return (await write(next)) ? shortcut : null;
  };

  const restore = async (shortcut: PromptShortcut): Promise<boolean> =>
    write([
      ...readShortcuts(environmentId).filter(
        (entry) => entry.id !== shortcut.id && entry.name !== shortcut.name,
      ),
      shortcut,
    ]);

  /** Removing never asks: a toast offers Undo. */
  const remove = async (shortcut: PromptShortcut): Promise<boolean> => {
    const removed = await write(
      readShortcuts(environmentId).filter((entry) => entry.id !== shortcut.id),
    );
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
