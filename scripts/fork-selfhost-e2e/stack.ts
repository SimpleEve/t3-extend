// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - docker compose around the checked-in test stack.
// The self-host stack (registry, frps, Caddy) as infra/self-host's docker-compose.test.yml runs it,
// on a port and a project name of this script's own. The override file lives in the work directory.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { E2eFailure, run, type RunResult, until } from "./util.ts";

export const DOMAIN = "t3.localhost";
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
  readonly down: () => Promise<void>;
}

export async function startStack(options: {
  readonly project: string;
  readonly port: number;
  readonly workDir: string;
  readonly say: (message: string) => void;
}): Promise<Stack> {
  const { project, port, workDir } = options;
  const origin = `https://${DOMAIN}:${port}`;
  const envFile = NodePath.join(workDir, "stack.env");
  const overrideFile = NodePath.join(workDir, "compose.override.yml");
  // What setup.sh writes, minus ntfy (the push server is not part of these scenarios).
  NodeFS.writeFileSync(
    envFile,
    [
      `T3X_DOMAIN=${DOMAIN}`,
      `T3X_PUBLIC_ORIGIN=${origin}`,
      "ACME_EMAIL=",
      "COMPOSE_PROFILES=",
      "T3X_NTFY_SITE=./caddy/ntfy-off.caddy",
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

  const compose = (...args: ReadonlyArray<string>) =>
    run(
      "docker",
      [
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
      ],
      { cwd: SELF_HOST },
    );

  const existing = await compose("ps", "-aq");
  if (existing.stdout.trim() !== "") {
    throw new E2eFailure(
      `The compose project "${project}" already has containers. If they are a leftover of an earlier run, remove them with ` +
        `\`docker compose -p ${project} down -v\`; otherwise choose another name with --project.`,
    );
  }

  const stack: Stack = {
    project,
    port,
    origin,
    caFile: NodePath.join(workDir, "caddy-root.crt"),
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
    down: async () => {
      await compose("down", "-v", "--remove-orphans");
    },
  };

  options.say(`docker compose project ${project} on port ${port}: building and starting...`);
  const started = await compose("up", "-d", "--build", "--wait");
  if (started.status !== 0) {
    await stack.down();
    throw new E2eFailure(`docker compose up failed:\n${started.stderr}`);
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
  NodeFS.writeFileSync(stack.caFile, root);
  return stack;
}
