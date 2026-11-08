// Gate A of 9.1 (design 5.6.0): every listening point and long-lived child is in
// `exclusions.json` with a handling. The scan below fails when product code gains a listening
// point nobody has written down; it does not prove an existing entry is right (each entry carries
// its own verification).
// @effect-diagnostics nodeBuiltinImport:off -- Source scan and a real Unix socket.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Signature from "effect/crypto/Signature";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/http";
import * as Layer from "effect/Layer";

import * as ServerSecretStore from "../../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as CodexManagedTokenBroker from "../../provider/CodexManagedTokenBroker.ts";
import inventory from "./exclusions.json" with { type: "json" };

const repoRoot = NodePath.resolve(import.meta.dirname, "../../../../..");

const PATTERNS = [
  /\.listen\(/gu,
  /createServer\(/gu,
  /NodeHttpServer\.make/gu,
  /NodeSocketServer\.make/gu,
  /HttpServer\.serve/gu,
  /WebSocketServer\(/gu,
  /"--port/gu,
  /--port=/gu,
  /"--metrics"/gu,
  /--listen/gu,
  /"-L"/gu,
];

const SKIP =
  /\.test\.|testkit|\.browser\.|\/test\/|\/fixtures\/|\/dist\/|\/scripts\/|\.d\.ts$|\/testUtils\/|\/__tests__\//u;

const scanRoots = () => [
  "apps/server/src",
  "apps/desktop/src",
  ...NodeFS.readdirSync(NodePath.join(repoRoot, "packages"))
    .filter((name) => NodeFS.existsSync(NodePath.join(repoRoot, "packages", name, "src")))
    .map((name) => `packages/${name}/src`),
];

const scan = () => {
  const counts: Record<string, number> = {};
  const walk = (directory: string) => {
    for (const entry of NodeFS.readdirSync(directory, { withFileTypes: true })) {
      const full = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "node_modules") walk(full);
      } else if (/\.(?:ts|tsx|mjs|js|cjs)$/u.test(entry.name) && !SKIP.test(full)) {
        const text = NodeFS.readFileSync(full, "utf8");
        const count = PATTERNS.reduce(
          (sum, pattern) => sum + (text.match(pattern)?.length ?? 0),
          0,
        );
        if (count > 0) counts[NodePath.relative(repoRoot, full)] = count;
      }
    }
  };
  for (const root of scanRoots()) walk(NodePath.join(repoRoot, root));
  return counts;
};

describe("exclusions.json", () => {
  it("lists every listening point in product code, at the counts it was written for", () => {
    // A new `.listen(` or `--port` fails here until someone adds an entry and updates the count.
    assert.deepEqual(scan(), inventory.scan);
  });

  it("gives every scanned file at least one entry, and every entry a verification and a status", () => {
    const entryFiles = new Set(inventory.entries.map((entry) => entry.file));
    for (const file of Object.keys(inventory.scan)) {
      assert.isTrue(entryFiles.has(file), `no entry for ${file}`);
    }
    for (const entry of [...inventory.entries, ...inventory.children]) {
      assert.isTrue(
        NodeFS.existsSync(NodePath.join(repoRoot, entry.file)),
        `${entry.id}: ${entry.file} is gone`,
      );
      assert.include(["verified", "unverified-excluded"], entry.status, entry.id);
      assert.isAbove(entry.handling.length, 0, entry.id);
    }
    for (const entry of inventory.entries) {
      assert.isAbove(entry.verification.length, 0, entry.id);
    }
    const ids = [...inventory.entries, ...inventory.children].map((entry) => entry.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  it("every entry that names a test names one that exists", () => {
    const tests = NodeFS.readdirSync(import.meta.dirname)
      .filter((name) => name.endsWith(".test.ts"))
      .map((name) => NodeFS.readFileSync(NodePath.join(import.meta.dirname, name), "utf8"))
      .join("\n");
    for (const entry of inventory.entries) {
      for (const [, quoted] of entry.verification.matchAll(/'([^']{10,})'/gu)) {
        assert.include(tests, quoted!.replaceAll("\\'", "'"), `${entry.id}: no test '${quoted}'`);
      }
    }
  });
});

describe("the managed token broker", () => {
  it.live("a Unix socket is not a TCP listener: its endpoint is a private socket file", () =>
    Effect.gen(function* () {
      const broker = yield* CodexManagedTokenBroker.CodexManagedTokenBroker;
      const endpoint = yield* broker.endpoint;
      assert.isTrue(NodePath.isAbsolute(endpoint));
      const stat = NodeFS.statSync(endpoint);
      assert.isTrue(stat.isSocket());
      assert.equal(stat.mode & 0o777, 0o600);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        CodexManagedTokenBroker.layer.pipe(
          // The broker only builds its socket here; the auth jobs behind connections never run.
          Layer.provide(
            Layer.mergeAll(
              Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
                getEnvironmentId: Effect.succeed(EnvironmentId.make("env-gate-a")),
              } as never),
              Layer.succeed(Digest.Digest, {} as never),
              Layer.succeed(SecureRandom.SecureRandom, {} as never),
              Layer.succeed(Signature.Signature, {} as never),
              Layer.succeed(HttpClient.HttpClient, {} as never),
              Layer.succeed(ServerSecretStore.ServerSecretStore, {} as never),
            ),
          ),
        ),
      ),
    ),
  );
});
