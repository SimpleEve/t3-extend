// @effect-diagnostics nodeBuiltinImport:off -- A local HTTP server stands in for the release host.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { FRP_VERSION, type FrpArchive } from "./forkFrp.ts";
import { checkFrpcVersion, fetchFrpc, FrpFetchError } from "./forkFrpFetch.ts";

let root: string;
let server: NodeHttp.Server | undefined;

beforeEach(async () => {
  root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3x-frpfetch-test-"));
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
  await NodeFSP.rm(root, { recursive: true, force: true });
});

/** A tar.gz shaped like the release's: one top-level directory holding `frpc`. */
const makeArchive = async (printed: string) => {
  const staging = NodePath.join(root, "staging", `frp_${FRP_VERSION}_linux_amd64`);
  await NodeFSP.mkdir(staging, { recursive: true });
  await NodeFSP.writeFile(
    NodePath.join(staging, "frpc"),
    `#!${process.execPath}\nconsole.log(${JSON.stringify(printed)});\n`,
    { mode: 0o755 },
  );
  const file = NodePath.join(root, "fake.tar.gz");
  NodeChildProcess.execFileSync("tar", ["-czf", file, "-C", NodePath.join(root, "staging"), "."]);
  const bytes = await NodeFSP.readFile(file);
  return {
    bytes,
    entry: {
      file: `frp_${FRP_VERSION}_linux_amd64.tar.gz`,
      sha256: NodeCrypto.createHash("sha256").update(bytes).digest("hex"),
      executable: "frpc",
    } satisfies FrpArchive,
  };
};

const serve = async (respond: (url: string) => { status: number; body: Uint8Array | string }) => {
  const requests: Array<string> = [];
  server = NodeHttp.createServer((request, response) => {
    requests.push(request.url ?? "");
    const { status, body } = respond(request.url ?? "");
    response.writeHead(status).end(body);
  });
  await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return { baseUrl: `http://127.0.0.1:${port}/mirror`, requests };
};

const problemOf = async (promise: Promise<unknown>) =>
  promise.then(
    () => "no error",
    (error: unknown) => (error instanceof FrpFetchError ? error.problem : String(error)),
  );

describe("fetchFrpc", () => {
  it("downloads from a mirror, checks the SHA-256, and installs an executable that reports the pinned version", async () => {
    const { bytes, entry } = await makeArchive(FRP_VERSION);
    const { baseUrl, requests } = await serve(() => ({ status: 200, body: bytes }));
    const destination = NodePath.join(root, "home", "bin");

    const result = await fetchFrpc({ platform: "linux", arch: "x64", destination, baseUrl, entry });

    expect(requests).toEqual([`/mirror/${entry.file}`]);
    expect(result.path).toBe(NodePath.join(destination, "frpc"));
    expect((await NodeFSP.stat(result.path)).mode & 0o777).toBe(0o755);
    expect(await checkFrpcVersion(result.path)).toEqual({ ok: true });
    expect(await NodeFSP.readdir(destination)).toEqual(["frpc"]);
  });

  it("refuses a mirror's bytes that do not match the pinned SHA-256 and leaves nothing behind", async () => {
    const { entry } = await makeArchive(FRP_VERSION);
    const { baseUrl } = await serve(() => ({ status: 200, body: "not the archive" }));
    const destination = NodePath.join(root, "home", "bin");

    expect(
      await problemOf(fetchFrpc({ platform: "linux", arch: "x64", destination, baseUrl, entry })),
    ).toBe("checksum-mismatch");
    expect(await NodeFSP.stat(destination).catch(() => undefined)).toBeUndefined();
  });

  it("reports a failed download and an unknown platform", async () => {
    const { entry } = await makeArchive(FRP_VERSION);
    const { baseUrl } = await serve(() => ({ status: 404, body: "" }));
    const destination = NodePath.join(root, "bin");

    expect(
      await problemOf(fetchFrpc({ platform: "linux", arch: "x64", destination, baseUrl, entry })),
    ).toBe("download-failed");
    expect(await problemOf(fetchFrpc({ platform: "sunos", arch: "x64", destination }))).toBe(
      "unsupported-platform",
    );
  });
});

describe("checkFrpcVersion", () => {
  it("accepts only the exact pinned version", async () => {
    const good = await makeArchive(FRP_VERSION);
    const old = await makeArchive("0.70.0");
    const unpack = async (name: string, bytes: Uint8Array) => {
      const dir = NodePath.join(root, name);
      await NodeFSP.mkdir(dir);
      const archive = NodePath.join(dir, "a.tar.gz");
      await NodeFSP.writeFile(archive, bytes);
      NodeChildProcess.execFileSync("tar", ["-xf", archive, "-C", dir]);
      return NodePath.join(dir, `frp_${FRP_VERSION}_linux_amd64`, "frpc");
    };
    expect(await checkFrpcVersion(await unpack("good", good.bytes))).toEqual({ ok: true });
    expect(await checkFrpcVersion(await unpack("old", old.bytes))).toEqual({
      ok: false,
      reason: "wrong-version",
      found: "0.70.0",
    });
    expect(await checkFrpcVersion(NodePath.join(root, "missing"))).toEqual({
      ok: false,
      reason: "not-runnable",
      found: "",
    });
  });
});
