// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - docker compose around the checked-in test stack.
// The self-host stack (registry, frps, Caddy) as infra/self-host's docker-compose.test.yml runs it,
// on a port and a project name of this script's own. The override file lives in the work directory.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { E2eFailure, run, type RunResult, until } from "./util.ts";

export const DOMAIN = "t3.localhost";
/** The other website in the fixture sites directory (see `writeSitesFixture`). */
export const SITE_FIXTURE_HOST = "other-site.localhost";
export const SITE_FIXTURE_BODY = "sites-fixture-ok";
const SELF_HOST = NodePath.resolve(import.meta.dirname, "../../infra/self-host");

export interface Stack {
  readonly project: string;
  readonly port: number;
  readonly origin: string;
  readonly caFile: string;
  readonly compose: (...args: ReadonlyArray<string>) => Promise<RunResult>;
  /** `./t3x invite`: the invite string, and whether a QR code came with it. */
  readonly invite: (kind: "computer" | "phone") => Promise<{ text: string; hasQr: boolean }>;
  readonly revoke: (name: string) => Promise<void>;
  /** Starts the project and fetches Caddy's root certificate. A failure here still needs `down`. */
  readonly up: () => Promise<void>;
  /**
   * Stops an `up` that is still running, then removes the project's containers, volumes and network.
   * Safe to call at any point and any number of times. Resolves to a description of what is left
   * behind if docker refused, or undefined when the project is gone.
   */
  readonly down: () => Promise<string | undefined>;
}

export type RunDocker = (
  args: ReadonlyArray<string>,
  options?: { readonly signal?: AbortSignal },
) => Promise<RunResult>;

const runDocker: RunDocker = (args, options) =>
  run("docker", args, { cwd: SELF_HOST, ...(options?.signal ? { signal: options.signal } : {}) });

/**
 * What a person puts in `T3X_SITES_DIR` for another website on the same server: a site file, a global-options
 * file, and a README that must not be read as configuration.
 */
function writeSitesFixture(dir: string): void {
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(dir, "fixture.caddy"),
    `${SITE_FIXTURE_HOST} {\n\trespond ${SITE_FIXTURE_BODY}\n}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(dir, "fixture.options"), `default_sni ${SITE_FIXTURE_HOST}\n`);
  NodeFS.writeFileSync(NodePath.join(dir, "README.md"), "Not a Caddyfile: this {\n");
}

/** What a failed `compose down -v` leaves for a person to deal with; undefined when it succeeded. */
export function describeDownProblem(project: string, result: RunResult): string | undefined {
  if (result.status === 0) return undefined;
  return (
    `\`docker compose down -v\` for project "${project}" failed (exit ${result.status ?? "none"}), ` +
    `so its containers, volumes or network may still exist.\n${result.stderr.trim()}\n` +
    `Remove them by hand with: docker compose -p ${project} down -v --remove-orphans`
  );
}

/**
 * Writes the compose override and env into the work directory and checks that the project name is
 * free; nothing is started. The check comes first so that a name already in use by someone else's
 * containers is refused and never handed to `down`.
 */
