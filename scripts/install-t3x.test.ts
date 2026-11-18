// @effect-diagnostics nodeBuiltinImport:off - Drives the real shell installer against a local release fixture.
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import { describe, expect, it } from "vite-plus/test";

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);
const script = NodePath.resolve(import.meta.dirname, "install-t3x.sh");

// The installer's own platform check, so the fixture archive carries the name it asks for.
const hostPlatform = HostProcess.Platform.defaultValue();
const hostArch = HostProcess.Architecture.defaultValue();
const platformKey =
  hostPlatform === "darwin" && hostArch === "arm64"
    ? "darwin-arm64"
    : hostPlatform === "linux" && (hostArch === "x64" || hostArch === "arm64")
      ? `linux-${hostArch}`
      : undefined;

async function withFixture<T>(
  options: { readonly corrupt?: boolean },
  body: (fixture: {
    readonly baseUrl: string;
    readonly home: string;
    readonly t3xHome: string;
    readonly binDir: string;
    readonly install: (
      env?: Record<string, string>,
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
  }) => Promise<T>,
): Promise<T> {
  const root = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3x-install-")),
  );
  const version = "1.2.3";
  const stem = `t3-${version}-${platformKey}`;
  const archiveName = `${stem}.tar.gz`;
  try {
    const content = NodePath.join(root, "content", stem);
    await NodeFSP.mkdir(content, { recursive: true });
    await NodeFSP.writeFile(NodePath.join(content, "t3"), `#!/bin/sh\necho "t3 v${version}"\n`, {
      mode: 0o755,
    });
    const archivePath = NodePath.join(root, archiveName);
    await execFile("tar", ["-czf", archivePath, "-C", NodePath.join(root, "content"), stem]);
    const archive = await NodeFSP.readFile(archivePath);
    const digest = NodeCrypto.createHash("sha256")
      .update(options.corrupt ? "something else" : archive)
      .digest("hex");
    const sums = `${digest}  ${archiveName}\n`;
    const server = NodeHttp.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://fixture");
      if (url.pathname === `/download/v${version}/SHA256SUMS`) return response.end(sums);
      if (url.pathname === `/download/v${version}/${archiveName}`) return response.end(archive);
      if (url.pathname === "/latest" && request.headers.accept === "application/json") {
        return response.end(`{"id":1,"tag_name":"v${version}","draft":false}`);
      }
      response.writeHead(404).end();
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;
    const baseUrl = `http://127.0.0.1:${port}`;
    const home = NodePath.join(root, "home");
    const t3xHome = NodePath.join(root, "t3x-home");
    const binDir = NodePath.join(root, "bin");
    await NodeFSP.mkdir(home, { recursive: true });
    try {
      return await body({
        baseUrl,
        home,
        t3xHome,
        binDir,
        install: async (env = {}) => {
          try {
            const { stdout, stderr } = await execFile("sh", [script], {
              env: {
                PATH: process.env.PATH ?? "",
                HOME: home,
                T3X_HOME: t3xHome,
                T3X_INSTALL_BIN_DIR: binDir,
                T3X_RELEASE_BASE_URL: `${baseUrl}/download`,
                T3X_LATEST_URL: `${baseUrl}/latest`,
                T3X_VERSION: version,
                ...env,
              },
            });
            return { code: 0, stdout, stderr };
          } catch (error) {
            const failure = error as { code?: number; stdout?: string; stderr?: string };
            return {
              code: failure.code ?? 1,
              stdout: failure.stdout ?? "",
              stderr: failure.stderr ?? "",
            };
          }
        },
      });
    } finally {
      server.close();
    }
  } finally {
    await NodeFSP.rm(root, { recursive: true, force: true });
  }
}

