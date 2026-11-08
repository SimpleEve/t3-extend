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
function setup(args, { files, os, project, composeWorks, sitesDir, env = {} } = {}) {
  const bin = NodePath.join(dir, "bin");
  if (composeWorks) {
    // `docker compose version` passes, so setup.sh gets as far as writing .env; `up` then fails and stops it.
    writeFileSync(
      NodePath.join(bin, "docker"),
      `#!/bin/sh\necho "$@" >> '${dir}/docker-calls'\n[ "$*" = "compose version" ] && exit 0\nexit 1\n`,
    );
  }
  if (os !== undefined) {
    writeFileSync(NodePath.join(bin, "uname"), `#!/bin/sh\necho ${os}\n`);
    chmodSync(NodePath.join(bin, "uname"), 0o755);
  }
  const data = NodePath.join(dir, "data");
  NodeFS.mkdirSync(data, { recursive: true });
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
  };
}

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
          assert.match(result.stderr, /--email 必须是一个普通的邮箱地址/);
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

    it("mounts the e-mail file only when there is an address", () => {
      const without = setup(args, { os: "Linux", composeWorks: true });
      assert.match(without.env, /^ACME_EMAIL=$/m);
      assert.match(without.env, /^T3X_ACME_EMAIL_CONF=\.\/caddy\/acme-email-off\.caddy$/m);
      const withEmail = setup([...args, "--email", "you@example.com"], {
        os: "Linux",
        composeWorks: true,
      });
      assert.match(withEmail.env, /^T3X_ACME_EMAIL_CONF=\.\/caddy\/acme-email\.caddy$/m);
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
