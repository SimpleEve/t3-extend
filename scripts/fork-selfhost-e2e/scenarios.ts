// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - scenarios against a real stack and real servers.
// The 14 scenarios of research/self-host-device-keys.md 7.2, in an order that lets each one use what
// the earlier ones set up (the numbers are the design's), and 15, the loopback gateway
// (research/remote-loopback-forwarding.md 12, 9.4). Every wait is on an event: a process log
// line, a devices.subscribe snapshot, a socket closing; `until` appears only where nothing raises one.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeTls from "node:tls";

import type { DevicesSnapshot } from "@t3tools/contracts";
import type { LoopbackGatewayEvent } from "@t3tools/shared/forkLoopbackGateway/bridge";
import { formatLoopbackGatewayAuthorization } from "@t3tools/shared/forkLoopbackGateway/protocol";
import * as NodeCrypto from "node:crypto";
import * as Redacted from "effect/Redacted";

import { makeGatewayEnvironment } from "../../apps/desktop/src/fork/loopbackGateway/GatewayEnvironment.ts";
import { openLoopbackTunnel } from "../../apps/desktop/src/fork/loopbackGateway/TunnelClient.ts";
import { cliJoin, type Computer, type E2eContext, newHome, startComputer } from "./computer.ts";
import {
  keepAliveFetcher,
  loadModuleGraph,
  readServerSpans,
  startLatencyRelay,
  stats,
  type LatencyRelay,
} from "./firstPaint.ts";
import {
  connectViaProxy,
  getViaProxy,
  proxyEndpoint,
  startServiceInTerminal,
  startServiceOutsideTerminal,
  streamViaProxy,
  type TerminalService,
  webSocketViaProxy,
} from "./gateway.ts";
import {
  checkNoAccessLogConfigured,
  enableCaddyAccessLog,
  findSecret,
  stackLogs,
} from "./infraLogs.ts";
import { DpopKey, exchangePass, Phone, sessionOf, sessionSocketUrl } from "./phone.ts";
import { openRpc, RpcFailure, type RpcConnection } from "./rpc.ts";
import { DOMAIN, SITE_FIXTURE_BODY, SITE_FIXTURE_HOST, type Stack } from "./stack.ts";
import { check, checkEqual, E2eFailure, httpRequest, say, until } from "./util.ts";

export interface World {
  readonly ctx: E2eContext;
  readonly stack: Stack;
  readonly computers: Array<Computer>;
  registryId?: string;
  a?: Computer;
  b?: Computer;
  aEnv?: string;
  bEnv?: string;
  phone1?: Phone;
  phone2?: Phone;
  phone1Token?: string;
  phone1Rpc?: RpcConnection;
}

export interface Scenario {
  readonly id: number;
  readonly title: string;
  readonly timeoutMs: number;
  /** Runs only when asked for with `--only`: a measurement, not a check. */
  readonly optional?: boolean;
  readonly run: (world: World) => Promise<void>;
}

const need = <T>(value: T | undefined, what: string): T => {
  if (value === undefined) throw new E2eFailure(`${what} is not set up yet.`);
  return value;
};

const tunnelUrl = (world: World, subdomain: string): string =>
  `https://${subdomain}.${DOMAIN}:${world.stack.port}`;

/** The server's warning when frpc reports a registry rejection; the fields follow on the next line. */
const rejection = (reason: string, source?: string): RegExp =>
  new RegExp(
    `frpc reported a rejection\\.\\s*\\{${source === undefined ? "[^}]*" : ` source: '${source}', `}reason: '${reason}'`,
    "u",
  );
const LOGGED_IN = /login to server success/u;

const environmentAt = async (url: string): Promise<string | undefined> => {
  const response = await httpRequest(`${url}/.well-known/t3/environment`);
  return response.status === 200
    ? (response.json() as { environmentId: string }).environmentId
    : undefined;
};

/** The tunnel serves this environment: the path through Caddy and frps works end to end. */
const reachable = (url: string, environmentId: string, timeoutMs = 60_000) =>
  until(
    {
      label: `${url} to serve environment ${environmentId.slice(0, 8)}`,
      timeoutMs,
      reason: "the route through Caddy and frps raises no event of its own",
    },
    async () => ((await environmentAt(url)) === environmentId ? true : undefined),
  );

const handshake = (host: string, port: number) =>
  new Promise<{ ok: true } | { ok: false; message: string }>((resolve) => {
    const socket = NodeTls.connect({ host, port, servername: host }, () => {
      socket.end();
      resolve({ ok: true });
    });
    socket.once("error", (error) => resolve({ ok: false, message: error.message }));
  });

/** The subject alternative names of the certificate a client without SNI gets (an IP address sends none). */
const certificateWithoutSni = (port: number) =>
  new Promise<string>((resolve, reject) => {
    const socket = NodeTls.connect({ host: "127.0.0.1", port, rejectUnauthorized: false }, () => {
      const names = socket.getPeerCertificate().subjectaltname ?? "";
      socket.end();
      resolve(names);
    });
    socket.once("error", reject);
  });

const failWithin = <T>(promise: Promise<T>, label: string, timeoutMs: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<never>((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            new E2eFailure(
              `Timed out after ${Math.round(timeoutMs / 1000)} s waiting for ${label}.`,
            ),
          ),
        timeoutMs,
      ),
    ),
  ]);

const hasDevice = (snapshot: DevicesSnapshot, name: string): boolean =>
  snapshot.devices.some((device) => device.name === name);

/** A computer's own signed pass for another computer, exchanged for a session with an open RPC connection. */
async function computerSignsIntoComputer(
  from: Computer,
  to: Computer,
  toEnvironmentId: string,
  toUrl: string,
): Promise<RpcConnection> {
  const key = new DpopKey();
  // The registry learns a computer's environment id when its server first reports it; a refresh pulls it.
  const signed = await until(
    {
      label: `${from.name} to know ${to.name}`,
      timeoutMs: 90_000,
      reason:
        "the registry learns an environment id from the server's own report, which raises no event here",
    },
    async () => {
      try {
        return (await from.call("devices.signAssertion", {
          audienceEnvironmentId: toEnvironmentId,
          dpopThumbprint: key.thumbprint,
        })) as { assertion: string };
      } catch (error) {
        if (error instanceof RpcFailure && error.reason === "unknown_audience") {
          await from.refresh();
          return undefined;
        }
        throw error;
      }
    },
  );
  const { accessToken } = sessionOf(await exchangePass(toUrl, signed.assertion, key), toUrl);
  return openRpc(await sessionSocketUrl(toUrl, accessToken, key));
}

