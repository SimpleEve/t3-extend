// Which names get a certificate from a real Caddy running Caddyfile.test (its own CA, loopback only), with the real
// `ask` handler answering Caddy's questions. The e2e stack cannot show this for ntfy: its domain is *.localhost, which
// Caddy treats differently from a public name. Needs docker; without it the file is skipped, and with CI set it fails.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeTls from "node:tls";
import * as NodeURL from "node:url";

import { createAskServer } from "./ask.mjs";

const assert = NodeAssert;
const { describe, it, after, before } = NodeTest;

const SELF_HOST = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const DOMAIN = "t3.example.org";
const IP_SITE = "203.0.113.7";
const docker = (args) => NodeChildProcess.spawnSync("docker", args, { encoding: "utf8" });
const hasDocker = docker(["version", "--format", "{{.Server.Version}}"]).status === 0;
const CADDY_IMAGE = /^\s+image:\s*(caddy:\S+)$/m.exec(
  NodeFS.readFileSync(NodePath.join(SELF_HOST, "docker-compose.yml"), "utf8"),
)?.[1];

let work;
before(() => {
  work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-certs-test-"));
});
after(() => NodeFS.rmSync(work, { recursive: true, force: true }));

/** The registry's own ask handler on an ephemeral port: computer "a" is registered, nothing else is. */
async function startAsk(ntfyInstalled) {
  const store = { hasRegisteredSubdomain: (label) => label === "a" };
  const server = createAskServer({ store, config: { domain: DOMAIN, ntfyInstalled } });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  return server;
}

/** Runs Caddyfile.test until it has served its first certificate, calls `body(port)`, and always removes the container. */
async function withCaddy(askPort, body) {
  const sites = NodePath.join(work, `sites-${NodeCrypto.randomUUID()}`);
  NodeFS.mkdirSync(sites);
  NodeFS.writeFileSync(
    NodePath.join(sites, "ip.caddy"),
    `${IP_SITE} {\n\ttls internal\n\trespond ip\n}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(sites, "ip.options"), `default_sni ${IP_SITE}\n`);
  const name = `t3x-certs-test-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const caddy = NodeChildProcess.spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      "127.0.0.1::443",
      "-e",
      `T3X_DOMAIN=${DOMAIN}`,
      "-e",
      `T3X_REGISTRY_ASK=host.docker.internal:${askPort}`,
      "-v",
      `${NodePath.join(SELF_HOST, "Caddyfile.test")}:/etc/caddy/Caddyfile:ro`,
      "-v",
      `${NodePath.join(SELF_HOST, "caddy/ntfy.caddy")}:/etc/caddy/ntfy.caddy:ro`,
      "-v",
      `${sites}:/etc/caddy/sites:ro`,
      CADDY_IMAGE,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    // The apex and the IP site are obtained at startup; the log says when, so nothing here sleeps.
    await new Promise((resolve, reject) => {
      let log = "";
      const ready = () =>
        [DOMAIN, IP_SITE].every((id) =>
          log.includes(`"msg":"certificate obtained successfully","identifier":"${id}"`),
        );
      const onData = (chunk) => {
        log += chunk;
        if (ready()) resolve(undefined);
      };
      caddy.stdout.on("data", onData);
      caddy.stderr.on("data", onData);
      caddy.once("exit", () => reject(new Error(`caddy exited before it was ready:\n${log}`)));
    });
    const mapped = docker(["port", name, "443/tcp"]).stdout.trim().split("\n")[0];
    return await body(Number(mapped.slice(mapped.lastIndexOf(":") + 1)));
  } finally {
    docker(["rm", "-f", name]);
  }
}

/** The certificate's alternative names for a client that sends `servername`, or the handshake error. */
const handshake = (port, servername) =>
  new Promise((resolve) => {
    const socket = NodeTls.connect(
      { host: "127.0.0.1", port, rejectUnauthorized: false, ...(servername ? { servername } : {}) },
      () => {
        const names = socket.getPeerCertificate().subjectaltname ?? "";
        socket.end();
        resolve({ ok: true, names });
      },
    );
    socket.once("error", (error) => resolve({ ok: false, message: error.message }));
  });

if (hasDocker) {
  describe("which names get a certificate", () => {
    it("with the push server installed: ntfy and registered computers, not other names", async () => {
      const ask = await startAsk(true);
      try {
        await withCaddy(ask.address().port, async (port) => {
          const ntfy = await handshake(port, `ntfy.${DOMAIN}`);
          assert.ok(ntfy.ok, `ntfy.${DOMAIN}: ${ntfy.message}`);
          assert.ok(ntfy.names.includes(`DNS:ntfy.${DOMAIN}`), ntfy.names);
          const computer = await handshake(port, `a.${DOMAIN}`);
          assert.ok(computer.ok, `a.${DOMAIN}: ${computer.message}`);
          assert.ok((await handshake(port, DOMAIN)).ok, "the apex is not an on-demand name");
          for (const refused of ["evil", "www", "registry"]) {
            const result = await handshake(port, `${refused}.${DOMAIN}`);
            assert.equal(result.ok, false, `${refused}.${DOMAIN} must not get a certificate`);
            assert.match(result.message, /alert internal error/);
          }
          // default_sni from a *.options file still finds the IP site's certificate for a client without SNI.
          const noSni = await handshake(port, undefined);
          assert.ok(noSni.ok, noSni.message);
          assert.ok(noSni.names.includes(`IP Address:${IP_SITE}`), noSni.names);
        });
      } finally {
        ask.close();
      }
    });

    it("without the push server: ntfy is refused like any other unregistered name", async () => {
      const ask = await startAsk(false);
      try {
        await withCaddy(ask.address().port, async (port) => {
          assert.equal((await handshake(port, `ntfy.${DOMAIN}`)).ok, false);
          assert.ok((await handshake(port, `a.${DOMAIN}`)).ok);
        });
      } finally {
        ask.close();
      }
    });
  });
} else if (process.env.CI) {
  it("needs docker for the certificate checks", () => {
    assert.fail("CI is set but docker is not usable, so these checks cannot run");
  });
} else {
  it("needs docker for the certificate checks", { skip: "docker is not available here" }, () => {});
}
