import { AppBar } from "../../components/ui/AppBar";
import type { AppBarAction, AppBarMenu } from "../../components/ui/AppBar.types";
import {
  useAdaptiveWorkspaceLayout,
  useWorkspacePaneState,
} from "../layout/AdaptiveWorkspaceLayout";
import type { ThreadInspectorMode } from "./thread-inspector-navigation";
import { useWorkspaceBackNavigation } from "../layout/workspace/useAndroidWorkspaceNavigation";
import {
  threadTerminalMenu,
  useThreadGitMenuDefinition,
  type ThreadGitControlsProps,
} from "./ThreadGitControls";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { useT } from "../../hooks/useT";
import { useThreadOutputs } from "../../state/outputs"; // fork: outputs

export function ThreadHeader(props: {
  readonly title: string;
  readonly subtitle: string;
  readonly gitControls: ThreadGitControlsProps;
  readonly onReturnToThread?: () => void;
  readonly draft?: boolean;
  readonly hasThreadCwd: boolean;
  readonly inspectorMode: ThreadInspectorMode | null;
  readonly onOpenFilesInspector: () => void;
  // fork: opens the browser's new tab panel; absent when the host has no server browser.
  readonly onOpenNewBrowserTab?: () => void;
  // fork: outputs. The thread whose files and links the Outputs button lists.
  readonly outputs?: {
    readonly threadRef: ScopedThreadRef;
    readonly cwd: string | null;
    readonly onOpen: () => void;
  };
}) {
  const t = useT();
  const outputs = useThreadOutputs(props.outputs?.threadRef ?? null, props.outputs?.cwd);
  const outputsCount = outputs.filesTotal + outputs.linksTotal;
  const goBack = useWorkspaceBackNavigation();
  const { toggleAuxiliaryPane, startNewTask } = useAdaptiveWorkspaceLayout();
  const { panes } = useWorkspacePaneState();
  const gitMenu = useThreadGitMenuDefinition(props.gitControls);
  const terminalMenu = threadTerminalMenu(props.gitControls, t);
  const filesVisible = props.inspectorMode === "files" && panes.auxiliaryPaneVisible;
  const actions: AppBarAction[] = props.hasThreadCwd
    ? [
        {
          accessibilityLabel: filesVisible ? "Close files" : "Open files",
          icon: "folder",
          selected: filesVisible,
          disabled: !props.gitControls.canOpenFiles,
          separateBackground: false,
          onPress: filesVisible ? toggleAuxiliaryPane : props.onOpenFilesInspector,
        },
      ]
    : [];
  // fork: opens the browser's new tab panel; absent when the host has no server browser.
  if (props.onOpenNewBrowserTab) {
    actions.push({
      accessibilityLabel: t("New browser tab"),
      icon: "globe",
      onPress: props.onOpenNewBrowserTab,
    });
  }
  // fork: outputs. Hidden until a finished run has produced something.
  if (props.outputs && outputsCount > 0) {
    actions.push({
      accessibilityLabel: t("Outputs, {count}", { count: outputsCount }),
      icon: "doc.text",
      onPress: props.outputs.onOpen,
    });
  }
  const menus = [gitMenu, terminalMenu].filter((menu): menu is AppBarMenu => menu !== null);

  return (
    <AppBar
      title={props.title}
      subtitle={props.subtitle}
      onBackToList={goBack}
      onCompose={props.draft ? undefined : startNewTask}
      backInSplitView={
        props.onReturnToThread
          ? {
              accessibilityLabel: "Return to chat",
              icon: "chevron.left",
              onPress: props.onReturnToThread,
            }
          : undefined
      }
      actions={actions}
      menus={menus}
      hideBottomBorder
    />
  );
}
