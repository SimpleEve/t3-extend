import { useState } from "react";

import {
  desktopCliCommandStateAtom,
  getDesktopCliCommandBridge,
  refreshDesktopCliCommandState,
} from "~/state/desktopCliCommand";
import { useEnvironmentQuery } from "~/state/query";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { FORK } from "@t3tools/shared/forkIdentity";
import { useT } from "../../hooks/useT"; // fork: identity

export function CliCommandSettingsRow() {
  const t = useT();
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const state = query.data;
  const [pending, setPending] = useState(false);

  const change = (action: "install" | "uninstall") => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title:
              action === "install"
                ? t("Could not install {command}", { command: FORK.cliCommand }) // fork: t3x
                : t("Could not remove {command}", { command: FORK.cliCommand }),
            description: error instanceof Error ? error.message : t("Something went wrong."),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  if (!bridge || !state?.supported) return null;
  const installed = state.installedPath !== null;
  // fork: t3x, i18n. The app name, command and paths are data, not translated.
  const app = FORK.appBaseName;
  const command = FORK.cliCommand;
  const description = state.shadowedBy
    ? t("Another {command} at {path} runs first in a new terminal. Remove it to use {app}'s.", {
        command,
        path: state.shadowedBy,
        app,
      })
    : !installed
      ? t("Run {app}'s CLI as `{command}` from any terminal.", { app, command })
      : state.onPath
        ? t("Installed at {path}. Open a new terminal to use it.", { path: state.installedPath })
        : t(
            "Installed at {path}, which is not on your PATH yet. Add its folder to your PATH to run `{command}`.",
            { path: state.installedPath, command },
          );

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <Button
          size="sm"
          variant="outline"
          disabled={pending || query.isPending || (!installed && Boolean(state.shadowedBy))}
          onClick={() => change(installed ? "uninstall" : "install")}
        >
          {installed ? t("Remove") : t("Install")}
        </Button>
      }
    />
  );
}
