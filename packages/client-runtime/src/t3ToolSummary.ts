import type { T3McpToolSummaryAction } from "@t3tools/shared/t3McpToolPresentation";

import { englishWorkLogPhrase, type WorkLogPhraseTranslator } from "./work-log/phrase.ts"; // fork

export interface T3ToolSummaryCall {
  readonly input: unknown;
  readonly output: unknown;
  readonly outcome: "completed" | "failed" | "unfinished";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function id(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

interface ToolResult {
  readonly data?: Record<string, unknown>;
  readonly failed: boolean;
}

function readResult(value: unknown, depth = 0): ToolResult {
  if (depth > 4) return { failed: false };
  if (typeof value === "string") {
    try {
      return readResult(JSON.parse(value), depth + 1);
    } catch {
      return { failed: false };
    }
  }
  if (Array.isArray(value)) {
    let data: ToolResult["data"];
    let failed = false;
    for (const block of value) {
      const record = asRecord(block);
      const text = record?.text ?? asRecord(record?.content)?.text;
      const result = readResult(asRecord(text)?.text ?? text, depth + 1);
      data ??= result.data;
      failed ||= result.failed;
    }
    return { ...(data ? { data } : {}), failed };
  }
  const record = asRecord(value);
  if (!record) return { failed: false };
  const failed =
    record.isError === true ||
    record.is_error === true ||
    (typeof record._tag === "string" && /(?:Error|Failure)$/.test(record._tag)) ||
    record.error != null;
  const content = record.structuredContent ?? record.content;
  if (content !== undefined) {
    const result = readResult(content, depth + 1);
    return { ...(result.data ? { data: result.data } : {}), failed: failed || result.failed };
  }
  return { data: record, failed };
}

function readInput(value: unknown): Record<string, unknown> | undefined {
  const input = readResult(value).data;
  // Historical Cursor items retain the MCP args envelope.
  return input && typeof input.toolName === "string" ? asRecord(input.args) : input;
}

/** MCP errors can be returned as data even when the provider completed the tool call. */
export function t3ToolResultIndicatesFailure(output: unknown): boolean {
  return readResult(output).failed;
}

function countEntities(ids: ReadonlyArray<string | undefined>): number {
  return (
    new Set(ids.filter((value) => value !== undefined)).size +
    ids.filter((value) => value === undefined).length
  );
}

// fork: `one` and `many` are whole phrases so the translator sees each one with its count.
function quantity(count: number, one: string, many: string, t: WorkLogPhraseTranslator): string {
  return count === 1 ? t(one, { count }) : t(many, { count });
}

// fork: i18n
function issueQuantity(count: number, t: WorkLogPhraseTranslator): string {
  return quantity(count, "{count} issue", "{count} issues", t);
}

/** One PR per single call; a batch counts what its result reports. */
function pullRequestQuantity(
  calls: ReadonlyArray<{
    readonly input: Record<string, unknown> | undefined;
    readonly output: Record<string, unknown> | undefined;
  }>,
  countKey: "linkedCount" | "unlinkedCount",
  t: WorkLogPhraseTranslator,
): string {
  let count = 0;
  for (const call of calls) {
    const reported = call.output?.[countKey];
    if (typeof reported === "number") count += reported;
    else if (call.input?.url !== undefined || call.input?.number !== undefined) count += 1;
    // A batch result too large to compact loses its count, so the label drops the number.
    else return "pull requests";
  }
  return quantity(count, "{count} pull request", "{count} pull requests", t);
}

export function summarizeT3ToolCalls(
  action: T3McpToolSummaryAction,
  calls: ReadonlyArray<T3ToolSummaryCall>,
): { label: string; failedCount: number } {
  const results = calls.map((call) => {
    const result = readResult(call.output);
    return {
      input: readInput(call.input),
      output: result.data,
      outcome: result.failed ? ("failed" as const) : call.outcome,
    };
  });
  const completed = results.filter((call) => call.outcome === "completed");
  let failedCount = results.filter((call) => call.outcome === "failed").length;
  const selected = completed.length > 0 ? completed : results;
  const times = quantity(selected.length, "{count} time", "{count} times", t);
  const phrase = (past: string, tried: string, object: string) =>
    t(completed.length > 0 ? past : tried, { object });
  const entityIds = (key: string) =>
    selected.map((call) => id(call.output?.[key]) ?? id(call.input?.[key]));
  const projectIds = selected.map(
    (call) => id(call.output?.id) ?? id(call.output?.projectId) ?? id(call.input?.projectId),
  );
  const threadIds = selected.map(
    (call) =>
      id(call.output?.threadId) ??
      id(asRecord(call.output?.thread)?.threadId) ??
      id(call.input?.threadId),
  );
  let label: string;
  switch (action) {
    case "thread-send": {
      const messages = countEntities(selected.map((call) => id(call.output?.messageId)));
      const targetsKnown = threadIds.every((value) => value !== undefined);
      const threads = new Set(threadIds).size;
      const object = targetsKnown
        ? messages === threads && messages > 1
          ? t("messages to {threads}", {
              threads: quantity(threads, "{count} thread", "{count} threads", t),
            })
          : t("{messages} to {threads}", {
              messages: quantity(messages, "{count} message", "{count} messages", t),
              threads: quantity(threads, "{count} thread", "{count} threads", t),
            })
        : quantity(messages, "{count} message", "{count} messages", t);
      label = phrase("Sent {object}", "Tried to send {object}", object);
      break;
    }
    case "thread-create": {
      const createdIds: string[] = [];
      const resultsKnown =
        completed.length > 0 &&
        completed.every((call) => {
          const threads = Array.isArray(call.output?.threads) ? call.output.threads : [call.output];
          return threads.every((thread) => {
            const record = asRecord(thread);
            if (record?.status === "rolled_back") return true;
            const threadId = id(record?.threadId);
            if (!threadId) return false;
            createdIds.push(threadId);
            return true;
          });
        });
      label = resultsKnown
        ? `Created ${quantity(new Set(createdIds).size, "thread")}`
        : `Requested thread creation ${times}`;
      break;
    }
    case "delegate":
      label = phrase(
        "Delegated {object}",
        "Tried to delegate {object}",
        quantity(countEntities(entityIds("taskId")), "{count} task", "{count} tasks", t),
      );
      break;
    case "thread-read":
    case "thread-wait": {
      const targets = threadIds.every((value) => value !== undefined)
        ? quantity(new Set(threadIds).size, "{count} thread", "{count} threads", t)
        : t("threads {times}", { times });
      label =
        action === "thread-read"
          ? phrase("Read {object}", "Tried to read {object}", targets)
          : phrase("Waited on {object}", "Tried to wait on {object}", targets);
      break;
    }
    case "thread-list":
      label = phrase("Listed", "list", `threads ${times}`);
      break;
    case "thread-interrupt":
      label = phrase(
        "Requested interrupts for {object}",
        "Tried to interrupt {object}",
        quantity(countEntities(threadIds), "{count} thread", "{count} threads", t),
      );
      break;
    case "workflow-stop":
      label = phrase(
        "Requested stops for {object}",
        "Tried to stop {object}",
        quantity(
          countEntities(entityIds("subagentId")),
          "{count} workflow",
          "{count} workflows",
          t,
        ),
      );
      break;
    case "task-status":
      label = phrase(
        "Checked {object}",
        "Tried to check {object}",
        t("task status {times}", { times }),
      );
      break;
    case "background-wait":
      label = phrase(
        "Updated {object}",
        "Tried to update {object}",
        t("background waits {times}", { times }),
      );
      break;
    case "task-cancel":
      label = phrase(
        "Requested cancellation of {object}",
        "Tried to cancel {object}",
        quantity(countEntities(entityIds("taskId")), "{count} task", "{count} tasks", t),
      );
      break;
    case "schedule-create":
      label = phrase(
        "Scheduled {object}",
        "Tried to schedule {object}",
        quantity(countEntities(entityIds("scheduledTaskId")), "{count} task", "{count} tasks", t),
      );
      break;
    case "schedule-list":
      label = phrase(
        "Listed {object}",
        "Tried to list {object}",
        t("scheduled tasks {times}", { times }),
      );
      break;
    case "schedule-update":
      label = phrase(
        "Updated {object}",
        "Tried to update {object}",
        quantity(
          countEntities(entityIds("scheduledTaskId")),
          "{count} scheduled task",
          "{count} scheduled tasks",
          t,
        ),
      );
      break;
    case "schedule-delete":
      label = phrase(
        "Requested deletion of {object}",
        "Tried to delete {object}",
        quantity(
          countEntities(entityIds("scheduledTaskId")),
          "{count} scheduled task",
          "{count} scheduled tasks",
          t,
        ),
      );
      break;
    case "schedule-run":
      label = phrase(
        "Requested {object}",
        "Tried to request {object}",
        quantity(selected.length, "{count} scheduled task run", "{count} scheduled task runs", t),
      );
      break;
    case "thread-configuration":
      label = phrase(
        "Checked {object}",
        "Tried to check {object}",
        t("thread configuration {times}", { times }),
      );
      break;
    case "thread-configure":
      label = phrase("Set", "set", `thread model ${times}`);
      break;
    case "thread-fork":
      label = phrase(
        "Requested {object}",
        "Tried to request {object}",
        quantity(selected.length, "{count} thread fork", "{count} thread forks", t),
      );
      break;
    case "thread-merge":
      label = phrase(
        "Requested {object}",
        "Tried to request {object}",
        quantity(selected.length, "{count} context merge", "{count} context merges", t),
      );
      break;
    case "thread-search":
      label = phrase(
        "Searched {object}",
        "Tried to search {object}",
        t("threads {times}", { times }),
      );
      break;
    case "thread-transfers":
      label = phrase(
        "Checked {object}",
        "Tried to check {object}",
        t("thread transfers {times}", { times }),
      );
      break;
    case "thread-organize":
      label = phrase(
        "Organized {object}",
        "Tried to organize {object}",
        t("threads {times}", { times }),
      );
      break;
    case "thread-update":
      label = phrase(
        "Updated {object}",
        "Tried to update {object}",
        quantity(countEntities(threadIds), "{count} thread", "{count} threads", t),
      );
      break;
    case "queue-list":
      label = phrase(
        "Listed {object}",
        "Tried to list {object}",
        t("queued messages {times}", { times }),
      );
      break;
    case "queue-read":
      label = phrase(
        "Read {object}",
        "Tried to read {object}",
        quantity(
          countEntities(entityIds("queuedRunId")),
          "{count} queued message",
          "{count} queued messages",
          t,
        ),
      );
      break;
    case "queue-edit":
      label = phrase(
        "Edited {object}",
        "Tried to edit {object}",
        quantity(
          countEntities(entityIds("queuedRunId")),
          "{count} queued message",
          "{count} queued messages",
          t,
        ),
      );
      break;
    case "queue-cancel":
      label = phrase(
        "Requested cancellation of {object}",
        "Tried to cancel {object}",
        quantity(
          countEntities(entityIds("queuedRunId")),
          "{count} queued run",
          "{count} queued runs",
          t,
        ),
      );
      break;
    case "queue-reorder":
      label = phrase(
        "Reordered {object}",
        "Tried to reorder {object}",
        quantity(
          countEntities(entityIds("queuedRunId")),
          "{count} queued run",
          "{count} queued runs",
          t,
        ),
      );
      break;
    case "queue-steer":
      label = phrase(
        "Requested steering with {object}",
        "Tried to steer with {object}",
        quantity(
          countEntities(entityIds("queuedRunId")),
          "{count} queued message",
          "{count} queued messages",
          t,
        ),
      );
      break;
    case "question-list":
      label = phrase(
        "Listed {object}",
        "Tried to list {object}",
        t("pending questions {times}", { times }),
      );
      break;
    case "question-read":
      label = phrase(
        "Read {object}",
        "Tried to read {object}",
        quantity(
          countEntities(entityIds("requestId")),
          "{count} pending question request",
          "{count} pending question requests",
          t,
        ),
      );
      break;
    case "question-respond":
      label = phrase(
        "Answered {object}",
        "Tried to answer {object}",
        quantity(
          countEntities(entityIds("requestId")),
          "{count} pending question request",
          "{count} pending question requests",
          t,
        ),
      );
      break;
    case "secret-request":
      label = phrase(
        "Asked for {object}",
        "Tried to ask for {object}",
        quantity(selected.length, "{count} secret", "{count} secrets", t),
      );
      break;
    case "worktree-handoff":
      label = phrase(
        "Handed off to {object}",
        "Tried to hand off to {object}",
        quantity(
          countEntities(entityIds("worktreePath")),
          "{count} worktree",
          "{count} worktrees",
          t,
        ),
      );
      break;
    case "worktree-list":
      label = phrase(
        "Listed {object}",
        "Tried to list {object}",
        t("workspace branches {times}", { times }),
      );
      break;
    case "worktree-status":
      label = phrase(
        "Checked {object}",
        "Tried to check {object}",
        t("worktree status {times}", { times }),
      );
      break;
    case "project-list":
      label = phrase("Listed", "list", `projects ${times}`);
      break;
    case "project-read":
      label = phrase(
        "Read {object}",
        "Tried to read {object}",
        quantity(countEntities(projectIds), "{count} project", "{count} projects", t),
      );
      break;
    case "project-create":
      label = phrase(
        "Registered {object}",
        "Tried to register {object}",
        quantity(countEntities(projectIds), "{count} project", "{count} projects", t),
      );
      break;
    case "project-update":
      label = phrase(
        "Updated {object}",
        "Tried to update {object}",
        quantity(countEntities(projectIds), "{count} project", "{count} projects", t),
      );
      break;
    case "project-delete":
      label = phrase(
        "Deleted {object}",
        "Tried to delete {object}",
        quantity(countEntities(projectIds), "{count} project", "{count} projects", t),
      );
      break;
    case "project-clone":
      label = phrase(
        "Cloned {object}",
        "Tried to clone {object}",
        quantity(countEntities(entityIds("cwd")), "{count} repository", "{count} repositories", t),
      );
      break;
    case "environment-read":
      label = phrase(
        "Checked {object}",
        "Tried to check {object}",
        t("environment preferences {times}", { times }),
      );
      break;
    case "environment-update":
      label = phrase(
        "Updated {object}",
        "Tried to update {object}",
        t("environment preferences {times}", { times }),
      );
      break;
    case "theme-read":
      label = phrase("Checked", "check", `themes ${times}`);
      break;
    case "theme-set":
      label = phrase("Set", "set", `the theme ${times}`);
      break;
    case "environment-links":
      label = phrase(
        "Listed {object}",
        "Tried to list {object}",
        t("linked environments {times}", { times }),
      );
      break;
    case "environment-link":
      label = phrase(
        "Asked to link {object}",
        "Tried to ask to link {object}",
        quantity(selected.length, "{count} environment", "{count} environments", t),
      );
      break;
    case "environment-unlink":
      label = phrase(
        "Forgot {object}",
        "Tried to forget {object}",
        quantity(
          countEntities(entityIds("environmentId")),
          "{count} linked environment",
          "{count} linked environments",
          t,
        ),
      );
      break;
    case "attachment-prepare":
      label = phrase(
        "Prepared {object}",
        "Tried to prepare {object}",
        quantity(
          countEntities(entityIds("attachmentId")),
          "{count} attachment upload",
          "{count} attachment uploads",
          t,
        ),
      );
      break;
    case "attachment-discard":
      label = phrase(
        "Discarded {object}",
        "Tried to discard {object}",
        quantity(
          countEntities(entityIds("attachmentId")),
          "{count} pending attachment",
          "{count} pending attachments",
          t,
        ),
      );
      break;
    case "attachment-send": {
      const messages = new Map<string, (typeof selected)[number]>();
      selected.forEach((call, index) =>
        messages.set(id(call.output?.messageId) ?? `call-${index}`, call),
      );
      const attachmentCount = [...messages.values()].reduce(
        (count, call) =>
          count + (Array.isArray(call.input?.attachments) ? call.input.attachments.length : 0),
        0,
      );
      const countsKnown = [...messages.values()].every(
        (call) => Array.isArray(call.input?.attachments) && call.input.attachments.length > 0,
      );
      const targets = threadIds.every((value) => value !== undefined)
        ? quantity(new Set(threadIds).size, "{count} thread", "{count} threads", t)
        : null;
      label = phrase(
        "Sent {object}",
        "Tried to send {object}",
        countsKnown
          ? targets === null
            ? quantity(attachmentCount, "{count} attachment", "{count} attachments", t)
            : t("{attachments} to {threads}", {
                attachments: quantity(
                  attachmentCount,
                  "{count} attachment",
                  "{count} attachments",
                  t,
                ),
                threads: targets,
              })
          : targets === null
            ? t("attachments {times}", { times })
            : t("attachments to {threads} {times}", { threads: targets, times }),
      );
      break;
    }
    case "link-pr":
      label = phrase(
        "Linked {object}",
        "Tried to link {object}",
        pullRequestQuantity(selected, "linkedCount", t),
      );
      break;
    case "unlink-pr":
      label = phrase(
        "Unlinked {object}",
        "Tried to unlink {object}",
        pullRequestQuantity(selected, "unlinkedCount", t),
      );
      break;
    case "watch-pr":
      label = phrase(
        "Watching {object}",
        "Tried to watch {object}",
        quantity(selected.length, "{count} pull request", "{count} pull requests", t),
      );
      break;
    case "unwatch-pr":
      label = phrase(
        "Stopped watching {object}",
        "Tried to stop watching {object}",
        quantity(selected.length, "{count} pull request", "{count} pull requests", t),
      );
      break;
    case "list-prs":
      label = phrase(
        "Checked {object}",
        "Tried to check {object}",
        selected.length === 1
          ? t("linked pull requests")
          : t("linked pull requests {times}", { times }),
      );
      break;
    case "write-pr-guides": {
      // One call writes many guides, and reports a refusal per guide rather than failing.
      const outcomes = selected.flatMap((call) =>
        Array.isArray(call.output?.guides)
          ? call.output.guides.map((guide) => asRecord(guide)?.outcome)
          : [],
      );
      const started = outcomes.filter((outcome) => outcome !== "failed").length;
      const failed = outcomes.length - started;
      failedCount += failed;
      if (outcomes.length === 0) {
        label = phrase(
          "Started writing",
          "start writing",
          `review guides${selected.length === 1 ? "" : ` ${times}`}`,
        );
      } else if (started === 0) {
        label = `Could not start ${quantity(failed, "review guide")}`;
      } else {
        label = phrase(
          "Started {object}",
          "Tried to start {object}",
          failed > 0
            ? t("{started}, {failed} failed", {
                started: quantity(started, "{count} review guide", "{count} review guides", t),
                failed,
              })
            : quantity(started, "{count} review guide", "{count} review guides", t),
        );
      }
      break;
    }
    case "read-pr-guide":
      label = phrase(
        "Read {object}",
        "Tried to read {object}",
        quantity(selected.length, "{count} review guide", "{count} review guides", t),
      );
      break;
    case "list-issues":
      label = phrase("Listed", "list", `issues ${times}`);
      break;
    case "read-issue":
      label = phrase("Read {object}", "Tried to read {object}", issueQuantity(selected.length, t));
      break;
    case "create-issue":
      label = phrase("Filed {object}", "Tried to file {object}", issueQuantity(selected.length, t));
      break;
    case "comment-issue":
      label = phrase(
        "Commented on {object}",
        "Tried to comment on {object}",
        issueQuantity(selected.length, t),
      );
      break;
    case "set-issue-state":
      label = phrase(
        "Changed {object}",
        "Tried to change {object}",
        t("the state of {issues}", { issues: issueQuantity(selected.length, t) }),
      );
      break;
    case "link-issue":
      label = phrase(
        "Linked {object}",
        "Tried to link {object}",
        issueQuantity(selected.length, t),
      );
      break;
    case "unlink-issue":
      label = phrase(
        "Unlinked {object}",
        "Tried to unlink {object}",
        issueQuantity(selected.length, t),
      );
      break;
    case "list-thread-issues":
      label = phrase(
        "Checked",
        "check",
        `linked issues${selected.length === 1 ? "" : ` ${times}`}`,
      );
      break;
    case "browser":
      label = phrase("Used", "use", `browser ${times}`);
      break;
    case "device":
      label = phrase(
        "Used {object}",
        "Tried to use {object}",
        t("device controls {times}", { times }),
      );
      break;
    case "html-preview":
      label = phrase(
        "Previewed {object}",
        "Tried to preview {object}",
        quantity(selected.length, "{count} HTML page", "{count} HTML pages", t),
      );
      break;
    case "html-render":
      label = phrase(
        "Rendered {object}",
        "Tried to render {object}",
        quantity(selected.length, "{count} HTML page", "{count} HTML pages", t),
      );
      break;
    case "send-to-user":
      label = phrase(
        "Sent {object}",
        "Tried to send {object}",
        quantity(selected.length, "{count} message", "{count} messages", t),
      );
      break;
    case "capabilities":
      label = phrase(
        "Checked {object}",
        "Tried to check {object}",
        t("orchestration capabilities {times}", { times }),
      );
      break;
  }
  return { label, failedCount };
}
