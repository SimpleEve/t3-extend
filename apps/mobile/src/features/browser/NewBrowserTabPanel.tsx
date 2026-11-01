import { DEFAULT_SERVER_SETTINGS, type EnvironmentId, type ThreadId } from "@t3tools/contracts";
import { resolveProjectScripts } from "@t3tools/shared/projectScripts";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListSection } from "../../components/ui/ListSection";
import { Notice } from "../../components/ui/Notice";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useT } from "../../hooks/useT";
import { useProject, useThreadShell } from "../../state/entities";
import { previewEnvironment, useDiscoveredLocalServers } from "../../state/preview";
import { useRemoteEnvironmentRuntime } from "../../state/use-remote-environment-registry";
import { useAtomCommand } from "../../state/use-atom-command";
import {
  localServerRows,
  projectPreviewTargets,
  resolveBrowserAddress,
  type BrowserAddress,
} from "./newBrowserTab";

const ADDRESS_ERRORS = {
  empty: "Enter an address.",
  invalid: "Enter a URL such as localhost:5173 or example.com.",
  unsupported: "Only http and https addresses open in the browser.",
} as const satisfies Record<Extract<BrowserAddress, { ok: false }>["reason"], string>;

/** Opens a tab in the host's browser; `localhost` is the host, not this phone. */
export function NewBrowserTabPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly canOpen: boolean;
  readonly onOpened: (tabId: string) => void;
}) {
  const t = useT();
  const { environmentId, threadId } = props;
  const open = useAtomCommand(previewEnvironment.open, "browser tab open");
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const thread = useThreadShell({ environmentId, threadId });
  const project = useProject(thread ? { environmentId, projectId: thread.projectId } : null);
  const settings =
    useRemoteEnvironmentRuntime(environmentId)?.serverConfig?.settings ?? DEFAULT_SERVER_SETTINGS;
  const targets = project ? projectPreviewTargets(resolveProjectScripts(settings, project)) : [];
  const discovered = useDiscoveredLocalServers(
    environmentId,
    targets.map((target) => target.url),
  );
  const servers = localServerRows(discovered, targets);

  const openUrl = async (url: string) => {
    if (opening || !props.canOpen) return;
    setOpening(true);
    const result = await open({ environmentId, input: { threadId, url, runtime: "server" } });
    setOpening(false);
    if (result._tag === "Success") {
      props.onOpened(result.value.tabId);
      return;
    }
    Dialog.alert(t("Could not open a browser tab"));
  };
  const submit = () => {
    const address = resolveBrowserAddress(draft);
    if (!address.ok) {
      setError(t(ADDRESS_ERRORS[address.reason]));
      return;
    }
    setError(null);
    void openUrl(address.url);
  };

  return (
    <ScreenScrollView
      keyboardShouldPersistTaps="handled"
      contentContainerClassName="gap-6 px-4 pb-8 pt-2"
    >
      {props.canOpen ? null : (
        <Notice
          icon={{ ios: "lock", android: "lock" }}
          message={t("This connection can view browser tabs but not open them.")}
        />
      )}
      <View className="gap-2">
        <TextInput
          accessibilityLabel={t("Address")}
          editable={props.canOpen && !opening}
          value={draft}
          onChangeText={(next) => {
            setDraft(next);
            setError(null);
          }}
          onSubmitEditing={submit}
          placeholder={t("localhost:5173 or example.com")}
          placeholderTextColorClassName="accent-placeholder"
          autoCapitalize="none"
          autoCorrect={false}
          autoFocus={props.canOpen}
          keyboardType="url"
          returnKeyType="go"
          className="h-11 rounded-full border border-input-border bg-input px-4 font-sans text-sm text-foreground"
        />
        {error ? (
          <AppText textRole="footnote" className="px-4 text-danger-foreground">
            {error}
          </AppText>
        ) : null}
        <Button
          label={t("Open")}
          tone="primary"
          fullWidth
          loading={opening}
          disabled={!props.canOpen || draft.trim().length === 0}
          onPress={submit}
        />
      </View>
      <ListSection
        title={t("Local servers on the host")}
        footer={t("Pages open in the host's browser, so localhost means the host, not this phone.")}
      >
        {servers.length === 0 ? (
          <View className="px-4 py-4">
            <AppText textRole="footnote" className="text-foreground-muted">
              {discovered === null
                ? t("Looking for local servers…")
                : t("No local servers found. Start a dev server on the host to see it here.")}
            </AppText>
          </View>
        ) : (
          servers.map((server) => (
            <ListActionRow
              key={server.key}
              icon="globe"
              label={server.scriptName ?? server.processName ?? t("Listening")}
              description={`${server.host}:${server.port}`}
              disabled={!props.canOpen || opening}
              onPress={() => void openUrl(server.url)}
            />
          ))
        )}
      </ListSection>
    </ScreenScrollView>
  );
}
