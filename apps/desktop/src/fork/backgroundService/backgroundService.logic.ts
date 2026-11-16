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

const isStringRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** A key that `plutil` would silently collapse into one when the file names it twice. */
const keyCount = (raw: string, key: string) => raw.split(`<key>${key}</key>`).length - 1;

/**
 * `plutil -convert json` has already parsed the file, so a corrupt or wrongly typed plist never
 * gets here as anything but undefined. What it cannot say is that a key appeared twice or sat in
 * a comment, so each key read is also counted in the raw text and must appear exactly once.
 * Anything doubtful is "not ours": the cost of a false "no" is a service the app leaves running.
 */
export function parseAppServicePlist(
  plutilJson: string,
  rawPlist: string,
): AppServicePlist | undefined {
  let value: unknown;
  try {
    value = JSON.parse(plutilJson);
  } catch {
    return undefined;
  }
  if (!isStringRecord(value)) return undefined;
  const program = value.ProgramArguments;
  const environment = value.EnvironmentVariables;
  if (
    !Array.isArray(program) ||
    program.length !== 3 ||
    !program.every((entry) => typeof entry === "string") ||
    program[2] !== "__service-launcher" ||
    !isStringRecord(environment) ||
    environment.T3X_APP_SERVICE !== "1" ||
    typeof environment.T3CODE_HOME !== "string" ||
    environment.T3CODE_HOME === ""
  ) {
    return undefined;
  }
  for (const key of ["ProgramArguments", "T3X_APP_SERVICE", "T3CODE_HOME"]) {
    if (keyCount(rawPlist, key) !== 1) return undefined;
  }
  return {
    executable: program[0] as string,
    entry: program[1] as string,
    baseDir: environment.T3CODE_HOME,
  };
}

/** The `.app` bundle of a path inside one, and the rest: a fallback when the full path will not resolve. */
export function splitAppBundle(path: string): { bundle: string; rest: string } | undefined {
  const match = /^(.+\.app)(\/Contents\/.*)?$/.exec(path);
  return match === null ? undefined : { bundle: match[1]!, rest: match[2] ?? "" };
}

/**
 * Doubled and trailing slashes, `.` and `..` segments out, and letter case folded: the volumes
 * macOS apps live on are case-insensitive by default, so `/applications/T3 Extend.app` is the
 * same app. On a case-sensitive volume two apps differing only in case, serving the same home,
 * would be mistaken for one; that is not a layout worth a weaker match for everyone else.
 */
export function comparablePath(path: string): string {
  const segments: Array<string> = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`.toLowerCase();
}

/** Both sides with links already resolved: the same program, entry and T3 home. */
export const sameAppService = (a: AppServicePlist, b: AppServicePlist): boolean =>
  comparablePath(a.executable) === comparablePath(b.executable) &&
  comparablePath(a.entry) === comparablePath(b.entry) &&
  comparablePath(a.baseDir) === comparablePath(b.baseDir);
