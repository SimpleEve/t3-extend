// omp speaks a close dialect of Pi's RPC protocol. This file translates the differences so the Pi
// adapter can drive omp unchanged: see docs/user/providers-omp.md for the protocol table.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import {
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcRecord,
} from "@t3tools/provider-pi/server/rpc";

/** omp's approval prompt title: `Allow tool: <name>`, then one detail line per input. */
const APPROVAL_TITLE = /^Allow tool: (\S+)(?:\n([\s\S]*))?$/;

// omp's select dialog has no option ids: the labels are the values it reads back, so choices are
// found by their meaning. Every label must be one omp is known to send; a prompt with any other
// label is refused whole, because an unknown choice may widen what an approval grants.
const normalizeLabel = (label: string) => label.trim().replace(/\s+/g, " ").toLowerCase();

// Grants wider than the one request: never sent, but recognised so they do not refuse the prompt.
const WIDER_GRANT_LABELS = [
  /^(always )?approve directory: .+$/,
  /^always approve( file)?$/,
  /^approve file$/,
];

interface ApprovalChoices {
  readonly approve: string;
  readonly session: string | undefined;
  readonly deny: string;
}

/** `undefined` unless every option is recognised and there is one approve, one deny, and at most one session approve. */
function readApprovalChoices(
  options: ReadonlyArray<string>,
  tool: string,
): ApprovalChoices | undefined {
  const sessionLabel = `approve ${normalizeLabel(tool)} for this session`;
  const once: Array<string> = [];
  const plain: Array<string> = [];
  const session: Array<string> = [];
  const deny: Array<string> = [];
  for (const option of options) {
    const label = normalizeLabel(option);
    if (label === "approve once") once.push(option);
    else if (label === "approve") plain.push(option);
    else if (label === sessionLabel) session.push(option);
    else if (label === "deny") deny.push(option);
    else if (!WIDER_GRANT_LABELS.some((grant) => grant.test(label))) return undefined;
  }
  // With scoped grants omp calls the plain choice "Approve Once" and uses "Approve" for a grant.
  const approve = once.length > 0 ? once : plain;
  if (approve.length !== 1 || deny.length !== 1 || session.length > 1) return undefined;
  return { approve: approve[0]!, session: session[0], deny: deny[0]! };
}

export interface OmpTranslation {
  /** What the Pi adapter should see, possibly nothing. */
  readonly frames: ReadonlyArray<PiRpcRecord>;
  /** What must go straight back to omp without the adapter's involvement. */
  readonly replies: ReadonlyArray<PiRpcRecord>;
}

export interface OmpTranslator {
  /** omp stdout frame to the frames the Pi adapter expects, and any replies owed to omp. */
  readonly fromOmp: (frame: PiRpcRecord) => OmpTranslation;
  /** Pi adapter command to the command omp understands. */
  readonly toOmp: (record: PiRpcRecord) => PiRpcRecord;
}

