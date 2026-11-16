import type { BackgroundServiceState } from "@t3tools/shared/backgroundService";
import { FORK } from "@t3tools/shared/forkIdentity";

/** The part of `t3x service status --json` the switch reads. */
export interface CliServiceStatus {
  readonly supported: boolean;
  readonly installed: boolean;
  readonly current?: boolean;
  readonly otherBaseDir?: string;
  readonly problems?: ReadonlyArray<string>;
}

export function parseCliServiceStatus(stdout: string): CliServiceStatus | undefined {
  for (const line of stdout.split("\n").reverse()) {
    if (!line.startsWith("{")) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (
        typeof value === "object" &&
        value !== null &&
        "supported" in value &&
        typeof value.supported === "boolean" &&
        "installed" in value &&
        typeof value.installed === "boolean"
      ) {
        return value as CliServiceStatus;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

/**
 * The switch is only visible while the app is open, and then the app's own server holds the home
 * and the service is stopped, so `running` says nothing here: installed and current is "on".
 */
export function backgroundServiceState(
  status: CliServiceStatus | undefined,
): BackgroundServiceState {
  if (status === undefined) return { kind: "attention", problem: "unreadable" };
  if (!status.supported) return { kind: "unavailable" };
  if (!status.installed) return { kind: "off" };
  if (status.otherBaseDir !== undefined) return { kind: "attention", problem: "other-home" };
  if (status.problems?.includes("app-runtime-missing") === true) {
    return { kind: "attention", problem: "app-missing" };
  }
  return status.current === true ? { kind: "on" } : { kind: "attention", problem: "needs-repair" };
}

export const launchdServiceTarget = (uid: number) => `gui/${uid}/${FORK.bootServiceLabel}`;

export const launchAgentPlistPath = (homeDirectory: string) =>
  `${homeDirectory}/Library/LaunchAgents/${FORK.bootServiceLabel}.plist`;
