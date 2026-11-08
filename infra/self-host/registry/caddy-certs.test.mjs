// The real Caddyfile (ACME issuers, no local_certs) in a real Caddy: which names does it put to `ask`? Caddyfile.test cannot
// stand in: with local_certs Caddy merges the policies and ntfy.<domain> lands under the on-demand one by accident (FORK.md).
// ACME cannot reach any CA here (the container's DNS points nowhere), so the observable is the question asked, not the certificate.
// Needs docker and openssl; without docker the file is skipped, and with CI set it fails.
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
const MANUAL_SITE = "manual.example.net";
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

/** The registry's own ask handler on an ephemeral port: computer "a" is registered. `asked` lists the names it was asked about. */
async function startAsk(ntfyInstalled) {
  const store = { hasRegisteredSubdomain: (label) => label === "a" };
  const server = createAskServer({ store, config: { domain: DOMAIN, ntfyInstalled } });
  const asked = [];
  const waiting = new Map();
  server.on("request", (req) => {
    const domain = new URL(req.url ?? "/", "http://ask.invalid").searchParams.get("domain");
    if (domain === null) return;
    asked.push(domain);
    waiting.get(domain)?.();
  });
  await new Promise((resolve) => server.listen(0, "0.0.0.0", resolve));
  /** Resolves when Caddy has put the question about `name`. */
  const questionAbout = (name) =>
    new Promise((resolve) => {
      if (asked.includes(name)) resolve();
      else waiting.set(name, resolve);
    });
  return { server, asked, questionAbout, port: server.address().port };
}

/** A site with certificate files of its own, the way a certbot certificate is used. */
function writeManualCertificate(sites) {
  const result = NodeChildProcess.spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "ec",
      "-pkeyopt",
      "ec_paramgen_curve:prime256v1",
      "-nodes",
      "-keyout",
      NodePath.join(sites, "manual-key.pem"),
      "-out",
      NodePath.join(sites, "manual-cert.pem"),
      "-days",
      "2",
      "-subj",
      `/CN=${MANUAL_SITE}`,
      "-addext",
      `subjectAltName=DNS:${MANUAL_SITE}`,
    ],
    { encoding: "utf8" },
  );
  assert.equal(result.status, 0, `openssl is needed for these checks: ${result.stderr}`);
  NodeFS.writeFileSync(
    NodePath.join(sites, "manual.caddy"),
    `${MANUAL_SITE} {\n\ttls /etc/caddy/sites/manual-cert.pem /etc/caddy/sites/manual-key.pem\n\trespond manual\n}\n`,
  );
}

/** An IP site with Caddy's own CA, and the default_sni a browser that opens the IP needs. */
function writeIpSite(sites) {
  NodeFS.writeFileSync(
    NodePath.join(sites, "ip.caddy"),
    `${IP_SITE} {\n\ttls internal\n\trespond ip\n}\n`,
  );
  NodeFS.writeFileSync(NodePath.join(sites, "ip.options"), `default_sni ${IP_SITE}\n`);
}

/**
 * Runs the real Caddyfile (and the real ntfy and e-mail snippets) over a sites directory that `fill` fills, until Caddy has
 * served what it can serve locally, calls `body(port)`, and always removes the container.
 */
