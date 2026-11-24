import type { BookmarkSourceState } from "@t3tools/client-runtime/state/thread-bookmarks";
import {
  THREAD_BOOKMARK_NOTE_MAX_LENGTH,
  THREAD_BOOKMARK_TITLE_MAX_LENGTH,
  threadBookmarkLabel,
  type ScopedThreadRef,
  type ThreadBookmark,
} from "@t3tools/contracts";
import { useGT } from "gt-react";
import { ChevronDownIcon, ChevronRightIcon, PencilIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { MessageCopyButton } from "../../components/chat/MessageCopyButton";
import { Button } from "../../components/ui/button";
import { Input } from "../../components/ui/input";
import { Textarea } from "../../components/ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../components/ui/tooltip";
import { cn } from "../../lib/utils";
import { useThreadBookmarkActions } from "./useThreadBookmarkActions";
import { useRevealBookmark } from "./useRevealBookmark";

const LABEL_LENGTH = 80;

/** A thread's bookmarks in conversation order: reveal, read in full, edit, copy, delete. */
export function ThreadBookmarkList({
  threadRef,
  bookmarks,
  sources,
  canEdit,
  onRevealed,
}: {
  threadRef: ScopedThreadRef;
  bookmarks: ReadonlyArray<ThreadBookmark>;
  sources: ReadonlyMap<string, BookmarkSourceState>;
  canEdit: boolean;
  /** Called after a bookmark is opened, so a dialog can get out of the way. */
  onRevealed?: () => void;
}) {
  const gt = useGT();
  const actions = useThreadBookmarkActions(threadRef);
  const reveal = useRevealBookmark(threadRef);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
      {bookmarks.map((bookmark) => {
        const missing = sources.get(bookmark.id) === "missing";
        const expanded = expandedId === bookmark.id;
        const label = threadBookmarkLabel(bookmark, LABEL_LENGTH);
        return (
          <li
            key={bookmark.id}
            data-bookmark-id={bookmark.id}
            className="group/bookmark flex min-w-0 flex-col rounded-lg px-1.5 py-1 hover:bg-accent/50 focus-within:bg-accent/50"
          >
            {editingId === bookmark.id ? (
              <BookmarkEditor
                bookmark={bookmark}
                onCancel={() => setEditingId(null)}
                onSave={async (changes) => {
                  if (await actions.update(bookmark, changes)) setEditingId(null);
                }}
              />
            ) : (
              <>
                <div className="flex min-w-0 items-start gap-1">
                  <Button
                    type="button"
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-expanded={expanded}
                    aria-label={expanded ? gt("Show less") : gt("Show the full text")}
                    onClick={() => setExpandedId(expanded ? null : bookmark.id)}
                  >
                    {expanded ? <ChevronDownIcon /> : <ChevronRightIcon />}
                  </Button>
                  <button
                    type="button"
                    disabled={missing}
                    onClick={() => {
                      void reveal(bookmark);
                      onRevealed?.();
                    }}
                    className={cn(
                      "min-w-0 flex-1 rounded-sm py-0.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                      missing ? "cursor-default text-muted-foreground" : "cursor-pointer",
                    )}
                  >
                    <span className={cn("block", expanded ? "break-words" : "truncate")}>
                      {label}
                    </span>
                    {missing ? (
                      <span className="block text-xs text-muted-foreground">
                        {gt("The original message is no longer in this thread")}
                      </span>
                    ) : null}
                  </button>
                  <div className="flex shrink-0 items-center opacity-0 transition-opacity duration-150 pointer-coarse:opacity-100 focus-within:opacity-100 group-hover/bookmark:opacity-100">
                    {canEdit ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label={gt("Edit bookmark")}
                              onClick={() => {
                                setExpandedId(bookmark.id);
                                setEditingId(bookmark.id);
                              }}
                            />
                          }
                        >
                          <PencilIcon />
                        </TooltipTrigger>
                        <TooltipPopup>{gt("Edit")}</TooltipPopup>
                      </Tooltip>
                    ) : null}
                    <MessageCopyButton
                      text={bookmark.excerpt}
                      label={gt("Copy original text")}
                      size="icon-xs"
                      variant="ghost"
                    />
                    {canEdit ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              type="button"
                              size="icon-xs"
                              variant="ghost-muted"
                              aria-label={gt("Delete bookmark")}
                              onClick={() => void actions.remove(bookmark)}
                            />
                          }
                        >
                          <Trash2Icon />
                        </TooltipTrigger>
                        <TooltipPopup>{gt("Delete")}</TooltipPopup>
                      </Tooltip>
                    ) : null}
                  </div>
                </div>
                {expanded ? (
                  <div className="ms-7 mt-0.5 flex min-w-0 flex-col gap-1.5 pb-1">
                    <p className="max-h-48 overflow-y-auto text-xs break-words whitespace-pre-wrap text-muted-foreground">
                      {bookmark.excerpt}
                    </p>
                    {bookmark.note ? (
                      <p className="text-xs break-words whitespace-pre-wrap">{bookmark.note}</p>
                    ) : null}
                  </div>
                ) : null}
              </>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function BookmarkEditor({
  bookmark,
  onSave,
  onCancel,
}: {
  bookmark: ThreadBookmark;
  onSave: (changes: { title: string | null; note: string | null }) => Promise<void>;
  onCancel: () => void;
}) {
  const gt = useGT();
  const [title, setTitle] = useState(bookmark.title ?? "");
  const [note, setNote] = useState(bookmark.note ?? "");
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    await onSave({ title: title.trim() || null, note: note.trim() || null });
    setSaving(false);
  };
  return (
    <form
      className="flex min-w-0 flex-col gap-2 py-1"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.stopPropagation();
          onCancel();
        }
      }}
    >
      <Input
        autoFocus
        value={title}
        maxLength={THREAD_BOOKMARK_TITLE_MAX_LENGTH}
        placeholder={gt("Title")}
        aria-label={gt("Title")}
        onChange={(event) => setTitle(event.target.value.replace(/[\r\n]+/g, " "))}
      />
      <Textarea
        value={note}
        rows={3}
        maxLength={THREAD_BOOKMARK_NOTE_MAX_LENGTH}
        placeholder={gt("Note")}
        aria-label={gt("Note")}
        onChange={(event) => setNote(event.target.value)}
      />
      <div className="flex justify-end gap-1.5">
        <Button type="button" size="xs" variant="ghost" onClick={onCancel}>
          {gt("Cancel")}
        </Button>
        <Button type="submit" size="xs" disabled={saving}>
          {gt("Save")}
        </Button>
      </div>
    </form>
  );
}
