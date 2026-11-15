import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { visibleOutputRows } from "@t3tools/client-runtime/outputs/display";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";

import { AppBar } from "../../components/ui/AppBar";
import { AppText as Text } from "../../components/ui/AppText";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListSection } from "../../components/ui/ListSection";
import { ScreenContent } from "../../components/ui/ScreenContent";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { useT } from "../../hooks/useT";
import { useSelectedThreadWorktree } from "../../state/use-selected-thread-worktree";
import { useThreadOutputs } from "../../state/outputs";
import { OutputFileRow, OutputLinkRow } from "./OutputRows";
import { useOutputActions } from "./useOutputActions";

type ThreadOutputsRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

function ShowMoreRow(props: { readonly count: number; readonly onPress: () => void }) {
  const t = useT();
  return (
    <Pressable
      accessibilityRole="button"
      onPress={props.onPress}
      className="min-h-11 justify-center px-3 active:bg-subtle"
    >
      <Text textRole="label" className="text-foreground-muted">
        {t("Show {count} more", { count: props.count })}
      </Text>
    </Pressable>
  );
}

/** Every file and link the conversation's finished runs produced, newest first. */
export function ThreadOutputsRouteScreen(props: ThreadOutputsRouteScreenProps) {
  const t = useT();
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(props.route.params.environmentId);
  const threadId = ThreadId.make(props.route.params.threadId);
  const { selectedThreadCwd } = useSelectedThreadWorktree();
  const outputs = useThreadOutputs(scopeThreadRef(environmentId, threadId), selectedThreadCwd);
  const actions = useOutputActions({ environmentId, threadId, workspaceRoot: selectedThreadCwd });
  const [filesExpanded, setFilesExpanded] = useState(false);
  const [linksExpanded, setLinksExpanded] = useState(false);
  const files = visibleOutputRows(outputs.files, filesExpanded);
  const links = visibleOutputRows(outputs.links, linksExpanded);

  return (
    <View className="flex-1">
      <AppBar
        title={t("Outputs")}
        onBack={() => {
          if (navigation.canGoBack()) navigation.goBack();
        }}
        hideBottomBorder
      />
      <ScreenContent>
        {outputs.files.length + outputs.links.length === 0 ? (
          <EmptyState
            title={t("No outputs yet")}
            detail={t("Files and links from finished replies show up here.")}
          />
        ) : (
          <ScreenScrollView contentContainerClassName="gap-5 px-4 py-4">
            {outputs.files.length > 0 ? (
              <ListSection title={`${t("Files")} · ${outputs.files.length}`}>
                {files.visible.map((file) => (
                  <OutputFileRow
                    key={file.path}
                    file={file}
                    workspaceRoot={selectedThreadCwd}
                    actions={actions.fileActions(file)}
                  />
                ))}
                {files.hiddenCount > 0 ? (
                  <ShowMoreRow count={files.hiddenCount} onPress={() => setFilesExpanded(true)} />
                ) : null}
              </ListSection>
            ) : null}
            {outputs.links.length > 0 ? (
              <ListSection title={`${t("Links")} · ${outputs.links.length}`}>
                {links.visible.map((link) => (
                  <OutputLinkRow key={link.url} link={link} actions={actions.linkActions(link)} />
                ))}
                {links.hiddenCount > 0 ? (
                  <ShowMoreRow count={links.hiddenCount} onPress={() => setLinksExpanded(true)} />
                ) : null}
              </ListSection>
            ) : null}
          </ScreenScrollView>
        )}
      </ScreenContent>
    </View>
  );
}