async function withCaddy({ askPort, fill, waitForIpSite }, body) {
  const sites = NodePath.join(work, `sites-${NodeCrypto.randomUUID()}`);
  NodeFS.mkdirSync(sites);
  fill(sites);
  const name = `t3x-certs-test-${NodeCrypto.randomUUID().slice(0, 8)}`;
  const caddy = NodeChildProcess.spawn(
    "docker",
    [
      "run",
      "--rm",
      "--name",
      name,
      // No resolver: ACME cannot reach a CA, so nothing outside this machine is ever contacted.
      "--dns",
      "127.0.0.1",
      "--add-host",
      "host.docker.internal:host-gateway",
      "-p",
      "127.0.0.1::443",
      "-e",
      `T3X_DOMAIN=${DOMAIN}`,
      "-e",
      `T3X_REGISTRY_ASK=host.docker.internal:${askPort}`,
      "-v",
      `${NodePath.join(SELF_HOST, "Caddyfile")}:/etc/caddy/Caddyfile:ro`,
      "-v",
      `${NodePath.join(SELF_HOST, "caddy/ntfy.caddy")}:/etc/caddy/ntfy.caddy:ro`,
      "-v",
      `${NodePath.join(SELF_HOST, "caddy/acme-email-off.caddy")}:/etc/caddy/acme-email.caddy:ro`,
      "-v",
      `${sites}:/etc/caddy/sites:ro`,
      CADDY_IMAGE,
      // A test run that is killed cannot remove its container; this makes the container remove itself.
      "timeout",
      "90",
      "caddy",
      "run",
      "--config",
      "/etc/caddy/Caddyfile",
      "--adapter",
      "caddyfile",
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    // The log says when the server is up (and the IP site's certificate, which Caddy's own CA issues locally).
    await new Promise((resolve, reject) => {
      let log = "";
      const ready = () =>
        log.includes('"msg":"serving initial configuration"') &&
        (!waitForIpSite ||
          log.includes(`"msg":"certificate obtained successfully","identifier":"${IP_SITE}"`));
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
    // Under load the daemon can refuse a first removal; the container's own timeout is the backstop.
    for (let attempt = 0; attempt < 3 && docker(["rm", "-f", name]).status !== 0; attempt += 1) {
      if (docker(["ps", "-aq", "--filter", `name=${name}`]).stdout.trim() === "") break;
    }
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

/**
 * Handshakes for these names, one after the other. A name that is on-demand blocks the handshake while Caddy tries to obtain
 * its certificate (here it never can), so the handshake is abandoned once Caddy has asked about it.
 */
async function handshakes(ask, port, names) {
  for (const name of names) {
    const abandon = ask.questionAbout(name).then(() => ({ ok: false, message: "asked" }));
    await Promise.race([handshake(port, name), abandon]);
  }
}

if (hasDocker) {
  describe("the real Caddyfile's certificate policies", () => {
    for (const [layout, fill, waitForIpSite] of [
      ["an empty sites directory", () => {}, false],
      [
        "a site with its own certificate files and an IP site",
        (sites) => {
          writeManualCertificate(sites);
          writeIpSite(sites);
        },
        true,
      ],
    ]) {
      it(`${layout}: ntfy and computer names are put to ask, the apex is managed in advance`, async () => {
        const ask = await startAsk(true);
        try {
          await withCaddy({ askPort: ask.port, fill, waitForIpSite }, async (port) => {
            await handshakes(ask, port, [
              `ntfy.${DOMAIN}`,
              `a.${DOMAIN}`,
              `evil.${DOMAIN}`,
              DOMAIN,
            ]);
            // ntfy.<domain> must be on-demand like a computer's name: a managed name never reaches ask and, being
            // under the wildcard, is not obtained at startup either, so it would never get a certificate.
            assert.deepEqual(ask.asked.toSorted(), [
              `a.${DOMAIN}`,
              `evil.${DOMAIN}`,
              `ntfy.${DOMAIN}`,
            ]);
          });
        } finally {
          ask.server.close();
        }
      });
    }

    it("a site's own certificate files are served, and default_sni still finds the IP site's certificate", async () => {
      const ask = await startAsk(true);
      try {
        await withCaddy(
          {
            askPort: ask.port,
            fill: (sites) => {
              writeManualCertificate(sites);
              writeIpSite(sites);
            },
            waitForIpSite: true,
          },
          async (port) => {
            const manual = await handshake(port, MANUAL_SITE);
            assert.ok(manual.ok, manual.message);
            assert.ok(manual.names.includes(`DNS:${MANUAL_SITE}`), manual.names);
            const noSni = await handshake(port, undefined);
            assert.ok(noSni.ok, noSni.message);
            assert.ok(noSni.names.includes(`IP Address:${IP_SITE}`), noSni.names);
            assert.deepEqual(ask.asked, [], "neither is an on-demand name");
          },
        );
      } finally {
        ask.server.close();
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
