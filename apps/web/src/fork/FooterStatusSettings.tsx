// fork: switches for the sidebar footer chips and the desktop keep-awake guard (Settings → Appearance).
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { useT } from "../hooks/useT";
import {
  type FooterStatusKey,
  setFooterStatusToggle,
  useFooterStatusToggle,
} from "./footerStatusStore";

function ToggleRow(props: {
  readonly toggle: FooterStatusKey;
  readonly title: string;
  readonly description: string;
}) {
  const enabled = useFooterStatusToggle(props.toggle);
  return (
    <SettingsRow
      title={props.title}
      description={props.description}
      control={
        <Switch
          checked={enabled}
          onCheckedChange={(checked) => setFooterStatusToggle(props.toggle, Boolean(checked))}
          aria-label={props.title}
        />
      }
    />
  );
}

export function FooterStatusSettings() {
  const t = useT();
  return (
    <SettingsSection id="appearance-sidebar-status" title="Sidebar status">
      <ToggleRow
        toggle="limits"
        title={t("Subscription limits")}
        description={t("Show how much of each provider's subscription window is left.")}
      />
    </SettingsSection>
  );
}
