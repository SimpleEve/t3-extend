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

/** The desktop `t3x` command's state, and its actions with a toast on failure. */
export function useDesktopCliCommand() {
  const bridge = getDesktopCliCommandBridge();
  const query = useEnvironmentQuery(bridge ? desktopCliCommandStateAtom : null);
  const [pending, setPending] = useState(false);

  const run = (action: "install" | "uninstall" | "addToPath") => {
    if (!bridge || pending) return;
    setPending(true);
    void bridge[action]()
      .then(refreshDesktopCliCommandState)
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            // fork: t3x. A failed Add to PATH used to say "Could not remove".
            title:
              action === "install"
                ? t("Could not install {command}", { command: FORK.cliCommand })
                : action === "addToPath"
                  ? t("Could not add {command} to PATH", { command: FORK.cliCommand })
                  : t("Could not remove {command}", { command: FORK.cliCommand }),
            description: error instanceof Error ? error.message : t("Something went wrong."),
          }),
        );
      })
      .finally(() => setPending(false));
  };

  return {
    state: bridge ? query.data : undefined,
    busy: pending || query.isPending,
    run,
  };
}

export function CliCommandSettingsRow() {
  const { state, busy, run } = useDesktopCliCommand();

  if (!state?.supported) return null;
  const installed = state.installedPath !== null;
  // fork: t3x, i18n. The app name, command and paths are data, not translated.
  const app = FORK.appBaseName;
  const command = FORK.cliCommand;
  const description = state.shadowedBy
    ? `Another t3 at ${state.shadowedBy} runs first in a new terminal. Remove it to use T3 Code's.`
    : !installed
      ? "Run T3 Code's CLI as `t3` from any terminal."
      : state.onPath
        ? `Installed at ${state.installedPath}. Open a new terminal to use it.`
        : state.pathSetup?.added
          ? t("Installed at {path} and added to PATH in {file}. Open a new terminal to use it.", {
              path: state.installedPath,
              file: state.pathSetup.file,
            })
          : state.pathSetup
            ? t("Installed at {path}, which is not on your PATH yet.", {
                path: state.installedPath,
              })
            : t(
                "Installed at {path}, which is not on your PATH yet. Add its folder to your PATH to run `{command}`.",
                { path: state.installedPath, command },
              );

  return (
    <SettingsRow
      {...searchableSetting("cli-command")}
      description={description}
      control={
        <div className="flex gap-2">
          {state.pathSetup && !state.pathSetup.added ? (
            <Button size="sm" variant="outline" disabled={busy} onClick={() => run("addToPath")}>
              Add to PATH
            </Button>
          ) : null}
          <Button
            size="sm"
            variant="outline"
            disabled={busy || (!installed && Boolean(state.shadowedBy))}
            onClick={() => run(installed ? "uninstall" : "install")}
          >
            {installed ? "Remove" : "Install"}
          </Button>
        </div>
      }
    />
  );
}
