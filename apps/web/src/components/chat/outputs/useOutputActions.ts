import { useAtomValue } from "@effect/atom-react";
import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";
import type { OutputFile, OutputLink } from "@t3tools/client-runtime/outputs/run";

import { canOpenLinksInApp } from "~/browser/browserLinkTarget";
import { openUrlInPreview } from "~/browser/openFileInPreview";
import { isElectron } from "~/env";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useT } from "~/hooks/useT";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { hostEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { previewEnvironment } from "~/state/preview";
import { serverEnvironment } from "~/state/server";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "../../preview/fileExplorerLabel";
import { toastManager } from "../../ui/toast";
import { workspacePreviewPath } from "./outputs.logic";

type OutputFileAction = "preview" | "open" | "reveal" | "copy";
type OutputLinkAction = "preview" | "external" | "copy";

export function useOutputActions(input: {
  readonly threadRef: ScopedThreadRef | null;
  readonly workspaceRoot: string | undefined;
}) {
  const { threadRef, workspaceRoot } = input;
  const t = useT();
  const environmentId = threadRef?.environmentId ?? null;
  const hostEnvironmentId = useAtomValue(hostEnvironmentIdAtom);
  const serverConfig = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const openInEditor = useAtomCommand(shellEnvironment.openInEditor, { reportFailure: false });
  const openPreview = useAtomCommand(previewEnvironment.open, { reportFailure: false });

  // Open and reveal act on the machine the server runs on, so only the desktop app's own server
  // is the user's machine. A remote server's file manager would open on a computer they cannot see.
  const onThisMachine = isElectron && environmentId !== null && environmentId === hostEnvironmentId;
  const hasFileManager = serverConfig?.availableEditors.includes("file-manager") === true;
  const revealLabel =
    onThisMachine && hasFileManager && serverConfig?.shellRevealInFileManager === true
      ? serverConfig.shellRevealInFileManagerKind === undefined
        ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
        : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
      : undefined;
  const canOpenDefault = onThisMachine && hasFileManager;
  const canPreviewLinks = canOpenLinksInApp(threadRef);

  const copy = (value: string, title: string) => {
    void writeTextToClipboard(value).then(
      (didCopy) => {
        if (didCopy) toastManager.add({ type: "success", title, timeout: 1500 });
      },
      (error: unknown) => {
        toastManager.add({
          type: "error",
          title: t("Failed to copy"),
          description: error instanceof Error ? error.message : undefined,
        });
      },
    );
  };

  const launch = async (path: string, reveal: boolean) => {
    if (environmentId === null) return;
    const result = await openInEditor({
      environmentId,
      input: { cwd: path, editor: "file-manager", ...(reveal ? { reveal: true } : {}) },
    });
    if (result._tag !== "Failure") return;
    toastManager.add({
      type: "error",
      title: reveal ? t("Unable to reveal file") : t("Could not open file"),
      description: path,
    });
  };

  const previewPathOf = (file: OutputFile) => workspacePreviewPath(file.path, workspaceRoot);

  const fileMenuItems = (file: OutputFile): ContextMenuItem<OutputFileAction>[] => {
    const items: ContextMenuItem<OutputFileAction>[] = [];
    if (previewPathOf(file) !== null) {
      items.push({ id: "preview", label: t("Preview in side panel") });
    }
    if (canOpenDefault) items.push({ id: "open", label: t("Open with default app") });
    if (revealLabel !== undefined) items.push({ id: "reveal", label: t(revealLabel) });
    items.push({ id: "copy", label: t("Copy path") });
    return items;
  };

  const linkMenuItems = (): ContextMenuItem<OutputLinkAction>[] => {
    const items: ContextMenuItem<OutputLinkAction>[] = [];
    if (canPreviewLinks) items.push({ id: "preview", label: t("Preview in browser panel") });
    items.push({ id: "external", label: t("Open in external browser") });
    items.push({ id: "copy", label: t("Copy link") });
    return items;
  };

  const runFileAction = (action: OutputFileAction, file: OutputFile) => {
    switch (action) {
      case "preview": {
        const relative = previewPathOf(file);
        if (threadRef !== null && relative !== null) {
          useRightPanelStore.getState().openFile(threadRef, relative, file.line);
        }
        return;
      }
      case "open":
        void launch(file.path, false);
        return;
      case "reveal":
        void launch(file.path, true);
        return;
      case "copy":
        copy(file.path, t("Path copied"));
        return;
    }
  };

  const runLinkAction = (action: OutputLinkAction, link: OutputLink) => {
    switch (action) {
      case "preview": {
        if (threadRef === null) return;
        void openUrlInPreview({ threadRef, url: link.url, openPreview }).then((result) => {
          if (result._tag !== "Failure") return;
          toastManager.add({
            type: "error",
            title: t("Could not open the link"),
            description: link.url,
          });
        });
        return;
      }
      case "external":
        void readLocalApi()?.shell.openExternal(link.url);
        return;
      case "copy":
        copy(link.url, t("Link copied"));
        return;
    }
  };

  /** What a click does: the first menu entry, so the row and its menu never disagree. */
  const primaryFileAction = (file: OutputFile): OutputFileAction | null =>
    fileMenuItems(file).find((item) => item.id !== "copy")?.id ?? null;
  const primaryLinkAction = (): OutputLinkAction => (canPreviewLinks ? "preview" : "external");

  const showMenu = async <T extends string>(
    items: readonly ContextMenuItem<T>[],
    position: { x: number; y: number },
  ): Promise<T | null> => {
    const api = readLocalApi();
    if (api === undefined || items.length === 0) return null;
    return api.contextMenu.show(items, position);
  };

  const showFileMenu = async (file: OutputFile, position: { x: number; y: number }) => {
    const action = await showMenu(fileMenuItems(file), position);
    if (action !== null) runFileAction(action, file);
  };

  const showLinkMenu = async (link: OutputLink, position: { x: number; y: number }) => {
    const action = await showMenu(linkMenuItems(), position);
    if (action !== null) runLinkAction(action, link);
  };

  return {
    primaryFileAction,
    primaryLinkAction,
    runFileAction,
    runLinkAction,
    showFileMenu,
    showLinkMenu,
  };
}
