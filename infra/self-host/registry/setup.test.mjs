// setup.sh's argument checks. Everything runs with a fake `docker` (and `uname`) on PATH, so nothing real starts.
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const assert = NodeAssert;
const { spawnSync } = NodeChildProcess;
const { chmodSync, existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } = NodeFS;
const { join } = NodePath;
const { describe, it, afterEach, beforeEach } = NodeTest;

const SETUP = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "setup.sh",
);
const TRIAL = "docker-compose.yml:docker-compose.test.yml";
const SELF_HOST = NodePath.dirname(SETUP);
const hasBash = spawnSync("bash", ["-c", "true"]).status === 0;

let dir;
beforeEach(() => {
  dir = mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-setup-test-"));
  const bin = NodePath.join(dir, "bin");
  NodeFS.mkdirSync(bin);
  writeFileSync(
    NodePath.join(bin, "docker"),
    `#!/bin/sh\necho "$@" >> '${dir}/docker-calls'\nexit 1\n`,
  );
  chmodSync(NodePath.join(bin, "docker"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** Runs setup.sh against an empty data directory. `os` fakes `uname -s`. */
function setup(args, { files, os, project, composeWorks, sitesDir, env = {}, before } = {}) {
  const bin = NodePath.join(dir, "bin");
  if (composeWorks) {
    // `true`: `up` fails and stops setup.sh after it wrote .env. "all": every call succeeds. "stateful": files in the test
    // directory stand for containers (caddy-id, ntfy-id), Caddy's definition hash (hash) and a refused reload (reload-fails).
    const fake = {
      all: `#!/bin/sh\necho "$@" >> '${dir}/docker-calls'\nexit 0\n`,
      stateful: `#!/bin/sh
D='${dir}'
echo "$@" >> "$D/docker-calls"
case "$*" in
  *" ps -aq caddy"*) [ -f "$D/caddy-id" ] && cat "$D/caddy-id"; exit 0 ;;
  *" ps -aq ntfy"*) [ -f "$D/ntfy-id" ] && cat "$D/ntfy-id"; exit 0 ;;
  *" up "*" caddy") if [ ! -f "$D/caddy-id" ]; then echo caddy-1 > "$D/caddy-id"; cat "$D/hash" > "$D/caddy-hash" 2>/dev/null || : > "$D/caddy-hash"; fi; exit 0 ;;
  *" up "*" ntfy") echo ntfy-1 > "$D/ntfy-id"; exit 0 ;;
  *" rm -sf ntfy"*) rm -f "$D/ntfy-id"; exit 0 ;;
  *"caddy reload"*) if [ -f "$D/reload-fails" ]; then echo "reload refused: boom" >&2; exit 1; fi; exit 0 ;;
  *"config --hash caddy"*) echo "caddy HASH-$(cat "$D/hash" 2>/dev/null)"; exit 0 ;;
  "inspect "*) echo "HASH-$(cat "$D/caddy-hash" 2>/dev/null)"; exit 0 ;;
esac
exit 0
`,
    }[composeWorks];
    writeFileSync(
      NodePath.join(bin, "docker"),
      fake ??
        `#!/bin/sh\necho "$@" >> '${dir}/docker-calls'\n[ "$*" = "compose version" ] && exit 0\nexit 1\n`,
    );
  }
  if (os !== undefined) {
    writeFileSync(NodePath.join(bin, "uname"), `#!/bin/sh\necho ${os}\n`);
    chmodSync(NodePath.join(bin, "uname"), 0o755);
  }
  const data = NodePath.join(dir, "data");
  NodeFS.mkdirSync(data, { recursive: true });
  before?.(data);
  const result = spawnSync("bash", [SETUP, ...args], {
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      T3X_DATA_DIR: data,
      ...(files === undefined ? {} : { T3X_COMPOSE_FILES: files }),
      ...(project === undefined ? {} : { T3X_PROJECT: project }),
      ...(sitesDir === undefined ? {} : { T3X_SITES_DIR: sitesDir }),
      ...env,
    },
  });
  return {
    status: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
    written: readdirSync(data),
    env: existsSync(NodePath.join(data, ".env"))
      ? NodeFS.readFileSync(NodePath.join(data, ".env"), "utf8")
      : undefined,
    dockerCalled: existsSync(NodePath.join(dir, "docker-calls")),
    calls: existsSync(NodePath.join(dir, "docker-calls"))
      ? NodeFS.readFileSync(NodePath.join(dir, "docker-calls"), "utf8").trim().split("\n")
      : [],
    dataDir: data,
  };
}

/** A file of Caddy's configuration directory, as setup.sh wrote it into the data directory. */
const confFile = (result, name) =>
  NodeFS.readFileSync(join(result.dataDir, "caddy-conf", name), "utf8");

// The Alpine test image has no bash, and setup.sh is a bash script: these run on the host only.
if (hasBash) {
  describe("setup.sh --email", () => {
    const bad = [
      ["a newline", "you@example.com\nT3X_DOMAIN=evil.example"],
      ["a trailing newline", "you@example.com\n"],
      ["a space", "you @example.com"],
      ["a closing brace", "you@example.com}"],
      ["an equals sign", "you=1@example.com"],
      ["no @", "not-an-email"],
      ["no dot in the host", "you@localhost"],
      ["more than 254 characters", `${"a".repeat(250)}@example.com`],
    ];
    for (const [what, email] of bad) {
      it(`refuses an address with ${what} and writes nothing`, () => {
        for (const files of [undefined, TRIAL]) {
          const result = setup(["--domain", "t3.example.com", "--email", email], {
            files,
            os: "Linux",
          });
          assert.equal(result.status, 1, result.stderr);
          assert.match(result.stderr, /邮箱必须是一个普通的邮箱地址/);
          assert.deepEqual(result.written, []);
          assert.equal(result.dockerCalled, false);
        }
      });
    }

    it("accepts a plain address, and the address is optional", () => {
      const plain = setup(
        ["--domain", "t3.example.com", "--email", "you.me+t3@mail.example.com", "--dry-run"],
        { os: "Linux" },
      );
      assert.equal(plain.status, 0, plain.stderr);
      assert.match(plain.stdout, /^ {2}ACME_EMAIL=you\.me\+t3@mail\.example\.com$/m);
      const trial = setup(["--domain", "t3.localhost", "--dry-run"], { files: TRIAL, os: "Linux" });
      assert.equal(trial.status, 0, trial.stderr);
      const missing = setup(["--domain", "t3.example.com", "--dry-run"], { os: "Linux" });
      assert.equal(missing.status, 0, missing.stderr);
      assert.match(missing.stdout, /^ {2}ACME_EMAIL=$/m);
    });

    it("refuses a domain with a second line", () => {
      const result = setup(
        ["--domain", "t3.example.com\nevil.example", "--email", "you@example.com"],
        { os: "Linux" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /不像一个域名/);
      assert.deepEqual(result.written, []);
    });
  });

  describe("setup.sh's .env", () => {
    // `docker compose` run by hand in infra/self-host reads this file, so it must name the project
    // and the files setup.sh itself passes with -p and -f, or it would act on a different project.
    it("names the compose project and files, so plain docker compose finds the deployment", () => {
      const args = ["--domain", "t3.example.com", "--email", "you@example.com"];
      const production = setup(args, { os: "Linux", composeWorks: true });
      assert.match(production.env, /^COMPOSE_PROJECT_NAME=t3x$/m);
      assert.match(production.env, /^COMPOSE_FILE=docker-compose\.yml$/m);
      assert.match(production.env, /^COMPOSE_PROFILES=ntfy$/m);
    });

    it("carries a trial's own project name and compose files", () => {
      const trial = setup(["--domain", "t3.localhost", "--public-port", "18443"], {
        files: TRIAL,
        project: "t3x-trial",
        os: "Darwin",
        composeWorks: true,
      });
      assert.match(trial.env, /^COMPOSE_PROJECT_NAME=t3x-trial$/m);
      assert.match(trial.env, new RegExp(`^COMPOSE_FILE=${TRIAL.replaceAll(".", "\\.")}$`, "m"));
    });
  });

  describe("setup.sh and the Caddyfile's optional parts", () => {
    const args = ["--domain", "t3.example.com"];

    it("writes the e-mail into Caddy's configuration directory only when there is an address", () => {
      const without = setup(args, { os: "Linux", composeWorks: true });
      assert.match(without.env, /^ACME_EMAIL=$/m);
      assert.doesNotMatch(confFile(without, "acme-email.caddy"), /^email /m);
      const withEmail = setup([...args, "--email", "you@example.com"], {
        os: "Linux",
        composeWorks: true,
      });
      assert.equal(confFile(withEmail, "acme-email.caddy"), "email you@example.com\n");
    });

    it("writes the sites directory into .env, so plain docker compose mounts the same one", () => {
      const standard = setup(args, { os: "Linux", composeWorks: true });
      assert.match(standard.env, new RegExp(`^T3X_SITES_DIR=${SELF_HOST}/sites$`, "m"));
      const custom = setup(args, { os: "Linux", composeWorks: true, sitesDir: join(dir, "sites") });
      assert.match(custom.env, new RegExp(`^T3X_SITES_DIR=${join(dir, "sites")}$`, "m"));
      assert.ok(existsSync(join(dir, "sites")), "an absolute sites directory is created");
    });

    it("turns a relative sites directory into an absolute one, so compose never takes it for a volume name", () => {
      const named = setup(args, { os: "Linux", composeWorks: true, sitesDir: "custom-sites" });
      assert.match(named.env, new RegExp(`^T3X_SITES_DIR=${SELF_HOST}/custom-sites$`, "m"));
      assert.ok(existsSync(join(SELF_HOST, "custom-sites")), "it is created next to setup.sh");
      rmSync(join(SELF_HOST, "custom-sites"), { recursive: true });
      const dotted = setup(args, { os: "Linux", composeWorks: true, sitesDir: "./more/sites" });
      assert.match(dotted.env, new RegExp(`^T3X_SITES_DIR=${SELF_HOST}/more/sites$`, "m"));
      rmSync(join(SELF_HOST, "more"), { recursive: true });
    });

    for (const [what, value] of [
      ["a second line", "/srv/a\nT3X_DOMAIN=evil.example"],
      ["a dollar sign", "/srv/${HOME}/sites"],
      ["a hash", "/srv/a #b"],
      ["a colon", "/srv/a:/etc"],
      ["a space", "/srv/my sites"],
      ["a quote", '/srv/"x"'],
    ]) {
      it(`refuses a sites directory with ${what} and writes nothing`, () => {
        const bad = setup(args, { os: "Linux", sitesDir: value });
        assert.equal(bad.status, 1);
        assert.match(bad.stderr, /T3X_SITES_DIR/);
        assert.deepEqual(bad.written, []);
        assert.equal(bad.dockerCalled, false);
      });
    }

    it("takes the host-network override from T3X_COMPOSE_FILES, in .env and in --dry-run", () => {
      const files = "docker-compose.yml:docker-compose.host-network.yml";
      const dry = setup([...args, "--dry-run"], { files, os: "Linux" });
      assert.equal(dry.status, 0, dry.stderr);
      assert.match(
        dry.stdout,
        /^ {2}COMPOSE_FILE=docker-compose\.yml:docker-compose\.host-network\.yml$/m,
      );
      assert.match(
        dry.stdout,
        /-f \S*docker-compose\.yml -f \S*docker-compose\.host-network\.yml up/,
      );
      const real = setup(args, { files, os: "Linux", composeWorks: true });
      assert.match(
        real.env,
        /^COMPOSE_FILE=docker-compose\.yml:docker-compose\.host-network\.yml$/m,
      );
    });

    describe("a rerun", () => {
      const HOST = "docker-compose.yml:docker-compose.host-network.yml";
      const install = () =>
        setup(args, {
          files: HOST,
          os: "Linux",
          composeWorks: true,
          sitesDir: join(dir, "srv-sites"),
          env: { T3X_HOST_REGISTRY_PORT: "28080", T3X_HOST_NTFY_PORT: "28090" },
        });

      it("writes the host ports it uses into .env, and only with the host-network override", () => {
        const first = install();
        assert.match(first.env, /^T3X_HOST_REGISTRY_PORT=28080$/m);
        assert.match(first.env, /^T3X_HOST_ASK_PORT=17082$/m);
        assert.match(first.env, /^T3X_HOST_NTFY_PORT=28090$/m);
        const standard = setup(args, {
          files: "docker-compose.yml",
          os: "Linux",
          composeWorks: true,
        });
        assert.doesNotMatch(standard.env, /T3X_HOST_/);
      });

      it("keeps the compose files, the sites directory and the host ports when they are not given again", () => {
        const first = install();
        const again = setup(args, { os: "Linux", composeWorks: true });
        assert.equal(again.env, first.env);
        assert.equal(again.stderr.includes("提示"), false, again.stderr);
        const dry = setup([...args, "--dry-run"], { os: "Linux" });
        assert.match(
          dry.stdout,
          /^ {2}COMPOSE_FILE=docker-compose\.yml:docker-compose\.host-network\.yml$/m,
        );
        assert.match(dry.stdout, /host-network\.yml up/);
      });

      it("upgrades a .env that an earlier setup.sh wrote with a relative sites directory", () => {
        NodeFS.mkdirSync(join(dir, "data"), { recursive: true });
        NodeFS.writeFileSync(
          join(dir, "data", ".env"),
          [
            "T3X_DOMAIN=t3.example.com",
            "T3X_PUBLIC_ORIGIN=https://t3.example.com",
            "ACME_EMAIL=",
            "COMPOSE_PROFILES=ntfy",
            "COMPOSE_PROJECT_NAME=t3x",
            `COMPOSE_FILE=${HOST}`,
            "T3X_NTFY_SITE=./caddy/ntfy.caddy",
            "T3X_SITES_DIR=./sites",
            "",
          ].join("\n"),
        );
        const again = setup(args, { os: "Linux", composeWorks: true });
        assert.match(again.env, new RegExp(`^COMPOSE_FILE=${HOST.replaceAll(".", "\\.")}$`, "m"));
        assert.match(again.env, new RegExp(`^T3X_SITES_DIR=${SELF_HOST}/sites$`, "m"));
        assert.match(again.env, /^T3X_HOST_REGISTRY_PORT=17080$/m);
        assert.equal(again.stderr.includes("提示"), false, again.stderr);
      });

      it("takes a value that is given again, and says that it differs from .env", () => {
        const first = install();
        const again = setup(args, {
          os: "Linux",
          composeWorks: true,
          env: { T3X_HOST_REGISTRY_PORT: "29080" },
        });
        assert.match(again.env, /^T3X_HOST_REGISTRY_PORT=29080$/m);
        assert.match(again.env, /^T3X_HOST_NTFY_PORT=28090$/m);
        assert.match(again.stderr, /T3X_HOST_REGISTRY_PORT.*29080.*28080/);
        const standard = setup(args, {
          files: "docker-compose.yml",
          os: "Linux",
          composeWorks: true,
        });
        assert.match(standard.env, /^COMPOSE_FILE=docker-compose\.yml$/m);
        assert.doesNotMatch(standard.env, /T3X_HOST_/);
        assert.match(standard.stderr, /COMPOSE_FILE/);
        assert.match(first.env, /srv-sites/);
      });

      it("refuses a host port that is not a port", () => {
        for (const bad of ["abc", "0", "70000", "80 80"]) {
          const result = setup(args, {
            files: HOST,
            os: "Linux",
            env: { T3X_HOST_ASK_PORT: bad },
          });
          assert.equal(result.status, 1, bad);
          assert.match(result.stderr, /T3X_HOST_ASK_PORT/);
        }
      });
    });

    it("still refuses the host-network override on a Mac", () => {
      const result = setup(args, {
        files: "docker-compose.yml:docker-compose.host-network.yml",
        os: "Darwin",
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /只用在 Linux VPS 上/);
    });
  });

  describe("setup.sh reads the old .env strictly", () => {
    const args = ["--domain", "t3.example.com"];
    const HOST = "docker-compose.yml:docker-compose.host-network.yml";
    const base = (extra = "") =>
      [
        "T3X_DOMAIN=t3.example.com",
        "T3X_PUBLIC_ORIGIN=https://t3.example.com",
        "ACME_EMAIL=",
        "COMPOSE_PROFILES=ntfy",
        "COMPOSE_PROJECT_NAME=t3x",
        `COMPOSE_FILE=${HOST}`,
        `T3X_SITES_DIR=${join(dir, "srv-sites")}`,
        extra,
      ].join("\n");
    const withEnv = (text) => (data) => writeFileSync(join(data, ".env"), text);

    // Each of these used to be read wrongly, or not at all: setup.sh then wrote the wrong .env, and compose failed later.
    for (const [what, makeText, message] of [
      ["an export", () => base().replace("COMPOSE_FILE=", "export COMPOSE_FILE="), /第 6 行看不懂/],
      ["a trailing comment", () => base().replace(`${HOST}`, `${HOST} # kept`), /第 6 行看不懂/],
      ["a quoted value", () => base().replace(`${HOST}`, `"${HOST}"`), /第 6 行看不懂/],
      ["a key twice", () => base("COMPOSE_PROJECT_NAME=other"), /COMPOSE_PROJECT_NAME 出现了两次/],
      ["spaces around the equals sign", () => base("T3X_NTFY_ENABLED = 1"), /看不懂/],
    ]) {
      it(`refuses an old .env with ${what}, and leaves it as it was`, () => {
        const text = makeText();
        const result = setup(args, { os: "Linux", composeWorks: true, before: withEnv(text) });
        assert.equal(result.status, 1, result.stderr);
        assert.match(result.stderr, message);
        assert.equal(result.env, text);
        assert.equal(
          result.calls.some((call) => call.startsWith("compose -p")),
          false,
        );
      });
    }

    it("takes an explicitly empty variable as back to the default, not as not given", () => {
      const result = setup(args, {
        os: "Linux",
        composeWorks: true,
        before: withEnv(base()),
        env: { T3X_COMPOSE_FILES: "", T3X_SITES_DIR: "" },
      });
      assert.equal(result.status, 1, "the fake docker stops it at `up`; .env is what matters");
      assert.match(result.env, /^COMPOSE_FILE=docker-compose\.yml$/m);
      assert.match(result.env, new RegExp(`^T3X_SITES_DIR=${SELF_HOST}/sites$`, "m"));
      assert.match(result.stderr, /COMPOSE_FILE 和已有的/);
      assert.doesNotMatch(result.env, /T3X_HOST_/);
    });

    for (const [what, value] of [
      ["a path", "docker-compose.yml:../evil.yml"],
      ["an absolute path", "docker-compose.yml:/etc/evil.yml"],
      ["a file that is not there", "docker-compose.yml:docker-compose.nowhere.yml"],
      ["an empty name", "docker-compose.yml::docker-compose.host-network.yml"],
      ["a trailing colon", "docker-compose.yml:"],
      ["a name with a space", "docker-compose.yml:my file.yml"],
    ]) {
      it(`refuses T3X_COMPOSE_FILES with ${what} before it creates anything`, () => {
        const result = setup(args, { os: "Linux", files: value, sitesDir: join(dir, "new-sites") });
        assert.equal(result.status, 1);
        assert.match(result.stderr, /T3X_COMPOSE_FILES/);
        assert.deepEqual(result.written, []);
        assert.equal(existsSync(join(dir, "new-sites")), false);
        assert.equal(result.dockerCalled, false);
      });
    }

    it("keeps --no-ntfy and the e-mail when they are not given again, and takes them when they are", () => {
      const first = setup([...args, "--no-ntfy", "--email", "you@example.com"], {
        os: "Linux",
        composeWorks: true,
      });
      assert.match(first.env, /^T3X_NTFY_ENABLED=0$/m);
      assert.match(first.env, /^COMPOSE_PROFILES=$/m);
      const again = setup(args, { os: "Linux", composeWorks: true });
      assert.equal(again.env, first.env);
      assert.equal(again.stderr.includes("提示"), false, again.stderr);
      const dry = setup([...args, "--dry-run"], { os: "Linux" });
      assert.match(dry.stdout, /^ {2}ACME_EMAIL=you@example\.com$/m);
      assert.doesNotMatch(dry.stdout, /ntfy-phone/);
      // Given again: the new value wins, with a note.
      const ntfyBack = setup([...args, "--ntfy"], { os: "Linux", composeWorks: true });
      assert.match(ntfyBack.env, /^T3X_NTFY_ENABLED=1$/m);
      assert.match(ntfyBack.env, /^COMPOSE_PROFILES=ntfy$/m);
      assert.match(ntfyBack.env, /^ACME_EMAIL=you@example\.com$/m);
      assert.match(ntfyBack.stderr, /推送服务器/);
      for (const removal of [["--no-email"], ["--email", ""]]) {
        const removed = setup([...args, ...removal], { os: "Linux", composeWorks: true });
        assert.match(removed.env, /^ACME_EMAIL=$/m, removal.join(" "));
        assert.doesNotMatch(confFile(removed, "acme-email.caddy"), /^email /m);
        setup([...args, "--email", "you@example.com"], { os: "Linux", composeWorks: true });
      }
    });

    it("knows from an old .env without T3X_NTFY_ENABLED that the push server was left out", () => {
      const old = base().replace("COMPOSE_PROFILES=ntfy", "COMPOSE_PROFILES=");
      const result = setup(args, { os: "Linux", composeWorks: true, before: withEnv(old) });
      assert.match(result.env, /^T3X_NTFY_ENABLED=0$/m);
      assert.match(confFile(result, "ntfy.caddy"), /no ntfy\.<domain> site/);
    });

    it("keeps the project name the install used", () => {
      const first = setup(args, { os: "Linux", composeWorks: true, project: "mine" });
      assert.match(first.env, /^COMPOSE_PROJECT_NAME=mine$/m);
      const again = setup(args, { os: "Linux", composeWorks: true });
      assert.match(again.env, /^COMPOSE_PROJECT_NAME=mine$/m);
      const bad = setup(args, { os: "Linux", project: "Not Valid" });
      assert.equal(bad.status, 1);
      assert.match(bad.stderr, /T3X_PROJECT/);
    });

    it("does not say it will create the ntfy password when the file is already there", () => {
      const without = setup([...args, "--dry-run"], { os: "Linux" });
      assert.match(without.stdout, /将创建 .*ntfy-phone\.txt/);
      NodeFS.mkdirSync(join(without.dataDir, "secrets"));
      writeFileSync(join(without.dataDir, "secrets", "ntfy-phone.txt"), "already-there\n");
      const withSecret = setup([...args, "--dry-run"], { os: "Linux" });
      assert.doesNotMatch(withSecret.stdout, /将创建 .*ntfy-phone\.txt/);
    });

    it("brings the services up without Caddy first, and Caddy on its own without recreating it", () => {
      const run = (extra = []) => setup([...args, ...extra], { os: "Linux", composeWorks: "all" });
      const ups = (result) =>
        result.calls
          .filter((call) => / up /.test(call))
          .map((call) => call.replace(/^.* up /, "up "));
      assert.deepEqual(ups(run()), [
        "up -d --build --wait --no-deps registry frps ntfy",
        "up -d --wait --no-recreate caddy",
      ]);
      rmSync(join(dir, "docker-calls"));
      assert.deepEqual(ups(run(["--recreate-caddy"])), [
        "up -d --build --wait --no-deps registry frps ntfy",
        "up -d --wait caddy",
      ]);
      rmSync(join(dir, "docker-calls"));
      assert.deepEqual(ups(run(["--no-ntfy"])), [
        "up -d --build --wait --no-deps registry frps",
        "up -d --wait --no-recreate caddy",
      ]);
    });
  });

  describe("setup.sh and Caddy's configuration directory", () => {
    const args = ["--domain", "t3.example.com"];
    const run = (extra = [], options = {}) =>
      setup([...args, ...extra], { os: "Linux", composeWorks: "stateful", ...options });
    const calls = (result, pattern) => result.calls.filter((call) => pattern.test(call));
    const reloads = (result) => calls(result, /caddy reload/);
    const applied = (result) =>
      NodeFS.readFileSync(join(result.dataDir, ".caddy-conf.applied"), "utf8").trim();

    it("writes the directory (not single files) and names it in .env", () => {
      const result = run();
      assert.match(
        result.env,
        new RegExp(`^T3X_CADDY_CONF_DIR=${result.dataDir}/caddy-conf$`, "m"),
      );
      assert.doesNotMatch(result.env, /T3X_NTFY_SITE|T3X_ACME_EMAIL_CONF/);
      assert.deepEqual(readdirSync(join(result.dataDir, "caddy-conf")).toSorted(), [
        "Caddyfile",
        "acme-email.caddy",
        "ntfy.caddy",
      ]);
      assert.equal(
        confFile(result, "ntfy.caddy"),
        NodeFS.readFileSync(join(SELF_HOST, "caddy/ntfy.caddy"), "utf8"),
      );
      // A local trial gets Caddyfile.test in the same place.
      rmSync(join(dir, "data"), { recursive: true });
      const trial = setup(["--domain", "t3.localhost", "--dry-run"], { files: TRIAL, os: "Linux" });
      assert.match(trial.stdout, /caddy\/conf\.sh --test/);
    });

    it("starts a new Caddy from the files and reloads nothing; a rerun with the same files does nothing to Caddy", () => {
      const first = run();
      assert.equal(reloads(first).length, 0);
      const digest = applied(first);
      assert.match(digest, /^[0-9a-f]{64}$/);
      rmSync(join(dir, "docker-calls"));
      const again = run();
      assert.equal(reloads(again).length, 0);
      assert.equal(applied(again), digest);
      assert.equal(calls(again, /up .* caddy$/).length, 1, "one up for Caddy, with --no-recreate");
      assert.match(calls(again, /up .* caddy$/)[0], /--no-recreate caddy$/);
    });

    it("reloads Caddy, gracefully and without recreating it, when the files' contents change", () => {
      const digestBefore = applied(run());
      rmSync(join(dir, "docker-calls"));
      const changed = run(["--email", "you@example.com"]);
      assert.equal(changed.status, 0, changed.stderr);
      assert.equal(reloads(changed).length, 1);
      assert.match(
        reloads(changed)[0],
        /exec -T caddy caddy reload --config \/etc\/caddy\/conf\/Caddyfile --adapter caddyfile/,
      );
      assert.notEqual(applied(changed), digestBefore);
      assert.doesNotMatch(changed.calls.join("\n"), /--recreate|up -d --wait caddy$/m);
    });

    it("reports a refused reload as it is, exits non-zero, and tries again on the next run", () => {
      run();
      writeFileSync(join(dir, "reload-fails"), "");
      const before = applied({ dataDir: join(dir, "data") });
      const failed = run(["--email", "you@example.com"]);
      assert.notEqual(failed.status, 0);
      assert.match(failed.stderr, /reload refused: boom/);
      assert.match(failed.stderr, /Caddy 重载失败，它继续用旧配置/);
      assert.equal(applied(failed), before, "what Caddy has loaded is still the old one");
      rmSync(join(dir, "reload-fails"));
      rmSync(join(dir, "docker-calls"));
      const retried = run(["--email", "you@example.com"]);
      assert.equal(retried.status, 0, retried.stderr);
      assert.equal(reloads(retried).length, 1);
      assert.notEqual(applied(retried), before);
    });

    it("does not recreate or reload a Caddy whose definition changed, says so, and --recreate-caddy is the way", () => {
      run();
      writeFileSync(join(dir, "hash"), "new");
      rmSync(join(dir, "docker-calls"));
      const result = run(["--email", "you@example.com"]);
      assert.equal(result.status, 0, result.stderr);
      assert.match(result.stderr, /Caddy 的定义变了/);
      assert.match(result.stderr, /别的网站会断几秒/);
      assert.match(result.stderr, /--recreate-caddy/);
      assert.equal(reloads(result).length, 0);
      assert.match(calls(result, /up .* caddy$/)[0], /--no-recreate caddy$/);
      const flagged = run(["--email", "you@example.com", "--recreate-caddy"]);
      assert.match(calls(flagged, /up .* caddy$/).at(-1), /up -d --wait caddy$/);
    });

    it("--no-ntfy removes the ntfy container, changes the route by reload, and keeps the data volumes; --ntfy brings both back", () => {
      const on = run();
      assert.match(confFile(on, "ntfy.caddy"), /reverse_proxy/);
      assert.ok(NodeFS.existsSync(join(dir, "ntfy-id")), "ntfy is running");
      rmSync(join(dir, "docker-calls"));
      const off = run(["--no-ntfy"]);
      assert.equal(off.status, 0, off.stderr);
      assert.equal(NodeFS.existsSync(join(dir, "ntfy-id")), false, "the container is gone");
      assert.equal(calls(off, /--profile ntfy rm -sf ntfy$/).length, 1);
      assert.doesNotMatch(off.calls.join("\\n"), /down|volume|rm .*-v/);
      assert.doesNotMatch(confFile(off, "ntfy.caddy"), /reverse_proxy/);
      assert.equal(reloads(off).length, 1);
      assert.match(off.stdout, /数据卷 ntfy_data 和 ntfy_cache 保留/);
      rmSync(join(dir, "docker-calls"));
      const back = run(["--ntfy"]);
      assert.ok(NodeFS.existsSync(join(dir, "ntfy-id")), "the container is back");
      assert.match(confFile(back, "ntfy.caddy"), /reverse_proxy/);
      assert.equal(reloads(back).length, 1);
      assert.equal(calls(back, /rm -sf/).length, 0);
    });

    it("refuses an old .env whose T3X_NTFY_ENABLED is neither 0 nor 1, before it creates anything", () => {
      const text = [
        "T3X_DOMAIN=t3.example.com",
        "COMPOSE_PROFILES=ntfy",
        "T3X_NTFY_ENABLED=garbage",
        "",
      ].join("\n");
      for (const flags of [[], ["--no-ntfy"]]) {
        const result = setup([...args, ...flags], {
          os: "Linux",
          composeWorks: "stateful",
          before: (data) => writeFileSync(join(data, ".env"), text),
        });
        assert.equal(result.status, 1, flags.join(" "));
        assert.match(result.stderr, /T3X_NTFY_ENABLED 是「garbage」，只能是 0 或 1/);
        assert.equal(result.env, text);
        assert.deepEqual(result.written, [".env"]);
      }
    });

    it("takes an empty T3X_NTFY_ENABLED from COMPOSE_PROFILES", () => {
      const make = (profiles) => (data) =>
        writeFileSync(
          join(data, ".env"),
          `T3X_DOMAIN=t3.example.com\nCOMPOSE_PROFILES=${profiles}\nT3X_NTFY_ENABLED=\n`,
        );
      assert.match(
        setup(args, { os: "Linux", composeWorks: "stateful", before: make("ntfy") }).env,
        /^T3X_NTFY_ENABLED=1$/m,
      );
      rmSync(join(dir, "data"), { recursive: true });
      assert.match(
        setup(args, { os: "Linux", composeWorks: "stateful", before: make("") }).env,
        /^T3X_NTFY_ENABLED=0$/m,
      );
    });

    it("refuses another domain before it creates secrets, the sites directory or the configuration directory", () => {
      const result = setup(["--domain", "other.example.com"], {
        os: "Linux",
        composeWorks: "stateful",
        sitesDir: join(dir, "new-sites"),
        before: (data) =>
          writeFileSync(join(data, ".env"), "T3X_DOMAIN=t3.example.com\nCOMPOSE_PROFILES=ntfy\n"),
      });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /已经是为 't3\.example\.com' 装好的/);
      assert.deepEqual(result.written, [".env"]);
      assert.equal(NodeFS.existsSync(join(dir, "new-sites")), false);
      assert.equal(result.dockerCalled, false);
    });
  });

  describe("setup.sh on a Mac", () => {
    const args = ["--domain", "t3.example.com", "--email", "you@example.com"];

    it("refuses production mode before doing anything", () => {
      const result = setup(args, { os: "Darwin" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /只用在 Linux VPS 上/);
      assert.match(result.stderr, /80 和 443/);
      assert.deepEqual(result.written, []);
      assert.equal(result.dockerCalled, false);
    });

    it("still allows --dry-run and the local trial", () => {
      assert.equal(setup([...args, "--dry-run"], { os: "Darwin" }).status, 0);
      const trial = setup(["--domain", "t3.localhost", "--public-port", "18443", "--dry-run"], {
        files: TRIAL,
        os: "Darwin",
      });
      assert.equal(trial.status, 0, trial.stderr);
    });
  });
}
