// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - real server processes on temporary homes.
// One "computer": this checkout's server on its own home and free port, started the way the desktop
// app starts it (bootstrap credential on fd 3), with an owner session got through the real
// POST /oauth/token. Nothing here knows about ~/.t3 or the fork's real home.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import type * as NodeStream from "node:stream";
import * as NodeCrypto from "node:crypto";

import type { DevicesSnapshot, DevicesStatus } from "@t3tools/contracts";
import { FORK } from "@t3tools/shared/forkIdentity";

import { openRpc, rpcUrl, SnapshotWatcher, type RpcConnection } from "./rpc.ts";
import {
  check,
  cleanEnv,
  E2eFailure,
  freePort,
  httpRequest,
  ProcessLog,
  type ProcessRegistry,
  run,
} from "./util.ts";

const REPO_ROOT = NodePath.resolve(import.meta.dirname, "../..");
export const SERVER_ENTRY = NodePath.join(REPO_ROOT, "apps/server/src/bin.ts");

export interface E2eContext {
  readonly processes: ProcessRegistry;
  readonly workDir: string;
  readonly caFile: string;
  readonly frpcPath: string;
}

const childEnv = (ctx: E2eContext, home: string, extra: Readonly<Record<string, string>> = {}) =>
  cleanEnv({
    T3CODE_HOME: home,
    NODE_EXTRA_CA_CERTS: ctx.caFile,
    T3X_TUNNEL_CA_FILE: ctx.caFile,
    T3X_FRPC_PATH: ctx.frpcPath,
    ...extra,
  });

export const newHome = (ctx: E2eContext, name: string): string => {
  const home = NodePath.join(ctx.workDir, `home-${name}`);
  NodeFS.mkdirSync(home, { recursive: true, mode: 0o700 });
  return home;
};

/** `t3x devices join`, as a headless machine does it before its server starts. */
export async function cliJoin(
  ctx: E2eContext,
  home: string,
  invite: string,
  name: string,
): Promise<string> {
  const result = await run(
    process.execPath,
    [SERVER_ENTRY, "devices", "join", invite, "--name", name, "--base-dir", home],
    { env: childEnv(ctx, home), cwd: ctx.workDir },
  );
  check(
    result.status === 0,
    `devices join failed (${result.status}): ${result.stdout} ${result.stderr}`,
  );
  return result.stdout.trim();
}

/** `t3x devices remove`, run as its own process on a computer whose server keeps running. */
export async function cliRemove(ctx: E2eContext, home: string, device: string): Promise<string> {
  const result = await run(
    process.execPath,
    [SERVER_ENTRY, "devices", "remove", device, "--base-dir", home],
    { env: childEnv(ctx, home), cwd: ctx.workDir },
  );
  check(
    result.status === 0,
    `devices remove failed (${result.status}): ${result.stdout} ${result.stderr}`,
  );
  return result.stdout.trim();
}

export interface AuthSession {
  readonly sessionId: string;
  readonly subject: string;
  readonly scopes: ReadonlyArray<string>;
  readonly client: unknown;
  readonly connected: boolean;
}

export class Computer {
  readonly name: string;
  readonly home: string;
  readonly mainPort: number;
  readonly tunnelPort: number;
  readonly pid: number;
  readonly log: ProcessLog;
  readonly #ctx: E2eContext;
  readonly #ownerToken: string;
  #owner: RpcConnection | undefined;
  #watcher: SnapshotWatcher | undefined;

  constructor(input: {
    ctx: E2eContext;
    name: string;
    home: string;
    mainPort: number;
    tunnelPort: number;
    pid: number;
    log: ProcessLog;
    ownerToken: string;
  }) {
    this.#ctx = input.ctx;
    this.name = input.name;
    this.home = input.home;
    this.mainPort = input.mainPort;
    this.tunnelPort = input.tunnelPort;
    this.pid = input.pid;
    this.log = input.log;
    this.#ownerToken = input.ownerToken;
  }

  get mainOrigin(): string {
    return `http://127.0.0.1:${this.mainPort}`;
  }

