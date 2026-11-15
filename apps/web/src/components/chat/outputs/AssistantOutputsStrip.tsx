import type { RunId } from "@t3tools/contracts";
import { memo, use, useState } from "react";

import { useT } from "~/hooks/useT";
import { useRunOutputs } from "~/state/outputs";
import { Button } from "../../ui/button";
import { TimelineRowCtx } from "../timelineRowContext";
import { OutputFileRow, OutputLinkRow } from "./OutputRows";
import { visibleOutputRows } from "@t3tools/client-runtime/outputs/display";
import { useOutputActions } from "./useOutputActions";

/**
 * Under a finished reply: the files it links to or the run wrote, and the addresses it printed.
 * The run's outputs exist only after the run ends, so a reply still streaming shows nothing.
 */
export const AssistantOutputsStrip = memo(function AssistantOutputsStrip(props: {
  runId: RunId | null;
}) {
  const ctx = use(TimelineRowCtx);
  const t = useT();
  const outputs = useRunOutputs(ctx.threadRef, ctx.workspaceRoot, props.runId);
  const actions = useOutputActions({ threadRef: ctx.threadRef, workspaceRoot: ctx.workspaceRoot });
  const [expanded, setExpanded] = useState(false);

  const total = outputs.files.length + outputs.links.length;
  if (total === 0) return null;

  // One short list: files first, then links, cut together.
  const rows = [
    ...outputs.files.map((file) => ({ kind: "file" as const, key: `f:${file.path}`, file })),
    ...outputs.links.map((link) => ({ kind: "link" as const, key: `l:${link.url}`, link })),
  ];
  const { visible, hiddenCount } = visibleOutputRows(rows, expanded);

  return (
    <div
      className="mt-4 rounded-lg bg-secondary px-1 pb-1 dark:bg-input/20"
      data-assistant-outputs=""
    >
      <div className="px-2 py-2 text-xs font-medium text-foreground">
        {t("Outputs")} <span className="text-muted-foreground">{total}</span>
      </div>
      {visible.map((row) =>
        row.kind === "file" ? (
          <OutputFileRow
            key={row.key}
            file={row.file}
            workspaceRoot={ctx.workspaceRoot}
            resolvedTheme={ctx.resolvedTheme}
            actions={actions}
          />
        ) : (
          <OutputLinkRow key={row.key} link={row.link} actions={actions} />
        ),
      )}
      {hiddenCount > 0 ? (
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          data-scroll-anchor-ignore
          onClick={() => setExpanded(true)}
        >
          {t("Show {count} more", { count: hiddenCount })}
        </Button>
      ) : null}
    </div>
  );
});
