import type { EnvironmentId, PromptShortcut } from "@t3tools/contracts";
import { MAX_PROMPT_SHORTCUTS } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { PencilIcon, PlusIcon, TrashIcon, ZapIcon } from "lucide-react";
import { useState } from "react";

import { useEnvironments } from "../../state/environments";

import { Button } from "../../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../../components/ui/empty";
import { Input } from "../../components/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { useSettingsScope } from "../../components/settings/SettingsScopeContext";
import { EnvironmentScopeMenu } from "../../components/settings/SettingsScopeSentence";
import { SettingsPageContainer, SettingsSection } from "../../components/settings/settingsLayout";
import { useSearchableSetting } from "../../components/settings/settingsSearch";
import { PromptShortcutPreview } from "./PromptShortcutPreview";
import { openPromptShortcutEditor } from "./promptShortcutEditorStore";
import { usePromptShortcutActions, usePromptShortcuts } from "./usePromptShortcutActions";

export function PromptShortcutsSettings() {
  const gt = useGT();
  const { environment, search, groups, selectScope } = useSettingsScope();
  const { environments } = useEnvironments();
  if (!environment) {
    return (
      <SettingsPageContainer>
        <p className="text-sm text-muted-foreground">
          {gt("Connect an environment to manage its prompt shortcuts.")}
        </p>
      </SettingsPageContainer>
    );
  }
  return (
    <SettingsPageContainer>
      {/* Shortcuts belong to one machine, never to a project: only the machine is chosen here. */}
      <div className="px-3 sm:px-4">
        <EnvironmentScopeMenu
          singleEnvironment
          value={search}
          groups={groups}
          environments={environments}
          onChange={selectScope}
        />
      </div>
      <PromptShortcutList
        key={environment.environmentId}
        environmentId={environment.environmentId}
      />
    </SettingsPageContainer>
  );
}

function matchesFilter(shortcut: PromptShortcut, query: string): boolean {
  return (
    query === "" ||
    shortcut.name.includes(query) ||
    (shortcut.title ?? "").toLowerCase().includes(query) ||
    shortcut.content.toLowerCase().includes(query)
  );
}

function PromptShortcutList({ environmentId }: { environmentId: EnvironmentId }) {
  const gt = useGT();
  const setting = useSearchableSetting();
  const shortcuts = usePromptShortcuts(environmentId);
  const actions = usePromptShortcutActions(environmentId);
  const [query, setQuery] = useState("");
  const normalizedQuery = query.trim().toLowerCase();
  const visible = shortcuts
    .filter((shortcut) => matchesFilter(shortcut, normalizedQuery))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  const create = () => openPromptShortcutEditor({ environmentId, shortcut: null });

  return (
    <>
      <SettingsSection
        {...setting("prompt-shortcuts")}
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!actions.canWrite || shortcuts.length >= MAX_PROMPT_SHORTCUTS}
            onClick={create}
          >
            <PlusIcon className="size-3" />
            <T>New shortcut</T>
          </Button>
        }
      >
        {shortcuts.length === 0 ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <ZapIcon />
              </EmptyMedia>
              <EmptyTitle>
                <T>No prompt shortcuts yet</T>
              </EmptyTitle>
              <EmptyDescription>
                <T>
                  Save a prompt you reuse, then type ; and its name in the composer to insert it.
                </T>
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <>
            <div className="px-4 py-3">
              <Input
                type="search"
                value={query}
                aria-label={gt("Search prompt shortcuts")}
                placeholder={gt("Search")}
                onChange={(event) => setQuery(event.target.value)}
              />
            </div>
            {visible.length === 0 ? (
              <p role="status" className="px-4 py-6 text-center text-sm text-muted-foreground">
                <T>No prompt shortcuts match your search.</T>
              </p>
            ) : (
              visible.map((shortcut) => (
                <div
                  key={shortcut.id}
                  data-testid="prompt-shortcut-row"
                  className="flex items-start gap-3 px-4 py-3"
                >
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <span className="shrink-0 font-mono text-sm font-medium">
                        ;{shortcut.name}
                      </span>
                      {shortcut.title ? (
                        <span className="min-w-0 truncate text-sm text-muted-foreground">
                          {shortcut.title}
                        </span>
                      ) : null}
                    </div>
                    <PromptShortcutPreview
                      environmentId={environmentId}
                      content={shortcut.content}
                    />
                  </div>
                  <div className="flex shrink-0 items-center gap-0.5">
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost-muted"
                            disabled={!actions.canWrite}
                            aria-label={gt("Edit ;{name}", { name: shortcut.name })}
                            onClick={() => openPromptShortcutEditor({ environmentId, shortcut })}
                          />
                        }
                      >
                        <PencilIcon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">{gt("Edit")}</TooltipPopup>
                    </Tooltip>
                    <Tooltip>
                      <TooltipTrigger
                        render={
                          <Button
                            type="button"
                            size="icon-xs"
                            variant="ghost-muted"
                            disabled={!actions.canWrite}
                            aria-label={gt("Delete ;{name}", { name: shortcut.name })}
                            onClick={() => void actions.remove(shortcut)}
                          />
                        }
                      >
                        <TrashIcon className="size-3.5" />
                      </TooltipTrigger>
                      <TooltipPopup side="top">{gt("Delete")}</TooltipPopup>
                    </Tooltip>
                  </div>
                </div>
              ))
            )}
          </>
        )}
      </SettingsSection>
    </>
  );
}