  /** A new one-shot WebSocket ticket for a Bearer session on the main listener. */
  async #ticket(): Promise<string> {
    const response = await httpRequest(`${this.mainOrigin}/api/auth/websocket-ticket/rpc`, {
      method: "POST",
      headers: { authorization: `Bearer ${this.#ownerToken}` },
    });
    check(
      response.status === 200,
      `websocket ticket for ${this.name}: ${response.status} ${response.text}`,
    );
    return (response.json() as { ticket: string }).ticket;
  }

  async #connection(): Promise<RpcConnection> {
    this.#owner ??= await openRpc(rpcUrl(this.mainOrigin, await this.#ticket()));
    return this.#owner;
  }

  /** An owner RPC: the call the desktop renderer makes on its own server. */
  async call(method: string, payload: unknown = {}): Promise<unknown> {
    return (await this.#connection()).call(method, payload);
  }

  /** The `devices.subscribe` stream on a connection of its own. */
  async watch(): Promise<SnapshotWatcher> {
    this.#watcher ??= new SnapshotWatcher(
      await openRpc(rpcUrl(this.mainOrigin, await this.#ticket())),
    );
    return this.#watcher;
  }

  async status(): Promise<DevicesStatus> {
    return (await this.call("devices.status")) as DevicesStatus;
  }

  async refresh(): Promise<DevicesStatus> {
    return (await this.call("devices.refresh")) as DevicesStatus;
  }

  async snapshot(): Promise<DevicesSnapshot> {
    const watcher = await this.watch();
    return watcher.waitFor("a device snapshot", 15_000, () => true);
  }

  async environmentId(): Promise<string> {
    const response = await httpRequest(`${this.mainOrigin}/.well-known/t3/environment`);
    check(response.status === 200, `well-known on ${this.name}: ${response.status}`);
    return (response.json() as { environmentId: string }).environmentId;
  }

  /** Active sessions as `t3x auth session list` shows them (read from the state directory). */
  async sessions(): Promise<ReadonlyArray<AuthSession>> {
    const result = await run(
      process.execPath,
      [SERVER_ENTRY, "auth", "session", "list", "--json", "--base-dir", this.home],
      { env: childEnv(this.#ctx, this.home), cwd: this.#ctx.workDir },
    );
    check(result.status === 0, `auth session list failed: ${result.stderr}`);
    return JSON.parse(result.stdout) as ReadonlyArray<AuthSession>;
  }

  async stop(): Promise<void> {
    await Promise.allSettled([this.#owner?.close()]);
    await this.#ctx.processes.stop(this.pid);
  }
}

export async function startComputer(
  ctx: E2eContext,
  input: {
    readonly name: string;
    readonly home: string;
    readonly env?: Readonly<Record<string, string>>;
  },
): Promise<Computer> {
  const mainPort = await freePort();
  const desktopBootstrapToken = NodeCrypto.randomBytes(24).toString("hex");
  const { child, log } = ctx.processes.spawn(
    `server ${input.name}`,
    process.execPath,
    [
      SERVER_ENTRY,
      "--mode",
      "web",
      "--port",
      String(mainPort),
      "--host",
      "127.0.0.1",
      "--base-dir",
      input.home,
      "--no-browser",
      "--bootstrap-fd",
      "3",
    ],
    {
      cwd: ctx.workDir,
      // Debug, because the raw frpc lines (t3x:revoked and the like) are logged at that level.
      env: childEnv(ctx, input.home, { T3CODE_LOG_LEVEL: "Debug", ...input.env }),
      stdio: ["ignore", "pipe", "pipe", "pipe"],
      logFile: NodePath.join(ctx.workDir, `server-${input.name}.log`),
    },
  );
  (child.stdio[3] as NodeStream.Writable).end(
    `${JSON.stringify({
      mode: "desktop",
      noBrowser: true,
      port: mainPort,
      host: "127.0.0.1",
      desktopBootstrapToken,
      tailscaleServeEnabled: false,
      tailscaleServePort: FORK.tailscaleServePort,
    })}\n`,
  );

  const tunnel = await log.waitFor(/Tunnel listener on 127\.0\.0\.1:(\d+)/u, {
    label: `${input.name}'s tunnel listener`,
    timeoutMs: 120_000,
  });
  await log.waitFor(new RegExp(`Listening on http://127\\.0\\.0\\.1:${mainPort}`, "u"), {
    label: `${input.name} listening`,
    timeoutMs: 120_000,
  });

  // The desktop app's own path: its bootstrap credential, exchanged at /oauth/token.
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
    subject_token: desktopBootstrapToken,
    subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
    requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
  }).toString();
  const exchanged = await httpRequest(`http://127.0.0.1:${mainPort}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  if (exchanged.status !== 200) {
    throw new E2eFailure(`Owner session for ${input.name}: ${exchanged.status} ${exchanged.text}`);
  }
  return new Computer({
    ctx,
    name: input.name,
    home: input.home,
    mainPort,
    tunnelPort: Number(tunnel[1]),
    pid: child.pid ?? 0,
    log,
    ownerToken: (exchanged.json() as { access_token: string }).access_token,
  });
}