/** A computer's own signed pass for another computer, exchanged and used for one RPC. */
async function computerLogsIntoComputer(
  from: Computer,
  to: Computer,
  toEnvironmentId: string,
  toUrl: string,
) {
  const connection = await computerSignsIntoComputer(from, to, toEnvironmentId, toUrl);
  try {
    await connection.call("server.probe");
  } finally {
    await connection.close();
  }
}

const newComputer = async (
  world: World,
  name: string,
  env?: Record<string, string>,
): Promise<Computer> => {
  const computer = await startComputer(world.ctx, {
    name,
    home: newHome(world.ctx, name.toLowerCase()),
    ...(env === undefined ? {} : { env }),
  });
  world.computers.push(computer);
  return computer;
};

/** A computer that joined with the CLI before its server started, as a headless machine does. */
async function joinedComputer(world: World, name: string): Promise<Computer> {
  const invite = await world.stack.invite("computer");
  const home = newHome(world.ctx, name.toLowerCase());
  const output = await cliJoin(world.ctx, home, invite.text, name);
  check(output.includes(`Joined as ${name}`), `unexpected join output: ${output}`);
  const computer = await startComputer(world.ctx, { name, home });
  world.computers.push(computer);
  const watcher = await computer.watch();
  await watcher.waitFor(
    `${name}'s tunnel`,
    60_000,
    (s) => s.status.state === "joined" && s.status.tunnel.status === "connected",
  );
  return computer;
}