export async function prepareStack(options: {
  readonly project: string;
  readonly port: number;
  readonly workDir: string;
  readonly say: (message: string) => void;
  /** Tests only: stand-in for the docker CLI. */
  readonly docker?: RunDocker;
}): Promise<Stack> {
  const { project, port, workDir } = options;
  const docker = options.docker ?? runDocker;
  const origin = `https://${DOMAIN}:${port}`;
  const envFile = NodePath.join(workDir, "stack.env");
  const overrideFile = NodePath.join(workDir, "compose.override.yml");
  const sitesDir = NodePath.join(workDir, "sites");
  writeSitesFixture(sitesDir);
  // What setup.sh writes, minus ntfy (the push server is not part of these scenarios), with the fixture sites directory,
  // and Caddy's configuration directory the way setup.sh makes it (Caddyfile.test, no ntfy route, no e-mail).
  const confDir = NodePath.join(workDir, "caddy-conf");
  NodeChildProcess.execFileSync("bash", [
    NodePath.join(SELF_HOST, "caddy/conf.sh"),
    confDir,
    "--test",
  ]);
  NodeFS.writeFileSync(
    envFile,
    [
      `T3X_DOMAIN=${DOMAIN}`,
      `T3X_PUBLIC_ORIGIN=${origin}`,
      "ACME_EMAIL=",
      "COMPOSE_PROFILES=",
      `T3X_CADDY_CONF_DIR=${confDir}`,
      `T3X_SITES_DIR=${sitesDir}`,
      `T3X_NTFY_URL=https://ntfy.${DOMAIN}:${port}`,
      "",
    ].join("\n"),
  );
  // Both loopback addresses, because *.localhost resolves to ::1 first.
  NodeFS.writeFileSync(
    overrideFile,
    [
      "services:",
      "  caddy:",
      "    ports: !override",
      `      - "127.0.0.1:${port}:443"`,
      `      - "[::1]:${port}:443"`,
      "",
    ].join("\n"),
  );

  const composeArgs = (args: ReadonlyArray<string>) => [
    "compose",
    "-p",
    project,
    "--project-directory",
    SELF_HOST,
    "--env-file",
    envFile,
    "-f",
    NodePath.join(SELF_HOST, "docker-compose.yml"),
    "-f",
    NodePath.join(SELF_HOST, "docker-compose.test.yml"),
    "-f",
    overrideFile,
    ...args,
  ];
  const compose = (...args: ReadonlyArray<string>) => docker(composeArgs(args));

  const existing = await compose("ps", "-aq");
  // Only a successful `ps` with nothing in it says the project is empty. A docker that failed (no
  // daemon, no permission) or was interrupted prints nothing too, and the project is then unknown.
  if (existing.status !== 0) {
    throw new E2eFailure(
      `Could not tell whether the compose project "${project}" is free: \`docker compose ps\` ` +
        `${existing.status === null ? "was interrupted" : `exited with ${existing.status}`}.\n` +
        `${existing.stderr.trim()}\nCheck that Docker is running and usable, then run this again. ` +
        `Nothing was started or removed.`,
    );
  }
  if (existing.stdout.trim() !== "") {
    throw new E2eFailure(
      `The compose project "${project}" already has containers. If they are a leftover of an earlier run, remove them with ` +
        `\`docker compose -p ${project} down -v\`; otherwise choose another name with --project.`,
    );
  }

  const caFile = NodePath.join(workDir, "caddy-root.crt");
  const upAbort = new AbortController();
  let upRun: Promise<unknown> | undefined;

  const up = async () => {
    options.say(`docker compose project ${project} on port ${port}: building and starting...`);
    upRun = docker(composeArgs(["up", "-d", "--build", "--wait"]), { signal: upAbort.signal });
    const started = await upRun;
    if ((started as RunResult).status !== 0) {
      throw new E2eFailure(`docker compose up failed:\n${(started as RunResult).stderr}`);
    }
    // Caddy writes its internal CA while it starts; the file raises no event to wait on.
    const root = await until(
      {
        label: "Caddy's root certificate",
        timeoutMs: 60_000,
        reason: "Caddy creates the file during its own startup and tells nobody",
      },
      async () => {
        const read = await compose(
          "exec",
          "-T",
          "caddy",
          "cat",
          "/data/caddy/pki/authorities/local/root.crt",
        );
        return read.status === 0 && read.stdout.includes("BEGIN CERTIFICATE")
          ? read.stdout
          : undefined;
      },
    );
    NodeFS.writeFileSync(caFile, root);
  };

  const down = async () => {
    // An interrupted `up` must be over before `down`, or it can create what `down` just removed.
    upAbort.abort();
    await upRun?.catch(() => undefined);
    return describeDownProblem(project, await compose("down", "-v", "--remove-orphans"));
  };

  return {
    project,
    port,
    origin,
    caFile,
    compose,
    invite: async (kind) => {
      const result = await compose(
        "exec",
        "-T",
        "registry",
        "node",
        "/app/cli.mjs",
        "invite",
        "--kind",
        kind,
      );
      const lines = result.stdout.split("\n");
      const at = lines.findIndex((line) => /^t3x1\.[A-Za-z0-9_-]+$/u.test(line.trim()));
      if (result.status !== 0 || at === -1) {
        throw new E2eFailure(`./t3x invite failed: ${result.stdout} ${result.stderr}`);
      }
      return {
        text: lines[at]!.trim(),
        hasQr: lines.slice(at + 1).some((line) => line.trim() !== ""),
      };
    },
    revoke: async (name) => {
      const result = await compose(
        "exec",
        "-T",
        "registry",
        "node",
        "/app/cli.mjs",
        "revoke",
        name,
      );
      if (result.status !== 0)
        throw new E2eFailure(`./t3x revoke ${name} failed: ${result.stderr}`);
    },
    up,
    down,
  };
}
