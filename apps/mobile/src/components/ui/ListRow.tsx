import { Platform } from "react-native";

import { useResolveClassNames } from "uniwind";
import { SymbolView } from "./AppSymbol";
import { ListRowLayout, type ListRowContentProps } from "./ListRowLayout";
import { RowPressable } from "./RowPressable";
import { useT } from "../../hooks/useT"; // fork: i18n
import { joinLabelParts } from "../../lib/accessibilityLabel"; // fork: i18n

export function ListRow(props: ListRowContentProps & { readonly onPress: () => void }) {
  const t = useT(); // fork: i18n
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={joinLabelParts([props.label, props.description, props.detail], t)}
      accessibilityState={{ disabled: Boolean(props.disabled) }}
      disabled={props.disabled}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className="bg-grouped-card"
    >
      <ListRowLayout
        {...props}
        accessory={
          <SymbolView
            name="chevron.right"
            size={16}
            tintColorClassName="accent-chevron"
            type="monochrome"
            weight="semibold"
          />
        }
      />
    </RowPressable>
  );
}