export const scenarios: ReadonlyArray<Scenario> = [
  {
    id: 1,
    title: "an invite from the server: a string and a QR code",
    timeoutMs: 60_000,
    run: async (world) => {
      const info = await httpRequest(`${world.stack.origin}/v1/info`);
      checkEqual(info.status, 200, "GET /v1/info");
      world.registryId = (info.json() as { registryId: string }).registryId;
      const invite = await world.stack.invite("computer");
      check(invite.text.startsWith("t3x1."), "the invite is a t3x1. string");
      check(invite.hasQr, "the invite comes with a QR code");
    },
  },
  {
    id: 2,
    title: "computer A joins, its tunnel comes up, its address serves its environment",
    timeoutMs: 180_000,
    run: async (world) => {
      const a = await joinedComputer(world, "A");
      world.a = a;
      const watcher = await a.watch();
      const snapshot = await watcher.waitFor(
        "A's tunnel connected",
        90_000,
        (s) => s.status.state === "joined" && s.status.tunnel.status === "connected",
      );
      // The registry marks a computer online once its tunnel has logged in; every sync returns the
      // full list, so one more sync (asked for now, not at the next 60 s tick) must show A online.
      await a.refresh();
      await watcher.waitFor("A's own list to show itself online", 30_000, (s) =>
        s.devices.some((device) => device.self && device.online === true),
      );
      const url = need(snapshot.status.url ?? undefined, "A's address");
      checkEqual(url, tunnelUrl(world, "a"), "A's public address");
      world.aEnv = await a.environmentId();
      checkEqual(await environmentAt(url), world.aEnv, "A's environment through the tunnel");
    },
  },
  {
    id: 3,
    title: "A invites two phones; a phone logs into A with a pass and makes a read-only call",
    timeoutMs: 120_000,
    run: async (world) => {
      const a = need(world.a, "A");
      const names = ["Phone1", "Phone2"] as const;
      const phones: Array<Phone> = [];
      for (const name of names) {
        const { invite } = (await a.call("devices.invite", { kind: "phone" })) as {
          invite: string;
        };
        phones.push(await Phone.join(invite, name));
      }
      const [phone1, phone2] = phones as [Phone, Phone];
      world.phone1 = phone1;
      world.phone2 = phone2;
      // A learns its new devices on its next sync (60 s); a refresh is the same sync, asked for now.
      const watcher = await a.watch();
      await a.refresh();
      await watcher.waitFor(
        "A to list both phones",
        30_000,
        (s) => hasDevice(s, "Phone1") && hasDevice(s, "Phone2"),
      );

      for (const phone of phones) {
        const manifest = await phone.manifest();
        const entry = manifest.find((device) => device.kind === "computer" && device.name === "A");
        checkEqual(entry?.environmentId, world.aEnv, "A's environment id in the registry");
        checkEqual(entry?.url, tunnelUrl(world, "a"), "A's address in the registry");
        // The phone asks the registry directly, so this is the registry's own view of the tunnel.
        checkEqual(entry?.online, true, "A online in the registry");
      }
      const { accessToken, scope } = await phone1.login(
        tunnelUrl(world, "a"),
        need(world.aEnv, "A's environment"),
      );
      check(
        !scope.split(" ").some((s) => s === "access:write" || s === "relay:write"),
        `a phone session must not hold access:write or relay:write (got ${scope})`,
      );
      world.phone1Token = accessToken;
      world.phone1Rpc = await openRpc(
        await phone1.webSocketUrl(tunnelUrl(world, "a"), accessToken),
      );
      await world.phone1Rpc.call("server.probe");

      const sessions = await a.sessions();
      const mine = sessions.find((s) => s.subject === `t3x-device:phone:${phone1.id}`);
      check(mine !== undefined, "Phone1's session is among A's authorized clients");
      check(
        JSON.stringify(mine).includes("Phone1"),
        `the session carries the phone's name: ${JSON.stringify(mine)}`,
      );
    },
  },
  {
    id: 4,
    title: "computer B joins; A and B log into each other with passes A and B sign",
    timeoutMs: 240_000,
    run: async (world) => {
      const a = need(world.a, "A");
      const b = await joinedComputer(world, "B");
      world.b = b;
      world.bEnv = await b.environmentId();
      const aUrl = tunnelUrl(world, "a");
      const bUrl = tunnelUrl(world, "b");
      checkEqual(await environmentAt(bUrl), world.bEnv, "B's environment through the tunnel");
      await computerLogsIntoComputer(a, b, world.bEnv, bUrl);
      await computerLogsIntoComputer(b, a, need(world.aEnv, "A's environment"), aUrl);
      const aId = need((await a.status()).deviceId, "A's device id");
      const bId = need((await b.status()).deviceId, "B's device id");
      check(
        (await b.sessions()).some((s) => s.subject === `t3x-device:computer:${aId}`),
        "A's session is on B",
      );
      check(
        (await a.sessions()).some((s) => s.subject === `t3x-device:computer:${bId}`),
        "B's session is on A",
      );
    },
  },
  {
    id: 5,
    title: "a phone cannot manage devices, on the computer or at the registry",
    timeoutMs: 60_000,
    run: async (world) => {
      const phone = need(world.phone1, "Phone1");
      const rpc = need(world.phone1Rpc, "Phone1's connection");
      // Writes need access:write, which a phone's session never holds, so the scope check refuses
      // them before the handler; the read-only status gets to the handler, which refuses by subject.
      const refusals = [
        ["devices.invite", { kind: "phone" }, "EnvironmentAuthorizationError"],
        ["devices.remove", { deviceId: phone.id }, "EnvironmentAuthorizationError"],
        ["devices.status", {}, "not_local_owner"],
      ] as const;
      for (const [method, payload, expected] of refusals) {
        const failure = await rpc.call(method, payload).then(
          () => undefined,
          (error: unknown) => error,
        );
        check(failure instanceof RpcFailure, `${method} from a phone must be refused`);
        checkEqual(failure.reason ?? failure.tag, expected, `${method} refusal`);
      }
      const direct = await phone.registry("POST", "/v1/invites", { kind: "phone" });
      checkEqual(direct.status, 403, "a phone creating an invite at the registry");
    },
  },
  {
    id: 9,
    title: "a pass is spent once; a wrong audience or a wrong DPoP key is refused",
    timeoutMs: 60_000,
    run: async (world) => {
      const phone = need(world.phone2, "Phone2");
      const aUrl = tunnelUrl(world, "a");
      const aEnv = need(world.aEnv, "A's environment");
      const expectRefused = async (label: string, assertion: string, reason: string) => {
        const response = await phone.exchange(aUrl, assertion);
        checkEqual(response.status, 401, `${label}: status`);
        checkEqual(response.headers["t3x-reason"], reason, `${label}: t3x-reason`);
      };
      const pass = phone.pass({ audienceEnvironmentId: aEnv });
      sessionOf(await phone.exchange(aUrl, pass), aUrl);
      await expectRefused("the same pass again", pass, "replay");
      await expectRefused(
        "a pass for another computer",
        phone.pass({ audienceEnvironmentId: need(world.bEnv, "B's environment") }),
        "audience_mismatch",
      );
      await expectRefused(
        "a pass bound to another DPoP key",
        phone.pass({ audienceEnvironmentId: aEnv, dpopThumbprint: new DpopKey().thumbprint }),
        "key_mismatch",
      );
    },
  },
  {
    id: 6,
    title: "removing a phone (on B): A's next sync drops its session and closes its socket",
    timeoutMs: 120_000,
    run: async (world) => {
      const a = need(world.a, "A");
      const b = need(world.b, "B");
      const phone1 = need(world.phone1, "Phone1");
      const phone2 = need(world.phone2, "Phone2");
      const aUrl = tunnelUrl(world, "a");

      const socket = new WebSocket(
        await phone1.webSocketUrl(aUrl, need(world.phone1Token, "Phone1's session")),
      );
      await new Promise<void>((resolve, reject) => {
        socket.addEventListener("open", () => resolve());
        socket.addEventListener("error", () =>
          reject(new E2eFailure("Phone1's socket could not open.")),
        );
      });
      const closed = new Promise<void>((resolve) =>
        socket.addEventListener("close", () => resolve()),
      );

      await b.refresh();
      await b.call("devices.remove", { deviceId: phone1.id });
      await a.refresh();
      await failWithin(closed, "Phone1's open socket to close", 30_000);
      check(
        !(await a.sessions()).some((s) => s.subject === `t3x-device:phone:${phone1.id}`),
        "Phone1's session is gone from A",
      );
      const again = await phone1.exchange(
        aUrl,
        phone1.pass({ audienceEnvironmentId: need(world.aEnv, "A's environment") }),
      );
      // Once A has synced, the phone is simply not in its list; device_revoked is only the race of
      // a removal landing between the lookup and the issue.
      checkEqual(again.status, 401, "a removed phone's new pass");
      checkEqual(again.headers["t3x-reason"], "device_unknown", "the removed phone's t3x-reason");
      await phone2.login(aUrl, need(world.aEnv, "A's environment"));
    },
  },
  {
    id: 8,
    title: "a ticket cannot open another computer's subdomain",
    timeoutMs: 90_000,
    run: async (world) => {
      const a = need(world.a, "A");
      const b = need(world.b, "B");
      const config = NodeFS.readFileSync(
        NodePath.join(a.home, "userdata", "fork-tunnel", "frpc.toml"),
        "utf8",
      );
      check(/^subdomain = "a"$/mu.test(config), "A's frpc config asks for subdomain a");
      const squat = NodePath.join(world.ctx.workDir, "squat.toml");
      NodeFS.writeFileSync(squat, config.replace(/^subdomain = "a"$/mu, 'subdomain = "b"'), {
        mode: 0o600,
      });
      const { child, log } = world.ctx.processes.spawn(
        "frpc squat",
        world.ctx.frpcPath,
        ["-c", squat],
        {
          cwd: world.ctx.workDir,
          stdio: ["ignore", "pipe", "pipe"],
          logFile: NodePath.join(world.ctx.workDir, "frpc-squat.log"),
        },
      );
      try {
        await log.waitFor(/\[t3x\] start error/u, {
          label: "the registry to refuse the subdomain",
          timeoutMs: 45_000,
        });
        check(!/start proxy success/u.test(log.since(0)), "the squatting proxy must not start");
      } finally {
        await world.ctx.processes.stop(child.pid ?? 0);
      }
      checkEqual(
        await environmentAt(tunnelUrl(world, "b")),
        need(world.bEnv, "B's environment"),
        "b's subdomain still serves B",
      );
      void b;
    },
  },
  {
    id: 12,
    title:
      "no certificate for a subdomain nobody registered; another website from the sites directory is served",
    timeoutMs: 60_000,
    run: async (world) => {
      const evil = await handshake(`evil.${DOMAIN}`, world.stack.port);
      check(!evil.ok, "the handshake for an unregistered name must fail");
      check(
        /alert internal error/u.test(evil.message),
        `unexpected handshake failure: ${evil.message}`,
      );
      const known = await handshake(`a.${DOMAIN}`, world.stack.port);
      check(known.ok, "the handshake for a registered name works");

      // The sites directory (infra/self-host/sites/README.md): a site file is served next to ours, a global
      // options file reaches Caddy (default_sni answers a client that sends no SNI), a README is not read.
      const site = await httpRequest(`https://${SITE_FIXTURE_HOST}:${world.stack.port}/`);
      checkEqual(site.status, 200, "the site from the sites directory");
      checkEqual(site.text, SITE_FIXTURE_BODY, "the site from the sites directory");
      const noSni = await certificateWithoutSni(world.stack.port);
      check(
        noSni.includes(`DNS:${SITE_FIXTURE_HOST}`),
        `a client without SNI should get default_sni's certificate, got: ${noSni}`,
      );
    },
  },
  {
    id: 11,
    title: "frps restarts and the tunnel returns; an expired ticket is replaced",
    timeoutMs: 240_000,
    run: async (world) => {
      const a = need(world.a, "A");
      const aUrl = tunnelUrl(world, "a");
      const aEnv = need(world.aEnv, "A's environment");

      const starts = () => (a.log.since(0).match(/frpc started\./gu) ?? []).length;
      const startedBefore = starts();
      const mark = a.log.mark();
      const restart = await world.stack.compose("restart", "frps");
      checkEqual(restart.status, 0, "docker compose restart frps");
      await a.log.waitFor(LOGGED_IN, {
        label: "frpc to log in again",
        timeoutMs: 90_000,
        from: mark,
      });
      await reachable(aUrl, aEnv);
      checkEqual(
        starts(),
        startedBefore,
        "frpc was not restarted by the server (the same ticket was accepted)",
      );

      // A third computer whose tickets live 20 s: the first heartbeat (30 s) finds it expired.
      const invite = await world.stack.invite("computer");
      const c = await newComputer(world, "C", { T3X_TEST_TICKET_LIFETIME_SECONDS: "20" });
      await c.call("devices.join", { invite: invite.text, name: "C" });
      await c.log.waitFor(/frpc started\./u, { label: "C's frpc", timeoutMs: 60_000 });
      const expired = c.log.mark();
      await c.log.waitFor(rejection("ticket-expired"), {
        label: "frpc to report an expired ticket",
        timeoutMs: 90_000,
        from: expired,
      });
      const renewed = await c.log.waitFor(/frpc started\.[^\n]*/u, {
        label: "C's frpc to restart with a new ticket",
        timeoutMs: 60_000,
        from: expired,
      });
      check(renewed[0].length > 0, "frpc was started again");
      await reachable(tunnelUrl(world, "c"), await c.environmentId());
      await c.stop();
    },
  },
  {
    id: 13,
    title: "a slow plugin and a registry outage: the tunnel recovers by itself",
    timeoutMs: 300_000,
    run: async (world) => {
      const a = need(world.a, "A");
      const aUrl = tunnelUrl(world, "a");
      const aEnv = need(world.aEnv, "A's environment");
      const exec = (...args: ReadonlyArray<string>) =>
        world.stack.compose("exec", "-T", "registry", ...args);

      // Login that takes 3 s is past the registry's 1.5 s limit: frps gets t3x:busy.
      checkEqual(
        (await exec("touch", "/tmp/slow-login")).status,
        0,
        "enabling the slow Login hook",
      );
      const slow = a.log.mark();
      await world.stack.compose("restart", "frps");
      await a.log.waitFor(rejection("busy"), {
        label: "t3x:busy from a slow plugin",
        timeoutMs: 90_000,
        from: slow,
      });
      await exec("rm", "-f", "/tmp/slow-login");
      const recovered = a.log.mark();
      await a.log.waitFor(LOGGED_IN, {
        label: "frpc to log in once the plugin is fast",
        timeoutMs: 120_000,
        from: slow,
      });
      await reachable(aUrl, aEnv, 90_000);
      void recovered;

      // The registry is down. Work connections fail first, but only the heartbeat (source "pong") makes
      // frps drop the control connection; keep the registry down until that has happened, so what
      // comes back is a real reconnect and not a connection that never noticed.
      const down = a.log.mark();
      await world.stack.compose("stop", "registry");
      await a.log.waitFor(rejection("plugin-error", "pong"), {
        label: "the heartbeat to fail while the registry is down",
        timeoutMs: 90_000,
        from: down,
      });
      const restarted = a.log.mark();
      await world.stack.compose("start", "registry");
      await until(
        {
          label: "the registry to answer",
          timeoutMs: 60_000,
          reason: "the container's readiness raises no event here",
        },
        async () =>
          (await httpRequest(`${world.stack.origin}/v1/info`)).status === 200 ? true : undefined,
      );
      await a.log.waitFor(LOGGED_IN, {
        label: "frpc to log in after the registry came back",
        timeoutMs: 120_000,
        from: restarted,
      });
      await reachable(aUrl, aEnv, 90_000);
    },
  },
  {
    id: 15,
    title:
      "a service B's terminal started is reached through the tunnel as localhost (page, SSE, WebSocket); one no terminal started is refused; removing the device closes both ends",
    timeoutMs: 420_000,
    run: async (world) => {
      const b = need(world.b, "B");
      const bEnv = need(world.bEnv, "B's environment");
      const bUrl = tunnelUrl(world, "b");
      // Earlier scenarios took the registry down: B's route through Caddy and frps comes back on its own.
      await reachable(bUrl, bEnv, 90_000);
      const descriptor = (await httpRequest(`${bUrl}/.well-known/t3/environment`)).json() as {
        platform: { os: string };
        capabilities: { loopbackGateway?: boolean };
      };
      // B advertises the capability on macOS only (Linux waits for its own checks, Windows has none).
      if (descriptor.platform.os !== "darwin") {
        check(
          descriptor.capabilities.loopbackGateway !== true,
          "B must not advertise the gateway off macOS",
        );
        say("  not macOS: the gateway is not advertised, nothing more to check here");
        return;
      }
      checkEqual(descriptor.capabilities.loopbackGateway, true, "B's gateway capability");

      // D plays the desktop app of another computer: its own session on B, and the desktop's own
      // proxy, tunnel client and environment state (no Electron) in this process.
      const d = await joinedComputer(world, "D");
      // B learns of D on its next sync (60 s); a refresh is the same sync, asked for now.
      await b.refresh();
      const dId = need((await d.status()).deviceId, "D's device id");
      const events: Array<LoopbackGatewayEvent> = [];
      const environment = makeGatewayEnvironment({
        environmentId: bEnv,
        emit: (event) => events.push(event),
        onProxyChange: async () => {},
      });
      const open: Array<{ destroy: () => void }> = [];
      let service: TerminalService | undefined;
      let outside: { port: number; stop: () => Promise<void> } | undefined;
      let sessionOnB: RpcConnection | undefined;
      try {
        service = await startServiceInTerminal(world.ctx, b, "gateway");
        outside = await startServiceOutsideTerminal(world.ctx, "outside-service");
        sessionOnB = await computerSignsIntoComputer(d, b, bEnv, bUrl);
        const issued = (await sessionOnB.call("loopbackGateway.issueTicket", {})) as {
          ticket: Redacted.Redacted<string>;
          expiresAt: never;
        };
        const status = await environment.register({
          httpBaseUrl: bUrl,
          enabled: true,
          credential: issued,
        });
        checkEqual(status.state, "active", "D's forwarding state for B");
        const credentials = need(
          environment.proxyCredentials() ?? undefined,
          "the proxy's credentials",
        );
        const proxy = proxyEndpoint(credentials);

        // 1. The page, as `localhost` on B: the service sees a plain loopback request and nothing
        // of the proxy or the ticket.
        const page = await getViaProxy(proxy, service.port, "/");
        checkEqual(page.status, 200, "the page through the tunnel");
        check(
          page.body.includes("hello from the remote computer"),
          `unexpected page: ${page.body}`,
        );
        const headers = JSON.parse(
          (await getViaProxy(proxy, service.port, "/headers")).body,
        ) as Record<string, string>;
        checkEqual(headers.host, `localhost:${service.port}`, "the Host header the service saw");
        check(
          headers["authorization"] === undefined && headers["proxy-authorization"] === undefined,
          "neither the ticket nor the proxy password may reach the service",
        );

        // 2. A stream that stays open, and a WebSocket.
        const sse = await streamViaProxy(proxy, service.port, "/events");
        open.push(sse);
        checkEqual(sse.status, 200, "the event stream");
        await sse.waitFor(/data: one\n\ndata: two\n\ndata: three\n\n/u, "its three events");
        const socket = await webSocketViaProxy(proxy, service.port, "/ws");
        open.push(socket);
        socket.send("ping");
        checkEqual(await socket.next(), "echo:ping", "the WebSocket's echo");
        await service.events.waitFor(/sse-open[\s\S]*ws-open|ws-open[\s\S]*sse-open/u, {
          label: "the service to see both connections",
          timeoutMs: 30_000,
        });

        // 3. A listener no terminal started is refused, however it is asked.
        const refused = await getViaProxy(proxy, outside.port, "/");
        checkEqual(refused.status, 403, "the outside service's HTTP status");
        checkEqual(refused.headers["x-t3x-gateway-error"], "not-owned", "its error header");
        check(!refused.body.includes("secret"), "the outside service's data must not come through");
        const refusedConnect = await connectViaProxy(proxy, outside.port);
        refusedConnect.socket.destroy();
        checkEqual(refusedConnect.status, 403, "the outside service's CONNECT status");
        checkEqual(refusedConnect.gatewayError, "not-owned", "its CONNECT error header");
        check(
          events.some((event) => event.type === "denied" && event.code === "not-owned"),
          "the refused CONNECT is reported as a denial",
        );
        checkEqual(
          environment.status().state,
          "active",
          "a refused port leaves the environment active",
        );

        // 4. Removing D on B ends its session: the open tunnels close at both ends, and D gets no more.
        socket.send("again");
        checkEqual(await socket.next(), "echo:again", "the WebSocket just before the removal");
        const mark = service.events.mark();
        await b.refresh();
        await b.call("devices.remove", { deviceId: dId });
        await b.refresh();
        await Promise.all([
          failWithin(sse.closed, "the event stream to close", 60_000),
          failWithin(socket.closed, "the WebSocket to close", 60_000),
          service.events.waitFor(/sse-closed[\s\S]*ws-closed|ws-closed[\s\S]*sse-closed/u, {
            label: "the service to see both connections close",
            timeoutMs: 60_000,
            from: mark,
          }),
        ]);
        const after = await getViaProxy(proxy, service.port, "/");
        checkEqual(after.status, 503, "a request after the device was removed");
        checkEqual(after.headers["x-t3x-gateway-error"], "unauthorized", "its error header");
        checkEqual(environment.status().state, "rejected", "D's forwarding state after removal");
      } finally {
        for (const item of open) item.destroy();
        await Promise.allSettled([
          sessionOnB?.close(),
          environment.close(),
          service?.stop(),
          outside?.stop(),
          d.stop(),
        ]);
      }
    },
  },
  {
    id: 16,
    title:
      "with Caddy's access log switched on, the gateway ticket is masked there and absent from every log of the stack",
    timeoutMs: 180_000,
    run: async (world) => {
      const a = need(world.a, "A");
      const b = need(world.b, "B");
      const bEnv = need(world.bEnv, "B's environment");
      const bUrl = tunnelUrl(world, "b");
      checkNoAccessLogConfigured();
      await reachable(bUrl, bEnv, 90_000);

      // A real ticket (A's own session on B) and a made-up one, each sent in a tunnel upgrade through
      // Caddy and frps; nothing listens on the port, so B answers after it has accepted the ticket.
      const sessionOnB = await computerSignsIntoComputer(a, b, bEnv, bUrl);
      let accessLog: Awaited<ReturnType<typeof enableCaddyAccessLog>> | undefined;
      const reconnected = async (reload: () => Promise<unknown>) => {
        const marks = [a.log.mark(), b.log.mark()] as const;
        await reload();
        await Promise.all(
          [a, b].map((computer, index) =>
            computer.log.waitFor(LOGGED_IN, {
              label: `${computer.name}'s tunnel to come back after Caddy reloaded`,
              timeoutMs: 60_000,
              from: marks[index]!,
            }),
          ),
        );
        await reachable(bUrl, bEnv, 60_000);
      };
      try {
        const issued = (await sessionOnB.call("loopbackGateway.issueTicket", {})) as {
          ticket: Redacted.Redacted<string>;
        };
        const real = Redacted.value(issued.ticket);
        // A second ticket of the same session, never sent anywhere: what tickets share (§4.3).
        const reference = Redacted.value(
          ((await sessionOnB.call("loopbackGateway.issueTicket", {})) as typeof issued).ticket,
        );
        // Both segments random and independent, so every 12-character piece of it is unique.
        const sentinel = `${NodeCrypto.randomBytes(48).toString("base64url")}.${NodeCrypto.randomBytes(32).toString("base64url")}`;
        // A reload of Caddy drops the tunnels' control connections (they run through it): wait until
        // both computers' frpc are logged in again before sending anything through them.
        await reconnected(async () => {
          accessLog = await enableCaddyAccessLog(world.stack, world.ctx.workDir);
        });
        const upgrade = (ticket: string, port: number) =>
          httpRequest(`${bUrl}/api/loopback-gateway/tunnel?port=${port}`, {
            headers: {
              authorization: formatLoopbackGatewayAuthorization(ticket),
              connection: "Upgrade",
              upgrade: "websocket",
              "sec-websocket-version": "13",
              "sec-websocket-key": NodeCrypto.randomBytes(16).toString("base64"),
            },
          });
        const refused = await upgrade(sentinel, 9);
        checkEqual(refused.status, 401, "an upgrade with a made-up ticket");
        const accepted = await upgrade(real, 9);
        checkEqual(accepted.status, 502, "an upgrade with a real ticket to a closed port");

        const logs = await stackLogs(world.stack);
        // The access log is on, and it names the request but not what authorised it.
        check(
          /"uri":"\/api\/loopback-gateway\/tunnel\?port=9"/u.test(logs.caddy),
          `Caddy logged no access line for the upgrade:\n${logs.caddy.slice(-1500)}`,
        );
        check(
          /"Authorization":\["REDACTED"\]/u.test(logs.caddy),
          "Caddy's access log must show Authorization as REDACTED",
        );
        for (const [name, text] of Object.entries(logs)) {
          for (const [what, secret] of [
            ["the made-up ticket", sentinel],
            ["the real ticket", real],
          ] as const) {
            const found = findSecret(text, secret, {
              references: secret === real ? [reference] : [],
            });
            check(
              found === undefined,
              `${what} (or a piece of 12 or more characters of it) is in ${name}'s log: ${text
                .split("\n")
                .find((line) => line.includes(found!))
                ?.replaceAll(found!, "<HERE>")}`,
            );
          }
        }
        check(!/authorization/iu.test(logs.frps.replaceAll(/\s+/gu, " ")), "frps printed a header");
        say(
          `  access line seen, Authorization masked; ticket absent from ${Object.keys(logs).join(", ")} (${Object.values(logs).reduce((n, text) => n + text.length, 0)} bytes)`,
        );
      } finally {
        await Promise.allSettled([
          accessLog === undefined ? undefined : reconnected(accessLog.restore),
          sessionOnB.close(),
        ]);
      }
    },
  },
  {
    id: 7,
    title: "removing B while it runs: t3x:revoked, B leaves, its address answers 404",
    timeoutMs: 300_000,
    run: async (world) => {
      const b = need(world.b, "B");
      const watcher = await b.watch();
      await watcher.waitFor(
        "B's tunnel",
        120_000,
        (s) => s.status.state === "joined" && s.status.tunnel.status === "connected",
      );
      // B's own sync is every 60 s and frpc's heartbeat every 30 s. Removing B right after a sync
      // gives the heartbeat the whole minute to be first to notice, so the rejection shows.
      const current = watcher.latest?.status.fetchedAt ?? null;
      await watcher.nextSync(current, 120_000);
      const mark = b.log.mark();
      await world.stack.revoke("B");
      await b.log.waitFor(rejection("revoked"), {
        label: "frpc to report t3x:revoked",
        timeoutMs: 90_000,
        from: mark,
      });
      // "removed", not "not_joined": the registry told B it is no longer a member. Its membership,
      // key and address are cleared and the tunnel is off; joining again clears the state.
      // The tunnel stops a moment after the state flips, so the end state is one snapshot, not the first.
      await watcher.waitFor(
        "B to leave the server and stop its tunnel",
        60_000,
        (s) =>
          s.status.state === "removed" &&
          s.status.url === null &&
          s.status.tunnel.status === "disabled",
      );
      const response = await until(
        {
          label: "B's address to answer 404",
          timeoutMs: 60_000,
          reason: "frps drops the proxy when frpc stops, which raises no event",
        },
        async () => {
          const result = await httpRequest(`${tunnelUrl(world, "b")}/`);
          return result.status === 404 ? result : undefined;
        },
      );
      check(response.status === 404, "frps answers 404 for a removed computer");
    },
  },
  {
    id: 10,
    title: "the server is offline: a phone still logs in over the LAN with its cached list",
    timeoutMs: 240_000,
    run: async (world) => {
      const a = need(world.a, "A");
      const phone = need(world.phone2, "Phone2");
      const cachedA = phone.cached.find(
        (device) => device.kind === "computer" && device.name === "A",
      );
      const aEnv = need(cachedA?.environmentId, "A's environment id in the phone's cached list");

      let syncedBeforeOutage: number | null = null;
      await world.stack.compose("stop", "registry", "caddy");
      try {
        // A failed sync is not an error: A keeps its last list and says so in its log.
        const syncedAt = (await a.status()).fetchedAt;
        const mark = a.log.mark();
        const during = await a.refresh();
        checkEqual(during.fetchedAt, syncedAt, "the last-sync time while the server is down");
        await a.log.waitFor(/Device list sync failed; keeping the last list/u, {
          label: "A to log the failed sync",
          timeoutMs: 15_000,
          from: mark,
        });
        syncedBeforeOutage = syncedAt;

        const { accessToken } = await phone.login(a.mainOrigin, aEnv);
        const connection = await openRpc(await phone.webSocketUrl(a.mainOrigin, accessToken));
        try {
          await connection.call("server.probe");
        } finally {
          await connection.close();
        }
      } finally {
        await world.stack.compose("start", "registry", "caddy");
      }
      await until(
        {
          label: "the server to answer again",
          timeoutMs: 90_000,
          reason: "the containers' readiness raises no event here",
        },
        async () =>
          (await httpRequest(`${world.stack.origin}/v1/info`)).status === 200 ? true : undefined,
      );
      await until(
        {
          label: "A to sync with the server again",
          timeoutMs: 90_000,
          reason: "the registry and Caddy have no readiness signal to subscribe to",
        },
        async () =>
          ((await a.refresh()).fetchedAt ?? 0) > (syncedBeforeOutage ?? 0) ? true : undefined,
      );
      await reachable(tunnelUrl(world, "a"), aEnv, 120_000);
      // Caddy came back with an empty certificate cache. A is registered, so it gets its certificate
      // again; B was removed in scenario 7, so the registry refuses it and the handshake fails.
      const removed = await handshake(`b.${DOMAIN}`, world.stack.port);
      check(!removed.ok, "after a Caddy restart the removed computer's name gets no certificate");
    },
  },
  {
    id: 14,
    title:
      "a forged X-T3x-Client-IP is ignored on the main port and overwritten by Caddy on the tunnel",
    timeoutMs: 120_000,
    run: async (world) => {
      const a = need(world.a, "A");
      const phone = need(world.phone2, "Phone2");
      const wrongAudience = () =>
        phone.pass({ audienceEnvironmentId: need(world.bEnv, "B's environment") });

      // Main listener: a client on loopback is not counted, whatever the header says.
      const main: Array<number> = [];
      for (let i = 0; i < 25; i += 1) {
        main.push(
          (
            await phone.exchange(a.mainOrigin, wrongAudience(), {
              headers: { "x-t3x-client-ip": "1.2.3.4" },
            })
          ).status,
        );
      }
      check(
        main.every((status) => status === 401),
        `the main port counted a forged address: ${main.join(",")}`,
      );

      // Tunnel: a new forged address on every request, and still one bucket: the one Caddy writes.
      const aUrl = tunnelUrl(world, "a");
      const tunnel: Array<number> = [];
      let retryAfter: string | undefined;
      for (let i = 1; i <= 25 && !tunnel.includes(429); i += 1) {
        const response = await phone.exchange(aUrl, wrongAudience(), {
          headers: { "x-t3x-client-ip": `10.9.${i}.${i}` },
        });
        tunnel.push(response.status);
        retryAfter = response.headers["retry-after"] as string | undefined;
      }
      check(
        tunnel.includes(429),
        `no lock-out after ${tunnel.length} failures with changing forged addresses: ${tunnel.join(",")}`,
      );
      check(retryAfter !== undefined, "the 429 carries retry-after");
      say(
        `  main port: 25 forged failures, all 401; tunnel: ${tunnel.join(",")} (retry-after ${retryAfter})`,
      );
    },
  },
  {
    id: 17,
    optional: true,
    title:
      "module-graph fetch time of 300 modules through the tunnel, without a browser (research/remote-loopback-forwarding.md 11.1)",
    timeoutMs: 900_000,
    run: async (world) => {
      const a = need(world.a, "A");
      const b = need(world.b, "B");
      const bEnv = need(world.bEnv, "B's environment");
      const bUrl = tunnelUrl(world, "b");
      await reachable(bUrl, bEnv, 90_000);
      const RUNS = 20;
      // Each delayed run takes seconds, so the delayed paths get fewer; their p95 is then nearly the worst run.
      const DELAYED_RUNS = 10;
      const service = await startServiceInTerminal(world.ctx, b, "first-paint");
      const sessionOnB = await computerSignsIntoComputer(a, b, bEnv, bUrl);
      const relays: Array<LatencyRelay> = [];
      try {
        interface Group {
          readonly label: string;
          readonly route: "direct" | "straight" | "local" | "tunnel";
          readonly rttMs: number;
        }
        const groups: ReadonlyArray<Group> = [
          { label: "direct loopback (no proxy, no gateway)", route: "direct", rttMs: 0 },
          { label: "gateway to B's own port (same machine)", route: "local", rttMs: 0 },
          { label: "self-hosted tunnel (Caddy + frps, local)", route: "tunnel", rttMs: 0 },
          {
            label: "no gateway, straight to the service, 50 ms round trip",
            route: "straight",
            rttMs: 50,
          },
          { label: "self-hosted tunnel, 50 ms round trip", route: "tunnel", rttMs: 50 },
          {
            label: "no gateway, straight to the service, 100 ms round trip",
            route: "straight",
            rttMs: 100,
          },
          { label: "self-hosted tunnel, 100 ms round trip", route: "tunnel", rttMs: 100 },
        ];
        interface Row {
          readonly group: Group;
          readonly runs: number;
          readonly firstResponse: ReturnType<typeof stats>;
          readonly graph: ReturnType<typeof stats>;
          readonly tunnelsPerLoad: number;
          readonly setup: ReturnType<typeof stats> | undefined;
          readonly socketRtt: ReturnType<typeof stats> | undefined;
          readonly tunnelsOpened: number;
        }
        const rows: Array<Row> = [];
        for (const group of groups) {
          const firstResponses: Array<number> = [];
          const graphs: Array<number> = [];
          const tunnelCounts: Array<number> = [];
          const setups: Array<number> = [];
          const socketRtts: Array<number> = [];
          const runs = group.rttMs > 0 ? DELAYED_RUNS : RUNS;
          if (group.route === "direct" || group.route === "straight") {
            const relay =
              group.route === "straight"
                ? await startLatencyRelay(service.port, group.rttMs)
                : undefined;
            if (relay !== undefined) relays.push(relay);
            for (let run = 0; run < runs; run += 1) {
              const fetcher = keepAliveFetcher({
                host: "127.0.0.1",
                port: relay?.port ?? service.port,
              });
              const load = await loadModuleGraph(fetcher.fetchPath);
              fetcher.close();
              firstResponses.push(load.firstResponseMs);
              graphs.push(load.graphMs);
            }
          } else {
            const relay =
              group.rttMs > 0 ? await startLatencyRelay(world.stack.port, group.rttMs) : undefined;
            if (relay !== undefined) relays.push(relay);
            const baseUrl =
              group.route === "local"
                ? `http://127.0.0.1:${b.mainPort}`
                : relay === undefined
                  ? bUrl
                  : `https://b.${DOMAIN}:${relay.port}`;
            const issued = (await sessionOnB.call("loopbackGateway.issueTicket", {})) as {
              ticket: Redacted.Redacted<string>;
              expiresAt: never;
            };
            for (let run = 0; run < runs; run += 1) {
              const opened: Array<number> = [];
              const environment = makeGatewayEnvironment({
                environmentId: bEnv,
                emit: () => {},
                onProxyChange: async () => {},
                openTunnel: async (input) => {
                  const began = performance.now();
                  const tunnel = await openLoopbackTunnel(input);
                  opened.push(performance.now() - began);
                  return tunnel;
                },
              });
              try {
                await environment.register({
                  httpBaseUrl: baseUrl,
                  enabled: true,
                  credential: issued,
                });
                const proxy = proxyEndpoint(
                  need(environment.proxyCredentials() ?? undefined, "the proxy's credentials"),
                );
                const fetcher = keepAliveFetcher({
                  host: "127.0.0.1",
                  port: proxy.port,
                  viaProxy: {
                    authorization: proxy.authorization,
                    target: `http://localhost:${service.port}`,
                  },
                });
                const load = await loadModuleGraph(fetcher.fetchPath);
                fetcher.close();
                firstResponses.push(load.firstResponseMs);
                graphs.push(load.graphMs);
                tunnelCounts.push(opened.length);
                setups.push(...opened);
                // A WebSocket's round trip on a fresh tunnel is what a hot-update message waits for.
                const socket = await webSocketViaProxy(proxy, service.port, "/ws");
                const sent = performance.now();
                socket.send("hmr");
                await socket.next();
                socketRtts.push(performance.now() - sent);
                socket.destroy();
              } finally {
                await environment.close();
              }
            }
          }
          rows.push({
            group,
            runs,
            firstResponse: stats(firstResponses),
            graph: stats(graphs),
            tunnelsPerLoad: tunnelCounts.length === 0 ? 0 : stats(tunnelCounts).median,
            setup: setups.length === 0 ? undefined : stats(setups),
            socketRtt: socketRtts.length === 0 ? undefined : stats(socketRtts),
            tunnelsOpened: setups.length,
          });
          say(
            `  ${group.label}: graph median ${rows.at(-1)!.graph.median.toFixed(0)} ms, p95 ${rows.at(-1)!.graph.p95.toFixed(0)} ms`,
          );
        }

        // How much of a tunnel's set-up was B's own check of who owns the port (its trace file).
        const authorize = readServerSpans(b.home, ["LoopbackGateway.authorize"]).map(
          (span) => span.durationMs,
        );
        const lines = [
          "| path | runs | first response median / p95 (ms) | whole graph median / p95 (ms) | tunnels per load | tunnel set-up median / p95 (ms) | WebSocket echo median (ms) |",
          "| ---- | ---- | ---- | ---- | ---- | ---- | ---- |",
          ...rows.map(
            (row) =>
              `| ${row.group.label} | ${row.runs} | ${row.firstResponse.median.toFixed(0)} / ${row.firstResponse.p95.toFixed(0)} | ${row.graph.median.toFixed(0)} / ${row.graph.p95.toFixed(0)} | ${row.tunnelsPerLoad || "-"} | ${row.setup === undefined ? "-" : `${row.setup.median.toFixed(0)} / ${row.setup.p95.toFixed(0)}`} | ${row.socketRtt === undefined ? "-" : row.socketRtt.median.toFixed(0)} |`,
          ),
        ];
        const authorizeStats = authorize.length === 0 ? undefined : stats(authorize);
        const row = (route: Group["route"], rttMs: number) =>
          need(
            rows.find(
              (candidate) => candidate.group.route === route && candidate.group.rttMs === rttMs,
            ),
            `${route} at ${rttMs} ms`,
          );
        lines.push(
          "",
          `The page is /m/0.js and the 299 modules it leads to (about 4 KB each), fetched breadth first over at most six connections, no browser. The tunnel paths open a fresh gateway (cold: no tunnel yet) for every run.`,
          authorizeStats === undefined
            ? "B's own port check: no spans found in B's trace file."
            : `B's port check (LoopbackGateway.authorize, ${authorizeStats.n} spans, all paths): median ${authorizeStats.median.toFixed(1)} ms, p95 ${authorizeStats.p95.toFixed(1)} ms.`,
        );
        for (const rtt of [50, 100]) {
          const tunnel = row("tunnel", rtt);
          const straight = row("straight", rtt);
          const extra = tunnel.graph.median - straight.graph.median;
          const setup = tunnel.setup?.median ?? 0;
          const withoutCheck = Math.max(0, setup - (authorizeStats?.median ?? 0));
          lines.push(
            `${rtt} ms round trip: fetching the module graph through the tunnel takes ${extra.toFixed(0)} ms more than reaching the service directly over the same round trip (the gateway's own share; no threshold is applied). A tunnel takes ${(setup / rtt).toFixed(1)} round trips to set up, ${(withoutCheck / rtt).toFixed(1)} without B's port check.`,
          );
        }
        NodeFS.writeFileSync(
          NodePath.join(world.ctx.workDir, "first-paint.md"),
          `${lines.join("\n")}\n`,
        );
        for (const line of lines) say(line);
        say(`  written to ${NodePath.join(world.ctx.workDir, "first-paint.md")}`);
      } finally {
        await Promise.allSettled([
          sessionOnB.close(),
          service.stop(),
          ...relays.map((relay) => relay.close()),
        ]);
      }
    },
  },
];
