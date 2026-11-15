import { visibleOutputRows } from "@t3tools/client-runtime/outputs/display";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId, RunId, ThreadId } from "@t3tools/contracts";
import { memo, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { useT } from "../../hooks/useT";
import { useRunOutputs } from "../../state/outputs";
import { OutputFileRow, OutputLinkRow } from "./OutputRows";
import { useOutputActions } from "./useOutputActions";

/**
 * Under a finished reply: the files and links its run produced. A run's outputs exist only once it
 * ends, so a reply still streaming shows nothing.
 */
export const MessageOutputsStrip = memo(function MessageOutputsStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly runId: RunId | null | undefined;
  readonly workspaceRoot: string | null | undefined;
}) {
  const t = useT();
  const outputs = useRunOutputs(
    scopeThreadRef(props.environmentId, props.threadId),
    props.workspaceRoot,
    props.runId,
  );
  const actions = useOutputActions(props);
  const [expanded, setExpanded] = useState(false);

  const total = outputs.files.length + outputs.links.length;
  if (total === 0) return null;

  const rows = [
    ...outputs.files.map((file) => ({ kind: "file" as const, key: `f:${file.path}`, file })),
    ...outputs.links.map((link) => ({ kind: "link" as const, key: `l:${link.url}`, link })),
  ];
  const { visible, hiddenCount } = visibleOutputRows(rows, expanded);

  return (
    <View className="mt-3 overflow-hidden rounded-xl bg-subtle">
      <Text textRole="label" className="px-3 pt-2 font-t3-medium">
        {t("Outputs")}{" "}
        <Text textRole="label" className="text-foreground-muted">
          {total}
        </Text>
      </Text>
      {visible.map((row) =>
        row.kind === "file" ? (
          <OutputFileRow
            key={row.key}
            file={row.file}
            workspaceRoot={props.workspaceRoot}
            actions={actions.fileActions(row.file)}
          />
        ) : (
          <OutputLinkRow key={row.key} link={row.link} actions={actions.linkActions(row.link)} />
        ),
      )}
      {hiddenCount > 0 ? (
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded(true)}
          className="min-h-11 justify-center px-3 active:bg-subtle"
        >
          <Text textRole="label" className="text-foreground-muted">
            {t("Show {count} more", { count: hiddenCount })}
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
});
