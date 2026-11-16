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

/** What the app's quit left behind when it could not start the service again. */
export interface ResumeFailure {
  readonly at: string;
  readonly reason: string;
}

export const RESUME_FAILURE_FILE = "background-service-resume-failed.json";

export function parseResumeFailure(text: string): ResumeFailure | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (
      typeof value === "object" &&
      value !== null &&
      "at" in value &&
      typeof value.at === "string" &&
      "reason" in value &&
      typeof value.reason === "string"
    ) {
      return { at: value.at, reason: value.reason };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/**
 * The switch is only visible while the app is open, and then the app's own server holds the home
 * and the service is stopped, so `running` says nothing here: installed and current is "on".
 * A failed start at the last quit is the one thing that outranks it.
 */
export function backgroundServiceState(
  status: CliServiceStatus | undefined,
  resumeFailure?: ResumeFailure,
): BackgroundServiceState {
  if (status === undefined) return { kind: "attention", problem: "unreadable" };
  if (!status.supported) return { kind: "unavailable" };
  if (!status.installed) return { kind: "off" };
  if (status.otherBaseDir !== undefined) return { kind: "attention", problem: "other-home" };
  if (status.problems?.includes("app-runtime-missing") === true) {
    return { kind: "attention", problem: "app-missing" };
  }
  if (status.current !== true) return { kind: "attention", problem: "needs-repair" };
  return resumeFailure === undefined
    ? { kind: "on" }
    : { kind: "attention", problem: "resume-failed", reason: resumeFailure.reason };
}

export const launchdServiceTarget = (uid: number) => `gui/${uid}/${FORK.bootServiceLabel}`;

export const launchAgentPlistPath = (homeDirectory: string) =>
  `${homeDirectory}/Library/LaunchAgents/${FORK.bootServiceLabel}.plist`;

/** The launch agent this app installed: its program, home and the marker `service install` adds. */
export interface AppServicePlist {
  readonly executable: string;
  readonly entry: string;
  readonly baseDir: string;
}

const unescapeXmlText = (value: string) =>
  value.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");

const environmentValue = (plist: string, name: string) =>
  new RegExp(`<key>${name}</key>\\s*<string>([^<]*)</string>`).exec(plist)?.[1];

/** Undefined for any plist that is not an app-mode service: the marker is what makes it ours. */
export function parseAppServicePlist(plist: string): AppServicePlist | undefined {
  if (environmentValue(plist, "T3X_APP_SERVICE") !== "1") return undefined;
  const program =
    /<key>ProgramArguments<\/key>\s*<array>\s*<string>([^<]*)<\/string>\s*<string>([^<]*)<\/string>/.exec(
      plist,
    );
  const baseDir = environmentValue(plist, "T3CODE_HOME");
  if (program === null || baseDir === undefined) return undefined;
  return {
    executable: unescapeXmlText(program[1]!),
    entry: unescapeXmlText(program[2]!),
    baseDir: unescapeXmlText(baseDir),
  };
}

/** The `.app` bundle of a path inside one, and the rest: links are resolved on the bundle alone. */
export function splitAppBundle(path: string): { bundle: string; rest: string } | undefined {
  const match = /^(.+\.app)(\/Contents\/.*)?$/.exec(path);
  return match === null ? undefined : { bundle: match[1]!, rest: match[2] ?? "" };
}

/** Both sides with links already resolved: the same program, entry and T3 home. */
export const sameAppService = (a: AppServicePlist, b: AppServicePlist): boolean =>
  a.executable === b.executable && a.entry === b.entry && a.baseDir === b.baseDir;
