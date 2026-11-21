import { useMessages } from "gt-react-native";
import { useNavigation } from "@react-navigation/native";
import { workspacePreviewPath } from "@t3tools/client-runtime/outputs/display";
import type { OutputFile, OutputLink } from "@t3tools/client-runtime/outputs/run";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useT } from "../../hooks/useT";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { linkChoiceTitle } from "../browser/linkChoiceTitle"; // fork: link choices
import { linkChoicesTapFirst } from "../browser/linkChoices"; // fork: link choices
import { useBuiltInBrowserLink } from "../browser/useBuiltInBrowserLink"; // fork: link choices
import { fileRoutePathSegments } from "../files/filePath";

export interface OutputAction {
  readonly id: string;
  readonly title: string;
  readonly run: () => void;
}

/**
 * What a row can do. A file is previewed only inside the thread's workspace, because the server
 * reads nothing else; one elsewhere (such as /tmp) can still be copied by path.
 */
export function useOutputActions(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly workspaceRoot: string | null | undefined;
}) {
  const t = useT();
  const m = useMessages();
  const navigation = useNavigation();
  const builtInBrowser = useBuiltInBrowserLink(input); // fork: a loopback link opens in the host's browser

  const fileActions = (file: OutputFile): OutputAction[] => {
    const actions: OutputAction[] = [];
    const relative = workspacePreviewPath(file.path, input.workspaceRoot ?? undefined);
    if (relative !== null) {
      actions.push({
        id: "preview",
        title: t("Preview file"),
        run: () =>
          navigation.navigate("ThreadFile", {
            environmentId: String(input.environmentId),
            threadId: String(input.threadId),
            path: fileRoutePathSegments(relative),
            ...(file.line === undefined ? {} : { line: String(file.line) }),
          }),
      });
    }
    actions.push({
      id: "copy",
      title: t("Copy path"),
      run: () => void tryCopyTextWithHaptic(file.path, { target: "output path" }),
    });
    return actions;
  };

  // A tap runs the first action, so a loopback link leads with the built-in browser.
  const linkActions = (link: OutputLink): OutputAction[] =>
    linkChoicesTapFirst(link.url, builtInBrowser.available).map((choice) => ({
      id: choice === "copy" ? "copy" : `open-${choice}`,
      title: linkChoiceTitle(choice, m),
      run: () => {
        if (choice === "built-in") void builtInBrowser.openLink(link.url);
        else if (choice === "system") void tryOpenExternalUrl(link.url, "markdown-link");
        else void tryCopyTextWithHaptic(link.url, { target: "output link" });
      },
    }));

  return { fileActions, linkActions };
}
