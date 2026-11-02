// fork: the project and worktree headers of the thread list's project view.
import { memo } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { SymbolView } from "../components/ui/AppSymbol";
import { cn } from "../lib/cn";
import { useT } from "../hooks/useT";
import type { ThreadListV2GroupHeaderListItem } from "../features/threads/threadListV2";

export const ThreadListV2GroupHeader = memo(function ThreadListV2GroupHeader(props: {
  readonly item: ThreadListV2GroupHeaderListItem;
  readonly pane?: "screen" | "sidebar";
  readonly onToggle: (collapseKey: string) => void;
}) {
  const t = useT();
  const { item } = props;
  const sidebarPane = props.pane === "sidebar";
  const project = item.level === "project";
  const accessibilityLabel =
    item.count === 1
      ? t("{name}, 1 thread", { name: item.title })
      : t("{name}, {count} threads", { name: item.title, count: item.count });
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint={item.collapsed ? t("Expands this group.") : t("Collapses this group.")}
      accessibilityState={{ expanded: !item.collapsed }}
      onPress={() => props.onToggle(item.collapseKey)}
      className={cn(
        "flex-row items-center gap-2",
        project ? "mb-1 mt-4" : "mb-0.5 mt-1.5",
        sidebarPane ? "px-3" : "px-5",
        !project && "pl-7",
      )}
      style={({ pressed }) => ({ opacity: pressed ? 0.6 : 1 })}
    >
      <SymbolView
        name={project ? "folder" : "arrow.triangle.branch"}
        size={project ? 14 : 12}
        tintColorClassName={
          sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
        }
        type="monochrome"
      />
      <Text
        numberOfLines={1}
        className={cn(
          "shrink font-t3-medium",
          project ? "text-sm" : "text-xs",
          sidebarPane
            ? project
              ? "text-drawer-foreground"
              : "text-drawer-foreground-muted"
            : project
              ? "text-foreground"
              : "text-foreground-tertiary",
        )}
      >
        {item.title}
      </Text>
      {item.badge ? (
        <View
          className={cn(
            "rounded border px-1",
            sidebarPane ? "border-drawer-border" : "border-border",
          )}
        >
          <Text
            className={cn(
              "text-[10px]",
              sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted",
            )}
          >
            {item.badge}
          </Text>
        </View>
      ) : null}
      <View className="flex-1" />
      <Text
        className={cn(
          "text-xs tabular-nums",
          sidebarPane ? "text-drawer-foreground-muted" : "text-foreground-muted",
        )}
      >
        {item.count}
      </Text>
      <SymbolView
        name="chevron.down"
        size={10}
        tintColorClassName={
          sidebarPane ? "accent-drawer-foreground-muted" : "accent-foreground-muted"
        }
        type="monochrome"
        style={{ transform: [{ rotate: item.collapsed ? "-90deg" : "0deg" }] }}
      />
    </Pressable>
  );
});
