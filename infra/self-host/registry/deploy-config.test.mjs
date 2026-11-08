// Static checks of the two ways to install: `docker compose config` for each file combination, and `caddy adapt` of the
// Caddyfiles with and without an e-mail, with the host-network upstreams, and with files in the sites directory.
// Needs docker (the Caddy image is the one docker-compose.yml pins); without it the file is skipped, as in the Alpine image.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const assert = NodeAssert;
const { describe, it, after, before } = NodeTest;

const SELF_HOST = NodePath.join(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const read = (file) => NodeFS.readFileSync(NodePath.join(SELF_HOST, file), "utf8");
const docker = (args) =>
  NodeChildProcess.spawnSync("docker", args, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
const hasDocker = docker(["compose", "version"]).status === 0;
const CADDY_IMAGE = /^\s+image:\s*(caddy:\S+)$/m.exec(read("docker-compose.yml"))?.[1];

let work;
before(() => {
  work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-config-test-"));
});
after(() => NodeFS.rmSync(work, { recursive: true, force: true }));

/** `docker compose config` as JSON for these compose files (relative to this directory). */
function composeConfig(files, env = "") {
  const envFile = NodePath.join(work, "compose.env");
  NodeFS.writeFileSync(
    envFile,
    `T3X_DOMAIN=t3.example.com\nT3X_PUBLIC_ORIGIN=https://t3.example.com\n${env}`,
  );
  const result = docker([
    "compose",
    "--project-directory",
    SELF_HOST,
    "--env-file",
    envFile,
    ...files.flatMap((file) => ["-f", NodePath.join(SELF_HOST, file)]),
    "--profile",
    "ntfy",
    "config",
    "--format",
    "json",
  ]);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

/** The hash compose gives Caddy's definition: when it changes, `up` recreates the container. */
function caddyHash(files, env) {
  const envFile = NodePath.join(work, "hash.env");
  NodeFS.writeFileSync(
    envFile,
    `T3X_DOMAIN=t3.example.com\nT3X_PUBLIC_ORIGIN=https://t3.example.com\n${env}`,
  );
  const result = docker([
    "compose",
    "--project-directory",
    SELF_HOST,
    "--env-file",
    envFile,
    ...files.flatMap((file) => ["-f", NodePath.join(SELF_HOST, file)]),
    "config",
    "--hash",
    "caddy",
  ]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

const published = (service) =>
  (service.ports ?? []).map((p) => ({
    ip: p.host_ip,
    host: Number(p.published),
    target: p.target,
  }));

/**
 * `caddy adapt` of the configuration directory that caddy/conf.sh writes and of a sites directory (with these files in it),
 * mounted where docker-compose.yml puts them. Returns the JSON text of the result.
 */
function adapt({ test = false, ntfy = true, email, env = {}, sites = {} }) {
  const dir = NodeFS.mkdtempSync(NodePath.join(work, "adapt-"));
  const sitesDir = NodePath.join(dir, "sites");
  NodeFS.mkdirSync(sitesDir);
  for (const [name, text] of Object.entries(sites))
    NodeFS.writeFileSync(NodePath.join(sitesDir, name), text);
  // The configuration directory exactly as setup.sh makes it.
  const confDir = NodePath.join(dir, "conf");
  const written = NodeChildProcess.spawnSync(
    "bash",
    [
      NodePath.join(SELF_HOST, "caddy/conf.sh"),
      confDir,
      ...(test ? ["--test"] : []),
      ...(ntfy ? ["--ntfy"] : []),
      ...(email === undefined ? [] : ["--email", email]),
    ],
    { encoding: "utf8" },
  );
  assert.equal(written.status, 0, written.stderr);
  const result = docker([
    "run",
    "--rm",
    "-e",
    "T3X_DOMAIN=t3.example.com",
    ...Object.entries(env).flatMap(([name, value]) => ["-e", `${name}=${value}`]),
    "-v",
    `${confDir}:/etc/caddy/conf:ro`,
    "-v",
    `${sitesDir}:/etc/caddy/sites:ro`,
    CADDY_IMAGE,
    "caddy",
    "adapt",
    "--config",
    "/etc/caddy/conf/Caddyfile",
  ]);
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

const dials = (json) => [...json.matchAll(/"dial":"([^"]+)"/g)].map((m) => m[1]).toSorted();

if (hasDocker) {
  describe("docker compose config", () => {
    it("the standard install publishes only Caddy's 80 and 443, and mounts the sites directory read-only", () => {
      const { services } = composeConfig(["docker-compose.yml"]);
      assert.deepEqual(
        published(services.caddy).map((p) => p.host),
        [80, 443],
      );
      for (const name of ["registry", "frps", "ntfy"])
        assert.equal(services[name].ports, undefined);
      assert.equal(services.caddy.network_mode, undefined);
      const sites = services.caddy.volumes.find((v) => v.target === "/etc/caddy/sites");
      assert.equal(sites.read_only, true);
      assert.equal(sites.source, NodePath.join(SELF_HOST, "sites"));
    });

    it("the host-network override puts Caddy on the host and publishes the rest on the loopback only", () => {
      const { services } = composeConfig(["docker-compose.yml", "docker-compose.host-network.yml"]);
      assert.equal(services.caddy.network_mode, "host");
      assert.equal(services.caddy.ports, undefined);
      const ports = Object.entries(services).flatMap(([name, service]) =>
        published(service).map((p) => ({ name, ...p })),
      );
      for (const port of ports) assert.equal(port.ip, "127.0.0.1", `${port.name}:${port.host}`);
      // 8081 is the frps plugin, which only frps uses; 7000 and 8080 are what other things on a VPS tend to hold.
      assert.deepEqual(ports.map((p) => `${p.name}:${p.target}`).toSorted(), [
        "frps:7000",
        "frps:8080",
        "ntfy:80",
        "registry:8080",
        "registry:8082",
      ]);
      assert.equal(new Set(ports.map((p) => p.host)).size, ports.length);
      for (const port of ports)
        assert.ok(![7000, 8080, 80, 443].includes(port.host), `${port.name} on ${port.host}`);
      // Caddy's upstreams are exactly the ports that are published.
      const at = (name, target) =>
        `127.0.0.1:${ports.find((p) => p.name === name && p.target === target).host}`;
      const env = services.caddy.environment;
      assert.equal(env.T3X_REGISTRY_API, at("registry", 8080));
      assert.equal(env.T3X_REGISTRY_ASK, at("registry", 8082));
      assert.equal(env.T3X_FRPS_CONTROL, at("frps", 7000));
      assert.equal(env.T3X_FRPS_VHOST, at("frps", 8080));
      assert.equal(env.T3X_NTFY_UPSTREAM, at("ntfy", 80));
    });

    it("flipping the push server or the e-mail does not change Caddy's definition, so it needs no recreate", () => {
      // Those switches are the contents of files in the configuration directory (caddy/conf.sh), never a variable here.
      for (const files of [
        ["docker-compose.yml"],
        ["docker-compose.yml", "docker-compose.host-network.yml"],
      ]) {
        const base = caddyHash(files, "T3X_NTFY_ENABLED=1\nCOMPOSE_PROFILES=ntfy\nACME_EMAIL=\n");
        assert.equal(
          caddyHash(files, "T3X_NTFY_ENABLED=0\nCOMPOSE_PROFILES=\nACME_EMAIL=you@example.com\n"),
          base,
          files.join(" + "),
        );
      }
    });

    it("mounts Caddy's configuration directory whole and starts Caddy from it", () => {
      const { services } = composeConfig(["docker-compose.yml"]);
      const conf = services.caddy.volumes.find((v) => v.target === "/etc/caddy/conf");
      assert.equal(conf.read_only, true);
      assert.equal(conf.type, "bind");
      assert.deepEqual(services.caddy.command, [
        "caddy",
        "run",
        "--config",
        "/etc/caddy/conf/Caddyfile",
        "--adapter",
        "caddyfile",
      ]);
      // A single-file mount would keep the old inode when git or mv replaces the file.
      for (const volume of services.caddy.volumes.filter((v) => v.type === "bind")) {
        assert.ok(
          NodeFS.statSync(volume.source, { throwIfNoEntry: false })?.isFile() !== true,
          `${volume.source} is a file`,
        );
      }
    });

    it("tells the registry whether the push server is installed", () => {
      const registry = (env) => composeConfig(["docker-compose.yml"], env).services.registry;
      assert.equal(registry("").environment.T3X_NTFY_ENABLED, "0");
      assert.equal(registry("T3X_NTFY_ENABLED=1\n").environment.T3X_NTFY_ENABLED, "1");
    });

    it("the host ports can be changed in .env", () => {
      const { services } = composeConfig(
        ["docker-compose.yml", "docker-compose.host-network.yml"],
        "T3X_HOST_REGISTRY_PORT=28080\nT3X_HOST_FRPS_PORT=27000\n",
      );
      assert.equal(services.caddy.environment.T3X_REGISTRY_API, "127.0.0.1:28080");
      assert.equal(services.caddy.environment.T3X_FRPS_CONTROL, "127.0.0.1:27000");
      assert.equal(Number(published(services.registry)[0].host), 28080);
    });
  });

  describe("caddy adapt", () => {
    const HOST_ENV = {
      T3X_REGISTRY_API: "127.0.0.1:17080",
      T3X_REGISTRY_ASK: "127.0.0.1:17082",
      T3X_FRPS_CONTROL: "127.0.0.1:17000",
      T3X_FRPS_VHOST: "127.0.0.1:17088",
      T3X_NTFY_UPSTREAM: "127.0.0.1:17090",
    };

    it("the default upstreams are the compose services, and an empty sites directory is fine", () => {
      const json = adapt({});
      assert.deepEqual(dials(json), ["frps:7000", "frps:8080", "ntfy:80", "registry:8080"]);
      assert.match(json, /"endpoint":"http:\/\/registry:8082\/ask"/);
      // On-demand certificates only for names under the domain: a policy for every name would break default_sni.
      assert.doesNotMatch(json, /\{"on_demand":true\}/);
    });

    it("the host-network variables move every upstream, including the certificate question", () => {
      const json = adapt({ env: HOST_ENV });
      assert.deepEqual(dials(json), [
        "127.0.0.1:17000",
        "127.0.0.1:17080",
        "127.0.0.1:17088",
        "127.0.0.1:17090",
      ]);
      assert.match(json, /"endpoint":"http:\/\/127\.0\.0\.1:17082\/ask"/);
      // The registry's rate limit and frps's visitor address both come from the peer address of Caddy's connection.
      assert.equal(json.split('"X-T3x-Client-Ip":["{http.request.remote.host}"]').length - 1, 2);
    });

    it("ntfy's and the computers' names fall under an on-demand policy, the apex under a managed one", () => {
      // The first policy whose subjects match a name is the one Caddy uses for it (no subjects: every name).
      const policyFor = (json, name) =>
        JSON.parse(json).apps.tls.automation.policies.find(
          (policy) =>
            policy.subjects === undefined ||
            policy.subjects.some(
              (subject) =>
                subject === name ||
                (subject.startsWith("*.") &&
                  name.endsWith(subject.slice(1)) &&
                  !name.slice(0, -subject.length + 1).includes(".")),
            ),
        );
      const layouts = {
        "an empty sites directory": {},
        "a site with its own certificate files and an IP site": {
          "manual.caddy":
            "manual.example.net {\n\ttls /certs/cert.pem /certs/key.pem\n\trespond manual\n}\n",
          "ip.caddy": "203.0.113.7 {\n\ttls internal\n\trespond ip\n}\n",
          "ip.options": "default_sni 203.0.113.7\n",
        },
      };
      for (const [layout, sites] of Object.entries(layouts)) {
        const json = adapt({ sites });
        for (const name of ["ntfy.t3.example.com", "a.t3.example.com"]) {
          assert.equal(policyFor(json, name).on_demand, true, `${name}, ${layout}`);
        }
        assert.notEqual(policyFor(json, "t3.example.com").on_demand, true, `the apex, ${layout}`);
      }
    });

    it("without the push server there is no ntfy site; with --email the address is in the ACME policy", () => {
      assert.doesNotMatch(adapt({ ntfy: false }), /ntfy/);
      assert.match(adapt({ ntfy: true }), /"ntfy\.t3\.example\.com"/);
    });

    it("an e-mail is passed to ACME, and none is fine", () => {
      assert.match(adapt({ email: "you@example.com" }), /"email":"you@example\.com"/);
      assert.doesNotMatch(adapt({}), /"email"/);
    });

    it("site files become sites, .options files become global options, other files are ignored", () => {
      const sites = {
        "other.caddy": "other.example.net {\n\treverse_proxy 127.0.0.1:9000\n}\n",
        "static.caddy":
          "files.example.net {\n\troot * /srv/files\n\tbasic_auth {\n\t\tme $2a$14$Zkx19XLiW6VYouLHR5NmfOFU0z2GTNmpkT/5qqR7hx4IjWJPDhjvG\n\t}\n\tfile_server\n}\n",
        "ip.options": "default_sni 203.0.113.7\n",
        "README.md": "this is not a Caddyfile {\n",
      };
      for (const test of [false, true]) {
        const json = adapt({ test, sites });
        assert.match(json, /"other\.example\.net"/);
        assert.match(json, /127\.0\.0\.1:9000/);
        assert.match(json, /"files\.example\.net"/);
        assert.match(json, /"default_sni":"203\.0\.113\.7"/);
        assert.match(json, /"hash":\{"algorithm":"bcrypt"\}/);
        // Our own sites are still there.
        assert.match(json, /"t3\.example\.com"/);
      }
    });
  });
} else if (process.env.CI) {
  it("needs docker for the deployment configuration checks", () => {
    assert.fail("CI is set but docker compose is not usable, so these checks cannot run");
  });
} else {
  it(
    "needs docker for the deployment configuration checks",
    { skip: "docker is not available here" },
    () => {},
  );
}