export function makeOmpTranslator(): OmpTranslator {
  let agentRunning = false;
  // Prompts sent while the agent ran are queued behind it; omp's acknowledgement does not say so.
  const sentWhileRunning = new Map<string, boolean>();
  const approvals = new Map<string, ApprovalChoices>();
  const frames = (...translated: ReadonlyArray<PiRpcRecord>): OmpTranslation => ({
    frames: translated,
    replies: [],
  });

  const settled = (frame: PiRpcRecord): boolean => {
    const yielded = frame["yielded"];
    return yielded === true || (yielded === undefined && frame["isTerminal"] === true);
  };

  const lastAssistantStopReason = (frame: PiRpcRecord): string | undefined => {
    const messages = frame["messages"];
    if (!Array.isArray(messages)) return undefined;
    for (let index = messages.length - 1; index >= 0; index -= 1) {
      const message: unknown = messages[index];
      if (recordString(message, "role") === "assistant") return recordString(message, "stopReason");
    }
    return undefined;
  };

  const fromOmp = (frame: PiRpcRecord): OmpTranslation => {
    switch (frame["type"]) {
      case "ready":
      case "prompt_result":
      // The yield settles a turn (see agent_end); omp's quiescence frame would settle it twice.
      case "session_settled":
        return frames();
      case "agent_start":
        agentRunning = true;
        return frames(frame);
      case "agent_end": {
        if (!settled(frame)) return frames(frame);
        agentRunning = false;
        return frames(frame, {
          type: "agent_settled",
          aborted: lastAssistantStopReason(frame) === "aborted",
        });
      }
      case "manual_compaction_start":
        return frames({ type: "compaction_start", reason: "manual" });
      case "auto_compaction_start":
        return frames({
          type: "compaction_start",
          reason: recordString(frame, "reason") ?? "threshold",
        });
      case "manual_compaction_end":
      case "auto_compaction_end":
        return frames(compactionEnd(frame));
      case "extension_ui_request":
        return approvalAsConfirm(frame);
      case "response":
        return frames(promptAcknowledgement(frame));
      default:
        return frames(frame);
    }
  };

  const compactionEnd = (frame: PiRpcRecord): PiRpcRecord => {
    const manual = frame["type"] === "manual_compaction_end";
    const base = {
      type: "compaction_end",
      reason: manual ? "manual" : (recordString(frame, "reason") ?? "threshold"),
      aborted: frame["aborted"] === true,
      willRetry: frame["willRetry"] === true,
    };
    const result = frame["result"];
    // Nothing to compact is an ordinary outcome, so it completes with omp's explanation as its note.
    if (frame["skipped"] === true) {
      const note = recordString(frame, "errorMessage");
      return { ...base, skipped: true, result: note === undefined ? {} : { summary: note } };
    }
    if (result === undefined || result === null) {
      const errorMessage = recordString(frame, "errorMessage");
      return { ...base, result: null, ...(errorMessage === undefined ? {} : { errorMessage }) };
    }
    const summary = recordString(result, "summary");
    const tokensBefore = recordNumber(result, "tokensBefore");
    const estimatedTokensAfter = recordNumber(result, "estimatedTokensAfter");
    return {
      ...base,
      result: {
        ...(summary === undefined ? {} : { summary }),
        ...(tokensBefore === undefined ? {} : { tokensBefore }),
        ...(estimatedTokensAfter === undefined ? {} : { estimatedTokensAfter }),
      },
    };
  };

  const approvalAsConfirm = (frame: PiRpcRecord): OmpTranslation => {
    if (frame["method"] !== "select") return frames(frame);
    const id = recordString(frame, "id");
    const match = APPROVAL_TITLE.exec(recordString(frame, "title") ?? "");
    const options = recordField(frame, "options");
    if (id === undefined || match === null || !Array.isArray(options)) return frames(frame);
    const labels = options.filter((option): option is string => typeof option === "string");
    const choices = readApprovalChoices(labels, match[1] ?? "");
    if (choices === undefined) {
      // Guessing a choice could approve something the user never saw, so omp is told to deny.
      return {
        frames: [
          {
            type: "extension_ui_request",
            id: `${id}:unreadable`,
            method: "notify",
            notifyType: "error",
            message: `omp asked to allow ${match[1]} in a format T3 Code does not recognise (${labels.join(" / ")}), so the request was denied.`,
          },
        ],
        replies: [{ type: "extension_ui_response", id, cancelled: true }],
      };
    }
    approvals.set(id, choices);
    const details = match[2]?.trim();
    const timeout = recordNumber(frame, "timeout");
    return frames({
      type: "extension_ui_request",
      id,
      method: "confirm",
      title: `Allow ${match[1]}?`,
      ...(details === undefined || details.length === 0 ? {} : { message: details }),
      ...(timeout === undefined ? {} : { timeout }),
    });
  };

  const promptAcknowledgement = (frame: PiRpcRecord): PiRpcRecord => {
    if (frame["command"] !== "prompt") return frame;
    const id = recordString(frame, "id");
    const queued = id === undefined ? false : (sentWhileRunning.get(id) ?? false);
    if (id !== undefined) sentWhileRunning.delete(id);
    if (frame["success"] !== true) return frame;
    const data = frame["data"];
    const dataFields =
      typeof data === "object" && data !== null && !Array.isArray(data) ? data : {};
    if (recordField(data, "agentInvoked") === false) {
      return { ...frame, data: { ...dataFields, disposition: "handled" } };
    }
    return queued ? { ...frame, data: { ...dataFields, disposition: "queued" } } : frame;
  };

  const toOmp = (record: PiRpcRecord): PiRpcRecord => {
    switch (record["type"]) {
      case "prompt": {
        const id = recordString(record, "id");
        if (id !== undefined) sentWhileRunning.set(id, agentRunning);
        return record;
      }
      case "get_commands":
        return { ...record, type: "get_available_commands" };
      // Pi's fork starts the new session before the entry; omp's `fork` keeps the entry, and its
      // `branch` (which also returns the entry's text) is the one that cuts before it.
      case "fork":
        return { ...record, type: "branch" };
      // Pi's clear_queue empties the queue and leaves the run alone; omp's closest command also
      // aborts, which both callers (Stop and restart) send next anyway.
      case "clear_queue":
        return { ...record, type: "abort_and_restore_queue" };
      case "extension_ui_response": {
        const id = recordString(record, "id");
        const approval = id === undefined ? undefined : approvals.get(id);
        if (id === undefined || approval === undefined) return record;
        approvals.delete(id);
        if (record["cancelled"] === true)
          return { type: "extension_ui_response", id, cancelled: true };
        if (record["confirmed"] !== true) {
          return { type: "extension_ui_response", id, value: approval.deny };
        }
        // Without omp's session choice the approval stays a single one; the adapter's own memory
        // of identical requests still covers the rest of the session.
        return {
          type: "extension_ui_response",
          id,
          value:
            record["forSession"] === true && approval.session !== undefined
              ? approval.session
              : approval.approve,
        };
      }
      default:
        return record;
    }
  };

  return { fromOmp, toOmp };
}

