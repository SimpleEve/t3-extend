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
const { describe, it, afterEach, beforeEach } = NodeTest;

const SETUP = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "..",
  "setup.sh",
);
const TRIAL = "docker-compose.yml:docker-compose.test.yml";
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
function setup(args, { files, os, project, composeWorks } = {}) {
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
          assert.match(result.stderr, /--email must be a plain address/);
          assert.deepEqual(result.written, []);
          assert.equal(result.dockerCalled, false);
        }
      });
    }

    it("accepts a plain address, and a local trial may leave it out", () => {
      const plain = setup(
        ["--domain", "t3.example.com", "--email", "you.me+t3@mail.example.com", "--dry-run"],
        { os: "Linux" },
      );
      assert.equal(plain.status, 0, plain.stderr);
      assert.match(plain.stdout, /^ {2}ACME_EMAIL=you\.me\+t3@mail\.example\.com$/m);
      const trial = setup(["--domain", "t3.localhost", "--dry-run"], { files: TRIAL, os: "Linux" });
      assert.equal(trial.status, 0, trial.stderr);
      const missing = setup(["--domain", "t3.example.com"], { os: "Linux" });
      assert.equal(missing.status, 1);
      assert.match(missing.stderr, /--email is required/);
    });

    it("refuses a domain with a second line", () => {
      const result = setup(
        ["--domain", "t3.example.com\nevil.example", "--email", "you@example.com"],
        { os: "Linux" },
      );
      assert.equal(result.status, 1);
      assert.match(result.stderr, /does not look like a domain name/);
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

  describe("setup.sh on a Mac", () => {
    const args = ["--domain", "t3.example.com", "--email", "you@example.com"];

    it("refuses production mode before doing anything", () => {
      const result = setup(args, { os: "Darwin" });
      assert.equal(result.status, 1);
      assert.match(result.stderr, /for a Linux VPS/);
      assert.match(result.stderr, /80 and 443/);
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
