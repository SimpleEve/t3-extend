// fork: what each driver's processes look like in `ps` (design 5.6.3). A driver has a root, its
// direct child of the server, and a runtime that may listen; `exec` makes them one process.
// A driver whose shape was not verified is in `NO_SIGNATURE`: its whole subtree is excluded.

export interface DriverSignature {
  readonly driver: string;
  /** The driver sets `T3CODE_THREAD_ID` for the jobs its agent starts, so only these have agent jobs. */
  readonly agentJobs: boolean;
  /** The server's direct child for this driver. */
  readonly root: ReadonlyArray<RegExp>;
  /** The process that runs the agent. Its own listeners are never forwarded, wherever it sits. */
  readonly runtime: ReadonlyArray<RegExp>;
  readonly note: string;
}

const ARGV0 = String.raw`^(?:\S*[\\/])?`;
const SEP = String.raw`(?:^|[\\/\s])`;

export const DRIVER_SIGNATURES: ReadonlyArray<DriverSignature> = [
  {
    driver: "claudeAgent",
    agentJobs: true,
    // Native binary (`claude`, `.../claude/versions/<v>`) or the SDK's `cli.js` under node.
    root: [
      new RegExp(`${ARGV0}claude(?:\\.exe)?(?:\\s|$)`, "u"),
      /^\S*[\\/]claude[\\/]versions[\\/]/u,
      /[\\/]@anthropic-ai[\\/]claude-(?:code|agent-sdk)[\\/][^\s]*cli\.js(?:\s|$)/u,
    ],
    runtime: [
      new RegExp(`${ARGV0}claude(?:\\.exe)?(?:\\s|$)`, "u"),
      /^\S*[\\/]claude[\\/]versions[\\/]/u,
      /[\\/]@anthropic-ai[\\/]claude-(?:code|agent-sdk)[\\/][^\s]*cli\.js(?:\s|$)/u,
    ],
    note: "spawnClaudeProcessGroup: /bin/sh watcher script then exec of the CLI, same pid, direct child",
  },
  {
    driver: "codex",
    agentJobs: true,
    // `codex app-server`: the npm launcher is a node script that spawns the native binary, so the
    // root (node) and the runtime (native) both match.
    root: [new RegExp(`${SEP}codex(?:\\.js|\\.exe)?(?:\\s+\\S+)*?\\s+app-server(?:\\s|$)`, "u")],
    runtime: [new RegExp(`${SEP}codex(?:\\.js|\\.exe)?(?:\\s+\\S+)*?\\s+app-server(?:\\s|$)`, "u")],
    note: "makeCodexAppServerSpawnCommand: agentScope.wrap (exec), spawner.spawn; npm launcher does not exec",
  },
  {
    driver: "opencode",
    agentJobs: false,
    root: [new RegExp(`${SEP}opencode(?:\\.exe)?(?:\\s+\\S+)*?\\s+serve(?:\\s|$)`, "u")],
    runtime: [new RegExp(`${SEP}opencode(?:\\.exe)?(?:\\s+\\S+)*?\\s+serve(?:\\s|$)`, "u")],
    note: "OpenCodeRuntime: `serve --hostname --port`, listens on a loopback port of its own",
  },
  {
    driver: "grok",
    agentJobs: false,
    root: [
      new RegExp(
        `${ARGV0}grok(?:\\.exe)?(?:\\s+\\S+)*?\\s+agent(?:\\s+\\S+)*?\\s+stdio(?:\\s|$)`,
        "u",
      ),
    ],
    runtime: [
      new RegExp(
        `${ARGV0}grok(?:\\.exe)?(?:\\s+\\S+)*?\\s+agent(?:\\s+\\S+)*?\\s+stdio(?:\\s|$)`,
        "u",
      ),
    ],
    note: "acpSupport.ts: `grok agent stdio` through the ACP runtime",
  },
  {
    driver: "kiro",
    agentJobs: false,
    root: [new RegExp(`${ARGV0}kiro-cli(?:\\.exe)?\\s+acp(?:\\s|$)`, "u")],
    runtime: [new RegExp(`${ARGV0}kiro-cli(?:\\.exe)?\\s+acp(?:\\s|$)`, "u")],
    note: "acpSupport.ts: `kiro-cli acp ...` through the ACP runtime",
  },
  {
    driver: "fx",
    agentJobs: false,
    root: [new RegExp(`${ARGV0}fx(?:\\.exe)?\\s+acp(?:\\s|$)`, "u")],
    runtime: [new RegExp(`${ARGV0}fx(?:\\.exe)?\\s+acp(?:\\s|$)`, "u")],
    note: "acpSupport.ts: `fx acp` through the ACP runtime",
  },
  {
    driver: "pi",
    agentJobs: false,
    // `pi` is a node script, so the node process is the runtime and there is no second process.
    root: [
      new RegExp(`${ARGV0}pi(?:\\.exe)?(?:\\s+\\S+)*?\\s+--mode\\s+rpc(?:\\s|$)`, "u"),
      /[\\/]pi-coding-agent[\\/][^\s]*cli\.js(?:\s+\S+)*?\s+--mode\s+rpc(?:\s|$)/u,
    ],
    runtime: [
      new RegExp(`${ARGV0}pi(?:\\.exe)?(?:\\s+\\S+)*?\\s+--mode\\s+rpc(?:\\s|$)`, "u"),
      /[\\/]pi-coding-agent[\\/][^\s]*cli\.js(?:\s+\S+)*?\s+--mode\s+rpc(?:\s|$)/u,
    ],
    note: "provider-pi rpc.ts: `pi --mode rpc` over stdio",
  },
  {
    driver: "muse",
    agentJobs: false,
    root: [new RegExp(`${ARGV0}muse(?:\\.exe)?(?:\\s|$)`, "u")],
    runtime: [new RegExp(`${ARGV0}muse(?:\\.exe)?(?:\\s|$)`, "u")],
    note: "provider-muse sdk.ts: the SDK spawns `muse` over stdio; the SDK's own argv was not run",
  },
];

