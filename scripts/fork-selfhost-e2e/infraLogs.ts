// @effect-diagnostics nodeBuiltinImport:off - reads the checked-in Caddy and frps configuration.
// The infrastructure half of "the tunnel ticket is in no log" (research/remote-loopback-forwarding.md
// 4.3, 12 9.4): the production configuration keeps no access log, and with one switched on for
// the length of a test Caddy masks `Authorization`, while frps never prints a header.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { Stack } from "./stack.ts";
import { check, E2eFailure } from "./util.ts";

const SELF_HOST = NodePath.resolve(import.meta.dirname, "../../infra/self-host");
const CADDY_CONFIG_IN_CONTAINER = "/tmp/Caddyfile.accesslog";

const read = (file: string): string => NodeFS.readFileSync(NodePath.join(SELF_HOST, file), "utf8");

/** What no checked-in configuration may contain: an access log, or the switch that unmasks credentials. */
export function checkNoAccessLogConfigured(): void {
  for (const file of ["Caddyfile", "Caddyfile.test", "caddy/ntfy.caddy", "caddy/ntfy-off.caddy"]) {
    const offending = read(file)
      .split("\n")
      .map((line) => line.replace(/#.*$/u, "").trim())
      .filter((line) => /^(log|log_credentials|log_skip|log_append|log_name)\b/u.test(line));
    check(
      offending.length === 0,
      `${file} turns logging on or off for requests (${offending.join("; ")}); the test below assumes the default of none`,
    );
    check(!/\bcredentials\b/u.test(read(file)), `${file} must not unmask credentials in logs`);
  }
  const frps = read("frps.toml");
  check(
    /^log\.level\s*=\s*"(info|warn|error)"/mu.test(frps),
    "frps.toml must log at info or above in this stack",
  );
}

/** `Caddyfile.test` with an access log (Caddy's defaults: JSON, no credentials) in each site block. */
export function accessLogCaddyfile(): string {
  const source = read("Caddyfile.test");
  const sites = source.match(/^(\{\$T3X_DOMAIN\}|https:\/\/) \{$/gmu) ?? [];
  check(sites.length === 2, `expected two site blocks in Caddyfile.test, found ${sites.length}`);
  return source.replace(
    /^(\{\$T3X_DOMAIN\}|https:\/\/) \{$/gmu,
    (opening) => `${opening}\n\tlog {\n\t\toutput stdout\n\t}`,
  );
}

/** Loads the access-log configuration into the running Caddy (the on-disk Caddyfile is untouched). */
export async function enableCaddyAccessLog(
  stack: Stack,
  workDir: string,
): Promise<{ readonly restore: () => Promise<void> }> {
  const local = NodePath.join(workDir, "Caddyfile.accesslog");
  NodeFS.writeFileSync(local, accessLogCaddyfile());
  const copied = await stack.compose("cp", local, `caddy:${CADDY_CONFIG_IN_CONTAINER}`);
  check(copied.status === 0, `docker compose cp failed: ${copied.stderr}`);
  const reload = async (path: string, adapter: boolean) => {
    const result = await stack.compose(
      "exec",
      "-T",
      "caddy",
      "caddy",
      "reload",
      "--config",
      path,
      ...(adapter ? ["--adapter", "caddyfile"] : []),
      "--force",
    );
    check(result.status === 0, `caddy reload ${path} failed: ${result.stderr}`);
  };
  await reload(CADDY_CONFIG_IN_CONTAINER, true);
  return { restore: () => reload("/etc/caddy/Caddyfile", true) };
}

/** Every line every service of the stack has printed so far. */
export async function stackLogs(stack: Stack): Promise<{
  readonly caddy: string;
  readonly frps: string;
  readonly registry: string;
}> {
  const one = async (service: string) => {
    const result = await stack.compose("logs", "--no-color", "--no-log-prefix", service);
    if (result.status !== 0)
      throw new E2eFailure(`docker compose logs ${service}: ${result.stderr}`);
    return result.stdout + result.stderr;
  };
  return { caddy: await one("caddy"), frps: await one("frps"), registry: await one("registry") };
}

/**
 * The secret, or any run of `window` characters of its last dot-separated part (a signed ticket's
 * signature, which is random; its header and the start of its payload are shared by every ticket
 * the server signs, and would match other tickets' lines).
 */
export function findSecret(text: string, secret: string, window = 12): string | undefined {
  if (text.includes(secret)) return secret;
  const random = secret.slice(secret.lastIndexOf(".") + 1);
  for (let at = 0; at + window <= random.length; at += 1) {
    const piece = random.slice(at, at + window);
    if (text.includes(piece)) return piece;
  }
  return undefined;
}