describe.skipIf(platformKey === undefined)("install-t3x.sh", () => {
  it("installs the runtime and a t3x launcher, finds the latest release, and leaves official T3 Code alone", async () => {
    await withFixture({}, async ({ home, t3xHome, binDir, install }) => {
      // Official T3 Code's launcher and home sit next to ours; neither may change.
      await NodeFSP.mkdir(binDir, { recursive: true });
      const officialLauncher = NodePath.join(binDir, "t3");
      await NodeFSP.writeFile(officialLauncher, "#!/bin/sh\necho official\n", { mode: 0o755 });
      await NodeFSP.mkdir(NodePath.join(home, ".t3"), { recursive: true });

      // No T3X_VERSION: the version comes from the latest-release lookup.
      const first = await install({ T3X_VERSION: "" });
      expect(first.code, first.stderr).toBe(0);

      const entry = NodePath.join(t3xHome, "runtime/versions/1.2.3/t3");
      expect(
        await NodeFSP.readFile(
          NodePath.join(t3xHome, "runtime/versions/1.2.3/.install-complete"),
          "utf8",
        ),
      ).toBe("1.2.3\n");
      // Exactly what `t3x update` recognises and rewrites.
      expect(await NodeFSP.readFile(NodePath.join(binDir, "t3x"), "utf8")).toBe(
        `#!/bin/sh\nexec '${entry}' "$@"\n`,
      );
      expect(await NodeFSP.readFile(NodePath.join(t3xHome, "runtime/launchers"), "utf8")).toBe(
        `${NodePath.join(binDir, "t3x")}\n`,
      );
      const { stdout } = await execFile(NodePath.join(binDir, "t3x"), ["--version"]);
      expect(stdout.trim()).toBe("t3 v1.2.3");

      expect(await NodeFSP.readFile(officialLauncher, "utf8")).toBe("#!/bin/sh\necho official\n");
      expect(await NodeFSP.readdir(NodePath.join(home, ".t3"))).toEqual([]);
      expect(await NodeFSP.readdir(home)).toEqual([".t3"]);

      // Running it again replaces its own launcher and keeps one launchers record.
      const second = await install();
      expect(second.code, second.stderr).toBe(0);
      expect(await NodeFSP.readFile(NodePath.join(t3xHome, "runtime/launchers"), "utf8")).toBe(
        `${NodePath.join(binDir, "t3x")}\n`,
      );
    });
  });

  it("refuses official T3 Code's home, a corrupt download, and a t3x it does not own", async () => {
    await withFixture({}, async ({ home, binDir, install }) => {
      const official = await install({ T3X_HOME: NodePath.join(home, ".t3") });
      expect(official.code).not.toBe(0);
      expect(official.stderr).toContain("official T3 Code's home");
      await expect(NodeFSP.stat(NodePath.join(home, ".t3"))).rejects.toThrow();

      // A symlink that resolves to the official home is the same home.
      await NodeFSP.mkdir(NodePath.join(home, ".t3"), { recursive: true });
      await NodeFSP.symlink(NodePath.join(home, ".t3"), NodePath.join(home, "alias"));
      const alias = await install({ T3X_HOME: NodePath.join(home, "alias") });
      expect(alias.code).not.toBe(0);
      expect(await NodeFSP.readdir(NodePath.join(home, ".t3"))).toEqual([]);

      await NodeFSP.mkdir(binDir, { recursive: true });
      await NodeFSP.writeFile(NodePath.join(binDir, "t3x"), "#!/bin/sh\necho mine\n", {
        mode: 0o755,
      });
      const foreign = await install();
      expect(foreign.code).not.toBe(0);
      expect(foreign.stderr).toContain("another t3x is already");
      expect(await NodeFSP.readFile(NodePath.join(binDir, "t3x"), "utf8")).toBe(
        "#!/bin/sh\necho mine\n",
      );
    });
    await withFixture({ corrupt: true }, async ({ t3xHome, binDir, install }) => {
      const result = await install();
      expect(result.code).not.toBe(0);
      expect(result.stderr).toContain("checksum mismatch");
      // Nothing was published: no version directory, no launcher.
      await expect(
        NodeFSP.stat(NodePath.join(t3xHome, "runtime/versions/1.2.3")),
      ).rejects.toThrow();
      await expect(NodeFSP.stat(NodePath.join(binDir, "t3x"))).rejects.toThrow();
    });
  });
});
