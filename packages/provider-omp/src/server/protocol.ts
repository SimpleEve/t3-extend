// omp speaks a close dialect of Pi's RPC protocol. This file translates the differences so the Pi
// adapter can drive omp unchanged: see docs/user/providers-omp.md for the protocol table.
import {
  piRecordField as recordField,
  piRecordNumber as recordNumber,
  piRecordString as recordString,
  type PiRpcRecord,
} from "@t3tools/provider-pi/server/rpc";

/** omp's approval prompt title: `Allow tool: <name>`, then one detail line per input. */
const APPROVAL_TITLE = /^Allow tool: (\S+)(?:\n([\s\S]*))?$/;
const APPROVE_FALLBACK = "Approve";
const DENY_FALLBACK = "Deny";

export interface OmpTranslator {
  /** omp stdout frame to the frames the Pi adapter expects (possibly none). */
  readonly fromOmp: (frame: PiRpcRecord) => ReadonlyArray<PiRpcRecord>;
  /** Pi adapter command to the command omp understands. */
  readonly toOmp: (record: PiRpcRecord) => PiRpcRecord;
}

export function makeOmpTranslator(): OmpTranslator {
  let agentRunning = false;
  // Prompts sent while the agent ran are queued behind it; omp's acknowledgement does not say so.
  const sentWhileRunning = new Map<string, boolean>();
  const approvals = new Map<string, { readonly approve: string; readonly deny: string }>();

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

  const fromOmp = (frame: PiRpcRecord): ReadonlyArray<PiRpcRecord> => {
    switch (frame["type"]) {
      case "ready":
      case "prompt_result":
      // The yield settles a turn (see agent_end); omp's quiescence frame would settle it twice.
      case "session_settled":
        return [];
      case "agent_start":
        agentRunning = true;
        return [frame];
      case "agent_end": {
        if (!settled(frame)) return [frame];
        agentRunning = false;
        return [
          frame,
          { type: "agent_settled", aborted: lastAssistantStopReason(frame) === "aborted" },
        ];
      }
      case "manual_compaction_start":
        return [{ type: "compaction_start", reason: "manual" }];
      case "auto_compaction_start":
        return [{ type: "compaction_start", reason: recordString(frame, "reason") ?? "threshold" }];
      case "manual_compaction_end":
      case "auto_compaction_end":
        return [compactionEnd(frame)];
      case "extension_ui_request":
        return [approvalAsConfirm(frame)];
      case "response":
        return [promptAcknowledgement(frame)];
      default:
        return [frame];
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
    if (frame["skipped"] === true || result === undefined || result === null) {
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

  const approvalAsConfirm = (frame: PiRpcRecord): PiRpcRecord => {
    if (frame["method"] !== "select") return frame;
    const id = recordString(frame, "id");
    const match = APPROVAL_TITLE.exec(recordString(frame, "title") ?? "");
    const options = recordField(frame, "options");
    if (id === undefined || match === null || !Array.isArray(options)) return frame;
    const labels = options.filter((option): option is string => typeof option === "string");
    approvals.set(id, {
      approve: labels.find((label) => label === APPROVE_FALLBACK) ?? labels[0] ?? APPROVE_FALLBACK,
      deny: labels.find((label) => label === DENY_FALLBACK) ?? labels.at(-1) ?? DENY_FALLBACK,
    });
    const details = match[2]?.trim();
    const timeout = recordNumber(frame, "timeout");
    return {
      type: "extension_ui_request",
      id,
      method: "confirm",
      title: `Allow ${match[1]}?`,
      ...(details === undefined || details.length === 0 ? {} : { message: details }),
      ...(timeout === undefined ? {} : { timeout }),
    };
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
        return {
          type: "extension_ui_response",
          id,
          value: record["confirmed"] === true ? approval.approve : approval.deny,
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
