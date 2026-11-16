// fork: pure helpers that make imported rows independent of the official app's ids and folders.

const UUID_SOURCE = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const UUID_ONLY = new RegExp(`^${UUID_SOURCE}$`);

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A UUID derived from a digest, so the same source id always lands on the same target id. */
export const uuidFromDigest = (digest: Uint8Array): string => {
  const bytes = Uint8Array.from(digest.slice(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

const TASK_FIELD = "scheduledTaskId";

const moveTaskFields = (
  value: unknown,
  taskIds: ReadonlyMap<string, string>,
  state: { changed: boolean },
): unknown => {
  if (Array.isArray(value)) return value.map((item) => moveTaskFields(item, taskIds, state));
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      if (key === TASK_FIELD && typeof item === "string") {
        const target = taskIds.get(item);
        if (target !== undefined) {
          state.changed = true;
          return [key, target];
        }
      }
      return [key, moveTaskFields(item, taskIds, state)];
    }),
  );
};

/**
 * Moves the `scheduledTaskId` property of any object in a JSON document to its imported id, or returns null when
 * the text is not JSON or holds none to move. The document is parsed, so text that merely contains the same
 * characters (a message quoting a payload, a string holding JSON) is never touched. A changed document is written
 * back compact, as these rows were written; numbers beyond double precision would differ, and the payloads have none.
 */
export const moveTaskIdFields = (
  text: string,
  taskIds: ReadonlyMap<string, string>,
): string | null => {
  if (taskIds.size === 0 || !text.includes(TASK_FIELD)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const state = { changed: false };
  const moved = moveTaskFields(parsed, taskIds, state);
  return state.changed ? JSON.stringify(moved) : null;
};

export interface CopiedFileRef {
  readonly kind: "attachments" | "browser-artifacts";
  /** File name as it is called in the source folder. */
  readonly name: string;
}

export interface Rewriter {
  /** Source id → target id everywhere in `text`, and source folders → this environment's folders. */
  readonly rewrite: (text: string) => string;
  /** Files that rewritten paths point at; the caller copies them. */
  readonly referencedFiles: () => ReadonlyArray<CopiedFileRef>;
  readonly rewrittenPathCount: () => number;
}

/** Ids nest: the allocator joins `encodeURIComponent`ed parts, and those ids become parts of the next id. */
const ENCODING_DEPTH = 4;

/** Every spelling a mapped id takes inside other ids, source and target encoded alike. */
const spellings = (ids: ReadonlyMap<string, string>): Map<string, string> => {
  const all = new Map<string, string>();
  for (const [source, target] of ids) {
    let from = source;
    let to = target;
    for (let depth = 0; depth <= ENCODING_DEPTH; depth += 1) {
      all.set(from, to);
      from = encodeURIComponent(from);
      to = encodeURIComponent(to);
    }
  }
  return all;
};

export const makeRewriter = (input: {
  readonly ids: ReadonlyMap<string, string>;
  readonly sourceStateDir: string;
  readonly targetAttachmentsDir: string;
  readonly targetBrowserArtifactsDir: string;
  /** Official scheduled-task id → the id it is (or will be) imported under; only the `scheduledTaskId` fields move. */
  readonly taskIds?: ReadonlyMap<string, string>;
}): Rewriter => {
  const ids = spellings(input.ids);
  const allUuids = [...ids.keys()].every((id) => UUID_ONLY.test(id));
  const idPattern =
    ids.size === 0
      ? null
      : allUuids
        ? new RegExp(UUID_SOURCE, "g")
        : new RegExp(
            [...ids.keys()]
              .toSorted((a, b) => b.length - a.length)
              .map(escapeRegExp)
              .join("|"),
            "g",
          );
  const files = new Map<string, CopiedFileRef>();
  let rewrittenPaths = 0;
  const folders = [
    ["attachments", input.targetAttachmentsDir],
    ["browser-artifacts", input.targetBrowserArtifactsDir],
  ] as const;
  const folderPatterns = folders.map(
    ([kind, target]) =>
      [
        kind,
        target,
        new RegExp(`${escapeRegExp(`${input.sourceStateDir}/${kind}/`)}([^"\\\\\\s/]+)`, "g"),
      ] as const,
  );

  const rewrite = (text: string): string => {
    let next = text;
    if (next.length >= input.sourceStateDir.length) {
      for (const [kind, target, pattern] of folderPatterns) {
        next = next.replace(pattern, (_match, name: string) => {
          files.set(`${kind}/${name}`, { kind, name });
          rewrittenPaths += 1;
          return `${target}/${name}`;
        });
      }
    }
    if (idPattern !== null) next = next.replace(idPattern, (match) => ids.get(match) ?? match);
    return (input.taskIds === undefined ? null : moveTaskIdFields(next, input.taskIds)) ?? next;
  };
  return {
    rewrite,
    referencedFiles: () => [...files.values()],
    rewrittenPathCount: () => rewrittenPaths,
  };
};

const parseObject = (json: string): Record<string, unknown> | null => {
  try {
    const value: unknown = JSON.parse(json);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** Usage-limit recovery would resume the thread on its own; the official app owns that decision. */
export const clearLimitRecovery = (
  payloadJson: string,
): { readonly json: string; readonly cleared: boolean } => {
  const payload = parseObject(payloadJson);
  if (payload === null || payload.limitRecovery === undefined || payload.limitRecovery === null) {
    return { json: payloadJson, cleared: false };
  }
  return { json: JSON.stringify({ ...payload, limitRecovery: null }), cleared: true };
};

/** A provider thread keeps its native conversation handle but loses the live session and any running state. */
export const detachProviderThread = (
  payloadJson: string,
): { readonly json: string; readonly status: string | null } => {
  const payload = parseObject(payloadJson);
  if (payload === null) return { json: payloadJson, status: null };
  const status = payload.status === "active" ? "idle" : String(payload.status ?? "idle");
  return {
    json: JSON.stringify({
      ...payload,
      providerSessionId: null,
      status,
      pendingBackgroundTasks: [],
    }),
    status,
  };
};

/** A subagent card whose child thread is not part of the import stays, but points at nothing. */
export const unlinkSubagentChild = (payloadJson: string): string => {
  const payload = parseObject(payloadJson);
  if (payload === null) return payloadJson;
  return JSON.stringify({ ...payload, childThreadId: null });
};

/** A checkpoint whose ref was not carried over says so, whether it sits in a row or in an event. */
export const markCheckpointMissing = (
  payloadJson: string,
  missing: ReadonlySet<string>,
): string | null => {
  const payload = parseObject(payloadJson);
  if (payload === null || typeof payload.ref !== "string" || !missing.has(payload.ref)) return null;
  return JSON.stringify({ ...payload, status: "missing" });
};

/**
 * An imported Antigravity instance signed in through the official app's own profile, which the
 * import does not copy. Pin it to a separate sign-in so `auto` never gives it the agy CLI's account.
 * A choice already made in the instance stays.
 */
export const pinImportedAntigravityLogin = (instance: unknown): unknown => {
  if (typeof instance !== "object" || instance === null) return instance;
  const record = instance as { readonly driver?: unknown; readonly config?: unknown };
  if (record.driver !== "antigravity") return instance;
  const settings =
    typeof record.config === "object" && record.config !== null
      ? (record.config as Record<string, unknown>)
      : {};
  return { ...record, config: { loginSource: "profile", ...settings } };
};
