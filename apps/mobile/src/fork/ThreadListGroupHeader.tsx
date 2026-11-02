// fork: the project and worktree headers of the thread list's project view.
import { memo } from "react";
import { Pressable, View, type ViewProps } from "react-native";

import { AppText as Text } from "../components/ui/AppText";
import { SymbolView } from "../components/ui/AppSymbol";
import { cn } from "../lib/cn";
import { useT } from "../hooks/useT";
import type { ThreadListV2GroupHeaderListItem } from "../features/threads/threadListV2";

const DOT_LABEL = {
  attention: ", needs you",
  failed: ", failed",
  unread: ", done",
  working: ", working",
} as const;

const DOT_CLASS_NAME = {
  attention: "bg-warning",
  failed: "bg-danger",
  unread: "bg-adaptive-emerald-600-400",
  working: "bg-adaptive-sky-600-400",
} as const;

// The header's icon is 12pt wide, so its center is 6pt in from the header's left padding.
const guideLineClassName = (sidebarPane: boolean) =>
  cn("absolute w-px", sidebarPane ? "bg-drawer-border" : "bg-border");
const guideX = (sidebarPane: boolean) => ({ left: sidebarPane ? 26 : 34 });

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
  const spokenLabel = item.dot
    ? `${accessibilityLabel}${t(DOT_LABEL[item.dot])}`
    : accessibilityLabel;
  const header = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={spokenLabel}
      accessibilityHint={item.collapsed ? t("Expands this group.") : t("Collapses this group.")}
      accessibilityState={{ expanded: !item.collapsed }}
      onPress={() => props.onToggle(item.collapseKey)}
      className={cn(
        "flex-row items-center gap-2",
        project ? "mb-1 mt-4" : "mb-0.5 mt-1.5",
        sidebarPane ? "px-3" : "px-5",
        // One level under the project: the icon sits 8px right of the project's, and the
        // rows below indent so their titles line up with this label.
        !project && (sidebarPane ? "pl-5" : "pl-7"),
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
      {item.dot ? <View className={cn("size-1.5 rounded-full", DOT_CLASS_NAME[item.dot])} /> : null}
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
  if (project) return header;
  return (
    <View>
      {header}
      {item.hasRows ? (
        <View
          className={cn(guideLineClassName(sidebarPane), "bottom-0 h-1")}
          style={guideX(sidebarPane)}
        />
      ) : null}
    </View>
  );
});

/** How far a nested row is pushed in; callers narrow its full-swipe width by the same amount. */
export const NESTED_ROW_INDENT = 28;

/** A thread row one level under a worktree header, with the guide line through its gutter. */
export const ThreadListV2NestedRow = memo(function ThreadListV2NestedRow(
  props: ViewProps & {
    readonly pane?: "screen" | "sidebar";
    /** The group's last row ends the line at its middle, leaving a gap before the next header. */
    readonly last?: boolean;
  },
) {
  const { pane, last, children, ...rest } = props;
  return (
    <View {...rest} style={{ paddingLeft: NESTED_ROW_INDENT }}>
      <View
        className={cn(guideLineClassName(pane === "sidebar"), "top-0")}
        style={{ ...guideX(pane === "sidebar"), bottom: last ? "50%" : 0 }}
      />
      {children}
    </View>
  );
});