/** The data of a successful response, reshaped for the command the Pi adapter sent. */
export function translateOmpResponseData(command: string, data: unknown): unknown {
  switch (command) {
    case "get_commands":
      return projectOmpCommands(data);
    case "get_state": {
      if (typeof data !== "object" || data === null || Array.isArray(data)) return data;
      const queued = recordField(data, "queuedMessages");
      const count = (key: string) => {
        const entries = recordField(queued, key);
        return Array.isArray(entries) ? entries.length : 0;
      };
      // queuedMessageCount also counts advisor cards and next-turn notes the user cannot withdraw.
      return { ...data, pendingMessageCount: count("steering") + count("followUp") };
    }
    case "clear_queue": {
      const texts = (key: string) => {
        const entries = recordField(data, key);
        return Array.isArray(entries)
          ? entries.flatMap((entry) => {
              const text = recordString(entry, "text");
              return text === undefined ? [] : [text];
            })
          : [];
      };
      return { steering: texts("steering"), followUp: texts("followUp") };
    }
    default:
      return data;
  }
}

/**
 * omp's builtin commands are TUI actions, and most do nothing useful over RPC (or reset the
 * session out from under T3). `/compact` reaches the adapter through its own RPC, so no builtin
 * is advertised here.
 */
export function projectOmpCommands(data: unknown): {
  readonly commands: ReadonlyArray<PiRpcRecord>;
} {
  const commands = recordField(data, "commands");
  if (!Array.isArray(commands)) return { commands: [] };
  const projected: Array<PiRpcRecord> = [];
  for (const command of commands) {
    const name = recordString(command, "name");
    const source = recordString(command, "source");
    if (name === undefined || source === undefined || source === "builtin") continue;
    const description = recordString(command, "description");
    projected.push({
      name,
      // Pi calls omp's custom and file commands prompt templates.
      source: source === "custom" || source === "file" ? "prompt" : source,
      ...(description === undefined ? {} : { description }),
    });
  }
  return { commands: projected };
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/** omp's first line is a title record; the `session` record that names the cwd follows it. */
export function readOmpSessionCwd(headerLines: ReadonlyArray<string>): string | undefined {
  for (const line of headerLines) {
    const record = Option.getOrUndefined(decodeLine(line));
    if (recordString(record, "type") === "session") return recordString(record, "cwd");
  }
  return undefined;
}
