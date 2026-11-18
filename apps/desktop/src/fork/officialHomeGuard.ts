import { FORK, officialHomeDirectory, officialHomeRefusal } from "@t3tools/shared/forkIdentity";

export interface OfficialHomeGuardInput {
  readonly baseDir: string;
  readonly homeDirectory: string;
  readonly platform: NodeJS.Platform;
  readonly join: (...segments: string[]) => string;
  readonly resolve: (...segments: string[]) => string;
  readonly dirname: (path: string) => string;
  readonly basename: (path: string) => string;
  /** Throws when the path does not exist. */
  readonly realPath: (path: string) => string;
}

/**
 * Returns the refusal text when the desktop's T3 home is official T3 Code's, else null. The
 * server refuses the same directory, but the desktop writes its logs, CLI shim, and service
 * files below it before the server starts. A missing path is compared by its nearest real
 * ancestor, so a link into the official home is caught before anything creates it.
 */
export function officialHomeProblem(input: OfficialHomeGuardInput): string | null {
  const caseInsensitive = input.platform === "darwin" || input.platform === "win32";
  const realLocation = (target: string): string => {
    try {
      return input.realPath(target);
    } catch {
      const parent = input.dirname(target);
      return parent === target ? target : input.join(realLocation(parent), input.basename(target));
    }
  };
  const keys = (target: string) => {
    const resolved = input.resolve(target);
    return [resolved, realLocation(resolved)].map((candidate) =>
      caseInsensitive ? candidate.normalize("NFC").toLowerCase() : candidate,
    );
  };
  const official = officialHomeDirectory(input.homeDirectory, input.join);
  const officialKeys = keys(official);
  return keys(input.baseDir).some((key) => officialKeys.includes(key))
    ? officialHomeRefusal(input.baseDir, official)
    : null;
}

export const OFFICIAL_HOME_DIALOG_TITLE = `${FORK.appBaseName} cannot use this data directory`;
