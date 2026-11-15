import { outputFileDisplay, outputLinkDisplay } from "@t3tools/client-runtime/outputs/display";
import type { OutputFile, OutputLink } from "@t3tools/client-runtime/outputs/run";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Menu } from "../../components/ui/Menu";
import type { OutputAction } from "./useOutputActions";

function OutputRow(props: {
  readonly icon: "doc.text" | "globe";
  readonly primary: string;
  readonly secondary: string;
  readonly accessibilityLabel: string;
  readonly actions: ReadonlyArray<OutputAction>;
}) {
  // A tap does the first action unless that is only a copy; then it offers the menu instead.
  const tapAction = props.actions.find((action) => action.id !== "copy");
  const row = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.accessibilityLabel}
      onPress={tapAction?.run}
      className="min-h-11 flex-row items-center gap-2 px-3 py-2 active:bg-subtle"
    >
      <SymbolView name={props.icon} size={16} tintColorClassName="accent-foreground-muted" />
      <View className="min-w-0 flex-1 flex-row items-baseline gap-2">
        <Text textRole="label" className="shrink-0 font-t3-medium" numberOfLines={1}>
          {props.primary}
        </Text>
        {props.secondary === "" ? null : (
          <Text
            textRole="label"
            className="min-w-0 shrink text-foreground-muted"
            numberOfLines={1}
            ellipsizeMode="middle"
          >
            {props.secondary}
          </Text>
        )}
      </View>
    </Pressable>
  );
  return (
    <Menu
      shouldOpenOnLongPress={tapAction !== undefined}
      actions={props.actions.map(({ id, title }) => ({ id, title }))}
      onPressAction={({ nativeEvent }) => {
        props.actions.find((action) => action.id === nativeEvent.event)?.run();
      }}
    >
      {row}
    </Menu>
  );
}

export function OutputFileRow(props: {
  readonly file: OutputFile;
  readonly workspaceRoot: string | null | undefined;
  readonly actions: ReadonlyArray<OutputAction>;
}) {
  const { name, directory } = outputFileDisplay(props.file.path, props.workspaceRoot ?? undefined);
  return (
    <OutputRow
      icon="doc.text"
      primary={name}
      secondary={directory}
      accessibilityLabel={directory === "" ? name : `${name}, ${directory}`}
      actions={props.actions}
    />
  );
}

export function OutputLinkRow(props: {
  readonly link: OutputLink;
  readonly actions: ReadonlyArray<OutputAction>;
}) {
  const { host, path } = outputLinkDisplay(props.link.url);
  return (
    <OutputRow
      icon="globe"
      primary={host}
      secondary={path}
      accessibilityLabel={props.link.url}
      actions={props.actions}
    />
  );
}
