import type { EnvironmentId, ProviderDriverKind } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { formatProviderSkillDisplayName } from "@t3tools/shared/inlineSkills";
import { useGT, useMessages } from "gt-react";
import { useRef, useState } from "react";

import {
  ComposerPromptEditorTiptap,
  type ComposerPromptEditorHandle,
} from "../../components/ComposerPromptEditorTiptap";
import {
  ComposerCommandMenu,
  type ComposerCommandItem,
} from "../../components/chat/ComposerCommandMenu";
import { useComposerTriggerState } from "../../components/chat/useComposerTriggerState";
import { ComposerContextActionsContext } from "../../components/composerContextActions";
import { EMPTY_COMPOSER_CONTEXT_RECORDS } from "../../components/composerContextPresentation";
import {
  collapseExpandedComposerCursor,
  detectComposerTrigger,
  extendReplacementRangeForTrailingSpace,
  replaceTextRange,
  type ComposerTrigger,
} from "../../composer-logic";
import { useTheme } from "../../hooks/useTheme";
import { basenameOfPath } from "../../pierre-icons";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useComposerPathSearch } from "../../state/queries";
import { useEnvironmentProviders } from "../../state/environments";
import { useEnvironmentPromptSkills } from "./usePromptShortcutActions";

const noop = () => {};

/**
 * The composer's own editor, so `$skill` and `@file` become the chips they are in a message, with
 * the same `$` and `@` menus beneath it. Other triggers (`/`, `#`, `:`) are plain text here.
 */
