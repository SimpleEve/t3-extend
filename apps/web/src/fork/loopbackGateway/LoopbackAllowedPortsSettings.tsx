// fork: Settings → Browser → Localhost forwarding. The ports the user allowed on each remote
// environment, which no T3 terminal or agent started (research/remote-loopback-forwarding.md
// 5.6.3), with a way to take each one away again.
import { useAtomValue } from "@effect/atom-react";
import { getUiLocale } from "@t3tools/client-runtime/i18n";
import type { EnvironmentId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { useEffect, useState } from "react";

import { reachesEnvironmentLoopback } from "~/browser/browserTargetResolver";
import {
  SettingsRow,
  SettingsSection,
  SettingsUnavailableGroup,
} from "~/components/settings/settingsLayout";
import { useSearchableSetting } from "~/components/settings/settingsSearch";
import { Button } from "~/components/ui/button";
import { useT } from "~/hooks/useT";
import { useEnvironments } from "~/state/environments";

import { verbatim } from "../verbatim";
import {
  listAllowedLoopbackPorts,
  refreshAllowedLoopbackPorts,
  removeAllowedLoopbackGatewayPort,
  useAllowedLoopbackPorts,
} from "./allowedPorts";

const formatAllowedAt = (allowedAt: Date): string =>
  new Intl.DateTimeFormat(getUiLocale(), { dateStyle: "medium", timeStyle: "short" }).format(
    allowedAt,
  );

function EnvironmentAllowedPorts({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const t = useT();
  const permitted = useAtomValue(listAllowedLoopbackPorts.permissionAtom(environmentId));
  const ports = useAllowedLoopbackPorts(environmentId);
  const [removing, setRemoving] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the environment's list from its server when the section shows it
  useEffect(() => {
    if (permitted) void refreshAllowedLoopbackPorts(environmentId);
  }, [environmentId, permitted]);

  if (!permitted) return null;
  const remove = (port: number) => {
    setRemoving(port);
    setFailed(false);
    void removeAllowedLoopbackGatewayPort(environmentId, port).then((outcome) => {
      setRemoving(null);
      setFailed(!outcome.ok);
    });
  };

  return (
    <>
      <div className="px-3 py-2 text-xs font-medium text-muted-foreground sm:px-4">
        {verbatim(label)}
      </div>
      {ports !== null && ports.length === 0 ? (
        <div className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          {t("No allowed ports")}
        </div>
      ) : null}
      {(ports ?? []).map((entry) => (
        <SettingsRow
          key={entry.port}
          title={verbatim(`localhost:${entry.port}`)}
          description={t("Allowed {time}", {
            time: formatAllowedAt(DateTime.toDate(entry.allowedAt)),
          })}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={removing === entry.port}
              onClick={() => remove(entry.port)}
            >
              {t("Remove")}
            </Button>
          }
        />
      ))}
      {failed ? (
        <div role="alert" className="px-3 py-2 text-xs text-destructive sm:px-4">
          {t("Couldn't remove the port. Try again.")}
        </div>
      ) : null}
    </>
  );
}

export function LoopbackAllowedPortsSettings({
  desktopOnlyMessage,
}: {
  readonly desktopOnlyMessage: string | undefined;
}) {
  const setting = useSearchableSetting();
  const t = useT();
  const { environments } = useEnvironments();
  // Only where forwarding can apply: another computer, connected, and new enough to offer it.
  const eligible = environments.filter(
    (environment) =>
      environment.connection.phase === "connected" &&
      !reachesEnvironmentLoopback(environment.entry.target) &&
      environment.serverConfig?.environment.capabilities.loopbackGateway === true,
  );

  return (
    <SettingsSection {...setting("loopback-allowed-ports")}>
      <SettingsUnavailableGroup message={desktopOnlyMessage}>
        <div className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
          {t(
            "Services on these ports were not started by a T3 terminal or agent. You allowed them to be forwarded.",
          )}
        </div>
        {desktopOnlyMessage !== undefined ? null : eligible.length === 0 ? (
          <div className="px-3 py-3 text-sm text-muted-foreground sm:px-4">
            {t("No connected remote environment can forward localhost.")}
          </div>
        ) : (
          eligible.map((environment) => (
            <EnvironmentAllowedPorts
              key={environment.environmentId}
              environmentId={environment.environmentId}
              label={environment.label}
            />
          ))
        )}
      </SettingsUnavailableGroup>
    </SettingsSection>
  );
}
