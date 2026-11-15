import type { OutputFile, OutputLink } from "@t3tools/client-runtime/outputs/run";
import { EllipsisIcon, GlobeIcon } from "lucide-react";
import type { MouseEvent } from "react";

import { useT } from "~/hooks/useT";
import { Button } from "../../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { PierreEntryIcon } from "../PierreEntryIcon";
import { outputFileDisplay, outputLinkDisplay } from "./outputs.logic";
import type { useOutputActions } from "./useOutputActions";

type OutputActions = ReturnType<typeof useOutputActions>;

const ROW_CLASS_NAME =
  "group/output flex min-w-0 items-center gap-1 rounded-md pr-1 text-xs hover:bg-accent/50";
const ROW_BUTTON_CLASS_NAME =
  "flex min-w-0 flex-1 items-center gap-2 rounded-md px-2 py-1.5 text-left outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default";

function menuPosition(event: MouseEvent<HTMLElement>) {
  const rect = event.currentTarget.getBoundingClientRect();
  return { x: Math.round(rect.right), y: Math.round(rect.bottom) };
}

export function OutputFileRow(props: {
  file: OutputFile;
  workspaceRoot: string | undefined;
  resolvedTheme: "light" | "dark";
  actions: OutputActions;
}) {
  const { file, workspaceRoot, resolvedTheme, actions } = props;
  const t = useT();
  const { name, directory } = outputFileDisplay(file.path, workspaceRoot);
  const primary = actions.primaryFileAction(file);

  return (
    <div
      className={ROW_CLASS_NAME}
      data-output-kind="file"
      onContextMenu={(event) => {
        event.preventDefault();
        void actions.showFileMenu(file, { x: event.clientX, y: event.clientY });
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={ROW_BUTTON_CLASS_NAME}
              disabled={primary === null}
              onClick={() => {
                if (primary !== null) actions.runFileAction(primary, file);
              }}
            />
          }
        >
          <PierreEntryIcon pathValue={file.path} kind="file" theme={resolvedTheme} />
          <span className="shrink-0 font-medium text-foreground">{name}</span>
          {directory === "" ? null : (
            <span className="min-w-0 truncate text-muted-foreground">{directory}</span>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{file.path}</TooltipPopup>
      </Tooltip>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        aria-label={t("More actions for {name}", { name })}
        onClick={(event) => void actions.showFileMenu(file, menuPosition(event))}
      >
        <EllipsisIcon />
      </Button>
    </div>
  );
}

export function OutputLinkRow(props: { link: OutputLink; actions: OutputActions }) {
  const { link, actions } = props;
  const t = useT();
  const { host, path } = outputLinkDisplay(link.url);

  return (
    <div
      className={ROW_CLASS_NAME}
      data-output-kind="link"
      onContextMenu={(event) => {
        event.preventDefault();
        void actions.showLinkMenu(link, { x: event.clientX, y: event.clientY });
      }}
    >
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={ROW_BUTTON_CLASS_NAME}
              onClick={() => actions.runLinkAction(actions.primaryLinkAction(), link)}
            />
          }
        >
          <GlobeIcon className="size-4 shrink-0 text-icon-muted" aria-hidden />
          <span className="shrink-0 font-medium text-foreground">{host}</span>
          {path === "" ? null : (
            <span className="min-w-0 truncate text-muted-foreground">{path}</span>
          )}
        </TooltipTrigger>
        <TooltipPopup side="top">{link.url}</TooltipPopup>
      </Tooltip>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost-muted"
        aria-label={t("More actions for {name}", { name: host })}
        onClick={(event) => void actions.showLinkMenu(link, menuPosition(event))}
      >
        <EllipsisIcon />
      </Button>
    </div>
  );
}