export function PromptShortcutContentEditor(props: {
  environmentId: EnvironmentId;
  /** Lets `@` find files; without it `@` stays plain text. */
  cwd?: string | undefined;
  value: string;
  onChange: (value: string) => void;
  onSubmit?: () => void;
  ariaLabel: string;
  placeholder: string;
}) {
  const { environmentId, cwd, value, onChange, onSubmit, ariaLabel, placeholder } = props;
  const gt = useGT();
  const messages = useMessages();
  const { resolvedTheme } = useTheme();
  const editorRef = useRef<ComposerPromptEditorHandle>(null);
  const [cursor, setCursor] = useState(() => collapseExpandedComposerCursor(value, value.length));
  const [highlightedItemId, setHighlightedItemId] = useState<string | null>(null);
  const { trigger, setTrigger, followCaret, resolveTrigger, dismissTrigger, resetTrigger } =
    useComposerTriggerState(() => null);
  const skills = useEnvironmentPromptSkills(environmentId);
  const driver = useEnvironmentProviders().get(environmentId)?.[0]?.driver;

  const activeTrigger: ComposerTrigger | null =
    trigger && (trigger.kind === "skill" || (trigger.kind === "path" && cwd)) ? trigger : null;
  const workspaceEntries = useComposerPathSearch(
    {
      environmentId,
      cwd: activeTrigger?.kind === "path" ? (cwd ?? null) : null,
      query: activeTrigger?.kind === "path" ? activeTrigger.query : null,
    },
    messages,
  );
  const items: ComposerCommandItem[] =
    activeTrigger?.kind === "skill" && driver
      ? searchProviderSkills(skills, activeTrigger.query).map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          provider: driver as ProviderDriverKind,
          skill,
          label: formatProviderSkillDisplayName(skill),
          description: skill.shortDescription ?? skill.description ?? gt("Run provider skill"),
        }))
      : activeTrigger?.kind === "path"
        ? workspaceEntries.entries.map((entry) => ({
            id: `path:${entry.kind}:${entry.path}`,
            type: "path" as const,
            path: entry.path,
            pathKind: entry.kind,
            searchTarget: workspaceEntries.searchedTarget,
            label: basenameOfPath(entry.path).normalize("NFC"),
            description: entry.path
              .slice(0, Math.max(0, entry.path.lastIndexOf("/")))
              .normalize("NFC"),
          }))
        : [];
  const menuOpen = activeTrigger !== null && items.length > 0;
  const activeItem = items.find((item) => item.id === highlightedItemId) ?? items[0] ?? null;

  const readTrigger = () => {
    const snapshot = editorRef.current?.readSnapshot();
    return snapshot
      ? {
          snapshot,
          trigger: resolveTrigger(detectComposerTrigger(snapshot.value, snapshot.expandedCursor)),
        }
      : null;
  };

  const select = (item: ComposerCommandItem) => {
    const current = readTrigger();
    if (!current?.trigger) return;
    const { snapshot, trigger: active } = current;
    const replacement =
      item.type === "skill"
        ? `$${item.skill.name} `
        : item.type === "path"
          ? `${serializeComposerFileLink(item.path)} `
          : null;
    if (replacement === null) return;
    const rangeEnd = extendReplacementRangeForTrailingSpace(
      snapshot.value,
      active.rangeEnd,
      replacement,
    );
    const next = replaceTextRange(snapshot.value, active.rangeStart, rangeEnd, replacement);
    const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
    onChange(next.text);
    setCursor(nextCursor);
    setHighlightedItemId(null);
    resetTrigger(null);
    window.requestAnimationFrame(() => editorRef.current?.focusAt(nextCursor));
  };

  const moveHighlight = (key: "ArrowDown" | "ArrowUp") => {
    const index = items.findIndex((item) => item.id === activeItem?.id);
    const next = items[(index + (key === "ArrowDown" ? 1 : -1) + items.length) % items.length];
    setHighlightedItemId(next?.id ?? null);
  };

  return (
    <ComposerContextActionsContext
      value={{
        environmentId,
        cwd,
        expandImage: noop,
        expandVideo: noop,
        openFile: noop,
        openMention: noop,
        openPullRequest: noop,
      }}
    >
      <div className="rounded-lg border border-input bg-background px-3 py-2 text-sm text-foreground shadow-xs/5 focus-within:border-ring focus-within:ring-2 focus-within:ring-inset focus-within:ring-ring/24 dark:bg-input/32">
        <ComposerPromptEditorTiptap
          editorRef={editorRef}
          value={value}
          cursor={cursor}
          richTextEnabled={false}
          contextRecords={EMPTY_COMPOSER_CONTEXT_RECORDS}
          skills={skills}
          disabled={false}
          ariaLabel={ariaLabel}
          placeholder={placeholder}
          className="max-h-60 min-h-24"
          onPaste={noop}
          onChange={(nextValue, nextCursor, expandedCursor, adjacentToChip, _ids, textChanged) => {
            onChange(nextValue);
            setCursor(nextCursor);
            const next = adjacentToChip ? null : detectComposerTrigger(nextValue, expandedCursor);
            (textChanged ? setTrigger : followCaret)(next);
          }}
          onCommandKeyDown={(key, event) => {
            if (key === "Enter" && (event.metaKey || event.ctrlKey) && onSubmit) {
              onSubmit();
              return true;
            }
            const current = readTrigger();
            if (!current?.trigger || !menuOpen) return false;
            if (key === "Escape") {
              dismissTrigger(current.trigger);
              return true;
            }
            if (key === "ArrowDown" || key === "ArrowUp") {
              moveHighlight(key);
              return true;
            }
            if ((key === "Enter" || key === "Tab") && activeItem && !event.shiftKey) {
              select(activeItem);
              return true;
            }
            return false;
          }}
        />
      </div>
      {menuOpen ? (
        <div className="mt-2 w-0 min-w-full">
          <ComposerCommandMenu
            listId="prompt-shortcut-editor-suggestions"
            items={items}
            resolvedTheme={resolvedTheme}
            isLoading={false}
            triggerKind={activeTrigger.kind}
            activeItemId={activeItem?.id ?? null}
            onHighlightedItemChange={setHighlightedItemId}
            onSelect={select}
          />
        </div>
      ) : null}
    </ComposerContextActionsContext>
  );
}