/** Drivers without a verified process shape. Their roots are unrecognized, so E2 excludes the subtree. */
export const NO_SIGNATURE: ReadonlyArray<{ readonly driver: string; readonly reason: string }> = [
  {
    driver: "cursor",
    reason:
      "the Cursor SDK starts its own local agent runtime internally; its process shape was not verified without running it",
  },
  {
    driver: "antigravity",
    reason:
      "ACP runtime with a user-installed binary whose name and argv were not verified without running it",
  },
  {
    driver: "acpRegistry",
    reason:
      "the command is whatever the registry entry or the user configured (npx, uvx or a binary), so no fixed shape exists",
  },
];

const matchesAny = (patterns: ReadonlyArray<RegExp>, args: string): boolean =>
  patterns.some((pattern) => pattern.test(args));

export interface ExtraExecutable {
  readonly driver: string;
  readonly binaryPath: string;
}

const basename = (path: string): string => path.split(/[\\/]/u).at(-1) ?? path;

/** A configured `binaryPath` names a root when it is the first or second argv word (node shims). */
const matchesConfiguredBinary = (extra: ReadonlyArray<ExtraExecutable>, args: string) => {
  const words = args.split(/\s+/u).slice(0, 2);
  return extra.filter((entry) =>
    words.some(
      (word) => word === entry.binaryPath || basename(word) === basename(entry.binaryPath),
    ),
  );
};

/** The driver whose root `args` looks like, or `null`. */
export const matchRoot = (
  args: string,
  extra: ReadonlyArray<ExtraExecutable> = [],
): DriverSignature | null => {
  const built = DRIVER_SIGNATURES.find((signature) => matchesAny(signature.root, args));
  if (built !== undefined) return built;
  const configured = matchesConfiguredBinary(extra, args)[0];
  return configured === undefined
    ? null
    : (DRIVER_SIGNATURES.find((signature) => signature.driver === configured.driver) ?? null);
};

/** True when `args` looks like any driver's runtime process. */
export const matchesRuntime = (args: string, extra: ReadonlyArray<ExtraExecutable> = []): boolean =>
  DRIVER_SIGNATURES.some((signature) => matchesAny(signature.runtime, args)) ||
  matchesConfiguredBinary(extra, args).length > 0;

/** `--inspect`, `--remote-debugging-port`, JDWP: a debugger may hold a random port (5.7). */
const DEBUG_FLAGS =
  /(?:^|[\s="'])(?:--inspect(?:-brk|-wait|-port)?(?:[=\s"']|$)|--remote-debugging-port(?:[=\s"']|$)|-agentlib:jdwp|-Xrunjdwp)/u;

export const hasDebugFlag = (launchText: string): boolean => DEBUG_FLAGS.test(launchText);

const AGENT_MARKER = /(?:^|\s)T3CODE_THREAD_ID=\S+/u;

export const hasAgentMarker = (launchText: string): boolean => AGENT_MARKER.test(launchText);
