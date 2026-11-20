import { useNavigation } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import * as Dialog from "../../components/ui/Dialog";
import { useT } from "../../hooks/useT";
import { previewEnvironment, useCanOpenBrowserTab } from "../../state/preview";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";

/**
 * Opens a link in the thread's host browser, where `localhost` is the host and not this phone.
 * `available` is the condition that also shows "New browser tab": the host can run a server
 * browser and this connection may open tabs.
 */
export function useBuiltInBrowserLink(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const t = useT();
  const navigation = useNavigation();
  const open = useAtomCommand(previewEnvironment.open, "browser tab open");
  const serverBrowser =
    useRemoteEnvironmentRuntime(input.environmentId)?.serverConfig?.environment.capabilities
      .serverBrowser === true;
  const canOpen = useCanOpenBrowserTab(input.environmentId);
  const available = serverBrowser && canOpen;

  const openLink = async (url: string) => {
    const result = await open({
      environmentId: input.environmentId,
      input: { threadId: input.threadId, url, runtime: "server" },
    });
    if (result._tag !== "Success") {
      Dialog.alert(t("Could not open a browser tab"));
      return;
    }
    navigation.navigate("ThreadBrowserPreview", {
      environmentId: String(input.environmentId),
      threadId: String(input.threadId),
      tabId: result.value.tabId,
      opened: "1",
    });
  };
  return { available, openLink };
}
