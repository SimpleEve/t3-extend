import type { ScopedThreadRef } from "@t3tools/contracts";
import { PackageIcon } from "lucide-react";
import { memo, useState } from "react";

import { useT } from "~/hooks/useT";
import { useThreadOutputs } from "~/state/outputs";
import { useTheme } from "~/hooks/useTheme";
import { Badge } from "../../ui/badge";
import { Button } from "../../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../../ui/popover";
import { OutputFileRow, OutputLinkRow } from "./OutputRows";
import { visibleOutputRows } from "./outputs.logic";
import { useOutputActions } from "./useOutputActions";

function ExpandableSection(props: { title: string; count: number; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-0.5" data-outputs-section="">
      <h3 className="px-2 pb-1 text-xs font-medium text-muted-foreground">
        {props.title} <span>{props.count}</span>
      </h3>
      {props.children}
    </section>
  );
}

function ThreadOutputsList(props: {
  threadRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
}) {
  const { threadRef, workspaceRoot } = props;
  const t = useT();
  const { resolvedTheme } = useTheme();
  const outputs = useThreadOutputs(threadRef, workspaceRoot);
  const actions = useOutputActions({ threadRef, workspaceRoot });
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [linksExpanded, setLinksExpanded] = useState(false);
  const files = visibleOutputRows(outputs.files, filesExpanded);
  const links = visibleOutputRows(outputs.links, linksExpanded);

  return (
    <div className="flex max-h-[min(32rem,70vh)] w-full flex-col gap-3 overflow-y-auto">
      {outputs.files.length > 0 ? (
        <ExpandableSection title={t("Files")} count={outputs.files.length}>
          {files.visible.map((file) => (
            <OutputFileRow
              key={file.path}
              file={file}
              workspaceRoot={workspaceRoot}
              resolvedTheme={resolvedTheme}
              actions={actions}
            />
          ))}
          {files.hiddenCount > 0 ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() => setFilesExpanded(true)}
            >
              {t("Show {count} more", { count: files.hiddenCount })}
            </Button>
          ) : null}
        </ExpandableSection>
      ) : null}
      {outputs.links.length > 0 ? (
        <ExpandableSection title={t("Links")} count={outputs.links.length}>
          {links.visible.map((link) => (
            <OutputLinkRow key={link.url} link={link} actions={actions} />
          ))}
          {links.hiddenCount > 0 ? (
            <Button
              type="button"
              size="xs"
              variant="ghost-muted"
              onClick={() => setLinksExpanded(true)}
            >
              {t("Show {count} more", { count: links.hiddenCount })}
            </Button>
          ) : null}
        </ExpandableSection>
      ) : null}
    </div>
  );
}

/**
 * Header button for the whole conversation's outputs. It is absent until the first run produces
 * something, and its popover reads the same lists as the strips, so a later run appears in it
 * without any refresh.
 */
export const ThreadOutputsButton = memo(function ThreadOutputsButton(props: {
  threadRef: ScopedThreadRef;
  workspaceRoot: string | undefined;
}) {
  const { threadRef, workspaceRoot } = props;
  const t = useT();
  const outputs = useThreadOutputs(threadRef, workspaceRoot);
  const count = outputs.files.length + outputs.links.length;
  if (count === 0) return null;

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-label={t("Outputs")}
            data-thread-outputs-button=""
          />
        }
      >
        <PackageIcon />
        <span className="hidden sm:inline">{t("Outputs")}</span>
        <Badge size="sm" variant="secondary">
          {count}
        </Badge>
      </PopoverTrigger>
      <PopoverPopup align="end" width="md" padding="compact">
        <ThreadOutputsList threadRef={threadRef} workspaceRoot={workspaceRoot} />
      </PopoverPopup>
    </Popover>
  );
});
