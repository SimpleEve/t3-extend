import type { OrchestrationV2TurnItem } from "@t3tools/contracts";
import {
  extractMarkdownLinkHrefs,
  resolveMarkdownFileLinkTarget,
} from "@t3tools/shared/markdownLinks";

import {
  isDeletedChangeKind,
  isNoiseOutputPath,
  normalizeOutputPath,
  outputPathKey,
} from "./paths.ts";
import { commandOutputUrls, extractHttpUrls } from "./urls.ts";

/** `reply`: the final answer links to it. `changed`: a tool wrote it during the run. */
export type OutputFileSource = "reply" | "changed";

export interface OutputFile {
  readonly path: string;
  readonly line?: number;
  readonly source: OutputFileSource;
}

export interface OutputLink {
  readonly url: string;
}

export interface RunOutputs {
  readonly files: ReadonlyArray<OutputFile>;
  readonly links: ReadonlyArray<OutputLink>;
}

export const EMPTY_RUN_OUTPUTS: RunOutputs = Object.freeze({
  files: Object.freeze([]),
  links: Object.freeze([]),
});

/** A run that rewrites a whole tree must not turn the list into the tree. */
const MAX_RUN_OUTPUT_FILES = 100;
const MAX_RUN_OUTPUT_LINKS = 50;

export interface CheckpointOutputFile {
  readonly path: string;
  readonly kind: string;
}

type FileChangeItem = Extract<OrchestrationV2TurnItem, { type: "file_change" }>;
type CommandItem = Extract<OrchestrationV2TurnItem, { type: "command_execution" }>;

interface ItemOutputs {
  readonly changedPaths: ReadonlyArray<string>;
  readonly urls: ReadonlyArray<string>;
}

const NO_ITEM_OUTPUTS: ItemOutputs = { changedPaths: [], urls: [] };

// Items keep their identity while a thread streams, so each is scanned once.
const itemOutputsCache = new WeakMap<object, ItemOutputs>();

function fileChangeOutputs(item: FileChangeItem): ItemOutputs {
  const paths =
    item.changes !== undefined && item.changes.length > 0
      ? item.changes.flatMap((change) =>
          isDeletedChangeKind(change.operation) ? [] : [change.path],
        )
      : [item.fileName];
  return { changedPaths: paths, urls: [] };
}

function itemOutputs(item: { readonly type: string }): ItemOutputs {
  if (item.type !== "file_change" && item.type !== "command_execution") return NO_ITEM_OUTPUTS;
  const cached = itemOutputsCache.get(item);
  if (cached !== undefined) return cached;
  const outputs =
    item.type === "file_change"
      ? fileChangeOutputs(item as FileChangeItem)
      : {
          changedPaths: [],
          urls: commandOutputUrls(
            (item as CommandItem).input,
            // Withheld output is fetched on demand; a list built from it would change on open.
            (item as CommandItem).output,
          ),
        };
  itemOutputsCache.set(item, outputs);
  return outputs;
}

/** The local files a reply's markdown links to, in the order it links them. */
export function replyLinkedFiles(
  replyText: string,
  cwd: string | undefined,
): ReadonlyArray<{ readonly path: string; readonly line?: number }> {
  if (replyText.length === 0) return [];
  const files: Array<{ path: string; line?: number }> = [];
  for (const href of extractMarkdownLinkHrefs(replyText)) {
    const target = resolveMarkdownFileLinkTarget(href, cwd, cwd);
    if (target === null) continue;
    const normalized = normalizeOutputPath(target, cwd);
    if (normalized !== null) files.push(normalized);
  }
  return files;
}

export interface RunOutputsInput {
  /** The run's last assistant message; undefined while the run has none. */
  readonly replyText: string | undefined;
  /** Every item of the run; only file changes and command results are read. */
  readonly items: ReadonlyArray<{ readonly type: string }>;
  readonly checkpointFiles?: ReadonlyArray<CheckpointOutputFile> | undefined;
  /** The thread's working directory, which relative paths resolve against. */
  readonly cwd: string | undefined;
}

export function deriveRunOutputs(input: RunOutputsInput): RunOutputs {
  const files = new Map<string, OutputFile>();
  const links = new Map<string, OutputLink>();
  const addFile = (raw: string, source: OutputFileSource, linkedLine?: number) => {
    if (files.size >= MAX_RUN_OUTPUT_FILES) return;
    const normalized = normalizeOutputPath(raw, input.cwd);
    if (normalized === null) return;
    if (source === "changed" && isNoiseOutputPath(normalized.path)) return;
    const key = outputPathKey(normalized.path);
    if (files.has(key)) return;
    const line = linkedLine ?? normalized.line;
    files.set(key, {
      path: normalized.path,
      ...(line === undefined ? {} : { line }),
      source,
    });
  };
  const addUrl = (url: string) => {
    if (links.size >= MAX_RUN_OUTPUT_LINKS || links.has(url)) return;
    links.set(url, { url });
  };

  const reply = input.replyText ?? "";
  for (const file of replyLinkedFiles(reply, input.cwd)) addFile(file.path, "reply", file.line);
  for (const item of input.items) {
    for (const path of itemOutputs(item).changedPaths) addFile(path, "changed");
  }
  for (const file of input.checkpointFiles ?? []) {
    if (!isDeletedChangeKind(file.kind)) addFile(file.path, "changed");
  }

  for (const url of extractHttpUrls(reply)) addUrl(url);
  for (const item of input.items) {
    for (const url of itemOutputs(item).urls) addUrl(url);
  }

  if (files.size === 0 && links.size === 0) return EMPTY_RUN_OUTPUTS;
  return { files: [...files.values()], links: [...links.values()] };
}

export function sameRunOutputs(left: RunOutputs, right: RunOutputs): boolean {
  if (left === right) return true;
  return (
    left.files.length === right.files.length &&
    left.links.length === right.links.length &&
    left.files.every((file, index) => {
      const other = right.files[index]!;
      return file.path === other.path && file.line === other.line && file.source === other.source;
    }) &&
    left.links.every((link, index) => link.url === right.links[index]!.url)
  );
}
