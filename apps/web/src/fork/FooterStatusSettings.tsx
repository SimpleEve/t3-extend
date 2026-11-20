// fork: switches for the sidebar footer chips (Settings → Appearance) and the desktop keep-awake
// guard (Settings → General).
import { SettingsRow, SettingsSection } from "../components/settings/settingsLayout";
import { Switch } from "../components/ui/switch";
import { isElectron } from "../env";
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
    <SettingsSection id="appearance-sidebar-status" title={t("Sidebar status")}>
      <ToggleRow
        toggle="limits"
        title={t("Subscription limits")}
        description={t("Show how much of each provider's subscription window is left.")}
      />
      <ToggleRow
        toggle="resources"
        title={t("Resource usage")}
        description={t("Show the CPU and memory T3 uses on the shown computer.")}
      />
      <ToggleRow
        toggle="ports"
        title={t("Servers")}
        description={t("Show the local servers that threads of the shown projects started.")}
      />
    </SettingsSection>
  );
}

/** Desktop only: the guard lives in the Electron main process. */
export function KeepAwakeSettings() {
  const t = useT();
  if (!isElectron) return null;
  return (
    <SettingsSection id="keep-awake" title={t("Power")}>
      <ToggleRow
        toggle="keepAwake"
        title={t("Keep computer awake while agents work")}
        description={t(
          "Keeps this computer from sleeping on idle while a thread on it is running. The screen can still turn off. Whether closing the lid puts it to sleep is up to macOS, and this switch cannot change that.",
        )}
      />
    </SettingsSection>
  );
}
