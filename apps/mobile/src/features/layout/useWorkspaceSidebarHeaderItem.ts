import { useNativeWorkspaceColumnsSupported } from "../../native/NativeWorkspaceColumns";
import { withNativeGlassHeaderItem } from "./native-glass-header-items";
import { useT } from "../../hooks/useT"; // fork: i18n
import { useSidebarToggle } from "./useSidebarToggle";

/** `useSidebarToggle` as a native header item. */
export function useWorkspaceSidebarHeaderItem() {
  const t = useT(); // fork: i18n
  const usesNativeWorkspaceColumns = useNativeWorkspaceColumnsSupported();
  const toggle = useSidebarToggle();
  if (!toggle) return null;
  return withNativeGlassHeaderItem({
    axisBehavior: usesNativeWorkspaceColumns ? "horizontalOnly" : undefined,
    accessibilityLabel: toggle.accessibilityLabel,
    icon: { name: toggle.icon, type: "sfSymbol" as const },
    identifier: "thread-left-sidebar",
    label: toggle.accessibilityLabel,
    onPress: toggle.onPress,
    type: "button" as const,
  });
}
