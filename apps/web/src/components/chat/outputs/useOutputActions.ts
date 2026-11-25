import { useAtomValue } from "@effect/atom-react";
import type { ContextMenuItem, ScopedThreadRef } from "@t3tools/contracts";
import type { OutputFile, OutputLink } from "@t3tools/client-runtime/outputs/run";

import { canOpenLinksInApp } from "~/browser/browserLinkTarget";
import {
  isBrowserPreviewFile,
  openFileInSystemBrowser,
  openUrlInPreview,
} from "~/browser/openFileInPreview";
import { isElectron } from "~/env";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { useT } from "~/hooks/useT";
import { readLocalApi } from "~/localApi";
import { useRightPanelStore } from "~/rightPanelStore";
import { hostEnvironmentIdAtom } from "~/state/primaryEnvironment";
import { assetEnvironment } from "~/state/assets";
import { previewEnvironment } from "~/state/preview";
import { readPreparedConnection } from "~/state/session";
import { useAtomQueryRunner } from "~/state/use-atom-query-runner";
import { serverEnvironment } from "~/state/server";
import { shellEnvironment } from "~/state/shell";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  revealInFileExplorerLabelForKind,
  revealInFileExplorerLabelForOs,
} from "../../preview/fileExplorerLabel";
import { toastManager } from "../../ui/toast";
import { workspacePreviewPath } from "@t3tools/client-runtime/outputs/display";

import {
  isUsersOwnMachine,
  outputFileActionIds,
  outputLinkActionIds,
  primaryOutputAction,
  type OutputFileActionId as OutputFileAction,
  type OutputLinkActionId as OutputLinkAction,
} from "./outputActions.logic";

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
  const createAssetUrl = useAtomQueryRunner(assetEnvironment.createUrl, {
    reportFailure: false,
    refresh: true,
  });

  const onThisMachine = isUsersOwnMachine({ isElectron, environmentId, hostEnvironmentId });
  const hasFileManager = serverConfig?.availableEditors.includes("file-manager") === true;
  const revealLabel =
    serverConfig?.shellRevealInFileManager === true
      ? serverConfig.shellRevealInFileManagerKind === undefined
        ? revealInFileExplorerLabelForOs(serverConfig.environment.platform.os)
        : revealInFileExplorerLabelForKind(serverConfig.shellRevealInFileManagerKind)
      : undefined;
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

  const fileActionIds = (file: OutputFile) =>
    outputFileActionIds({
      inWorkspace: previewPathOf(file) !== null,
      canOpenInSystemBrowser: isElectron && threadRef !== null && isBrowserPreviewFile(file.path),
      onThisMachine,
      hasFileManager,
      canReveal: revealLabel !== undefined,
    });
  const linkActionIds = () => outputLinkActionIds({ canPreviewLinks });

  const fileActionLabel = (id: OutputFileAction): string => {
    switch (id) {
      case "preview":
        return t("Preview in side panel");
      case "browser":
        return t("Open in default browser");
      case "open":
        return t("Open with default app");
      case "reveal":
        return t(revealLabel ?? "Reveal in Files");
      case "copy":
        return t("Copy path");
    }
  };
  const linkActionLabel = (id: OutputLinkAction): string => {
    switch (id) {
      case "preview":
        return t("Preview in browser panel");
      case "external":
        return t("Open in external browser");
      case "copy":
        return t("Copy link");
    }
  };
  const fileMenuItems = (file: OutputFile): ContextMenuItem<OutputFileAction>[] =>
    fileActionIds(file).map((id) => ({ id, label: fileActionLabel(id) }));
  const linkMenuItems = (): ContextMenuItem<OutputLinkAction>[] =>
    linkActionIds().map((id) => ({ id, label: linkActionLabel(id) }));

  const openInSystemBrowser = async (file: OutputFile) => {
    const httpBaseUrl =
      threadRef === null ? undefined : readPreparedConnection(threadRef.environmentId)?.httpBaseUrl;
    const result =
      threadRef === null || httpBaseUrl === undefined
        ? null
        : await openFileInSystemBrowser({
            threadRef,
            filePath: file.path,
            workspaceRoot,
            httpBaseUrl,
            createAssetUrl,
          });
    if (result !== null && result._tag !== "Failure") return;
    toastManager.add({
      type: "error",
      title: t("Could not open file"),
      description: file.path,
    });
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
      case "browser":
        void openInSystemBrowser(file);
        return;
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

  const primaryFileAction = (file: OutputFile): OutputFileAction | null =>
    primaryOutputAction(fileActionIds(file));
  const primaryLinkAction = (): OutputLinkAction => primaryOutputAction(linkActionIds()) ?? "copy";

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
