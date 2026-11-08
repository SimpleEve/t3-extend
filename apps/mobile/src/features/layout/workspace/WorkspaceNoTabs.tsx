import { useNavigation } from "@react-navigation/native";
import { View } from "react-native";
import { useT } from "../../hooks/useT"; // fork: i18n
import { EmptyState } from "../../../components/ui/EmptyState";
import { openSettings } from "../../settings/settings-navigation";

export function WorkspaceNoTabs() {
  const t = useT();
  const navigation = useNavigation();
  return (
    <View className="flex-1 items-center justify-center bg-screen">
      <EmptyState
        title={t("All sections are hidden")}
        detail={t("Show a section to add it back to navigation.")}
        actionLabel={t("Edit navigation tabs")}
        variant="plain"
        onAction={() => openSettings(navigation, "SettingsNavigation")}
      />
    </View>
  );
}
