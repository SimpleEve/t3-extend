// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a linear build pipeline of external tools.
// T3 Extend: build the Windows x64 NSIS installer with the repo's packager and check what went in.
// The installer is unsigned (there is no Windows certificate), so SmartScreen shows "Unknown
// publisher"; see FORK.md "打包与签名". Identity comes from forkIdentity.ts, and frpc is staged by
// build-desktop-artifact.ts (`stageForkFrpc`).
import { extractFile } from "@electron/asar";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { FRP_VERSION } from "@t3tools/shared/forkFrp";
import { checkFrpcVersion, fetchFrpc } from "@t3tools/shared/forkFrpFetch";
import { FORK } from "@t3tools/shared/forkIdentity";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { frpcCacheDirectory } from "./lib/fork-frpc.ts";

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const installerStem = FORK.appBaseName.replaceAll(" ", "-");
const bundledFrpcMember = "resources/bin/frpc.exe";

const { values: flags } = NodeUtil.parseArgs({
  options: {
    "output-dir": { type: "string", default: "release/fork-win" },
    "skip-build": { type: "boolean", default: false },
  },
});
const outputDir = NodePath.resolve(repoRoot, flags["output-dir"]);

function run(command: string, args: ReadonlyArray<string>): void {
  log(`$ ${command} ${args.join(" ")}`);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    // Signing is never configured here; an inherited flag must not turn it on.
    env: { ...process.env, T3CODE_DESKTOP_SIGNED: undefined },
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${String(result.status ?? result.signal)}`);
  }
}

function capture(command: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync(command, args, {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

/** 7-Zip reads the NSIS installer and the 7z archive inside it; the Windows runners have it. */
function findSevenZip(): string {
  const candidates = [
    "7z",
    "7zz",
    "7za",
    NodePath.join(process.env.ProgramFiles ?? "C:\\Program Files", "7-Zip", "7z.exe"),
  ];
  for (const candidate of candidates) {
    if (NodeChildProcess.spawnSync(candidate, ["i"], { stdio: "ignore" }).status === 0) {
      return candidate;
    }
  }
  throw new Error("7-Zip (7z, 7zz or 7za) is needed to check the installer and was not found.");
}

/** Archive member names from `7z l -slt`, which prints one "Path = …" line per entry. */
function listMembers(sevenZip: string, archive: string): ReadonlyArray<string> {
  return capture(sevenZip, ["l", "-slt", "-ba", archive])
    .split(/\r?\n/u)
    .flatMap((line) => (line.startsWith("Path = ") ? [line.slice("Path = ".length)] : []))
    .map((member) => member.replaceAll("\\", "/"));
}

function sha256(filePath: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");
}

function buildInstaller(): void {
  run("node", [
    "scripts/build-desktop-artifact.ts",
    "--platform",
    "win",
    "--target",
    "nsis",
    "--arch",
    "x64",
    "--output-dir",
    outputDir,
    ...(flags["skip-build"] ? ["--skip-build"] : []),
  ]);
}

function findInstaller(): string {
  const installers = NodeFS.existsSync(outputDir)
    ? NodeFS.readdirSync(outputDir).filter((entry) =>
        new RegExp(`^${installerStem}-.+-x64\\.exe$`, "u").test(entry),
      )
    : [];
  if (installers.length !== 1) {
    throw new Error(
      `Expected one ${installerStem}-<version>-x64.exe in ${outputDir}, found ${JSON.stringify(installers)}.`,
    );
  }
  return NodePath.join(outputDir, installers[0]!);
}

/** Remove this script's own outputs so a rerun never sees a stale installer or update manifest. */
function cleanOutputs(): void {
  if (!NodeFS.existsSync(outputDir)) return;
  for (const entry of NodeFS.readdirSync(outputDir)) {
    if (
      entry === "latest.yml" ||
      (entry.startsWith(`${installerStem}-`) && /-x64\.exe(\.blockmap|\.sha256)?$/u.test(entry))
    ) {
      NodeFS.rmSync(NodePath.join(outputDir, entry), { force: true });
    }
  }
}

/** The pinned frpc.exe, unpacked from the SHA-256 checked archive, to compare with the shipped one. */
async function pinnedFrpcDigest(scratch: string): Promise<string> {
  const fetched = await fetchFrpc({
    platform: "win32",
    arch: "x64",
    destination: NodePath.join(scratch, "pinned"),
    archiveCacheDir: frpcCacheDirectory("win32", "x64"),
    baseUrl: process.env.T3X_FRP_BASE_URL,
  });
  return sha256(fetched.path);
}

async function verifyInstaller(installerPath: string): Promise<void> {
  const sevenZip = findSevenZip();
  const scratch = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-verify-win-"));
  try {
    // electron-builder's NSIS installer keeps the whole app in one 7z archive under $PLUGINSDIR.
    const appArchiveMember = listMembers(sevenZip, installerPath).find((member) =>
      /(^|\/)app-64\.7z$/u.test(member),
    );
    if (appArchiveMember === undefined) {
      throw new Error("The installer has no app-64.7z, so it is not an x64 electron-builder NSIS.");
    }
    const outerDir = NodePath.join(scratch, "installer");
    run(sevenZip, ["x", installerPath, `-o${outerDir}`, "-y", appArchiveMember]);
    const appArchive = NodePath.join(outerDir, ...appArchiveMember.split("/"));

    const members = listMembers(sevenZip, appArchive);
    const rootExecutables = members.filter((member) => /^[^/]+\.exe$/u.test(member));
    const appExecutable = rootExecutables.find((member) =>
      member.startsWith(`${FORK.appBaseName} (`),
    );
    const others = rootExecutables.filter((member) => member !== appExecutable);
    if (appExecutable === undefined) {
      throw new Error(
        `No "${FORK.appBaseName} (…).exe" in the installer; found ${JSON.stringify(rootExecutables)}.`,
      );
    }
    log(
      `App executable: ${appExecutable}${others.length > 0 ? ` (also ${others.join(", ")})` : ""}`,
    );
    for (const required of [
      bundledFrpcMember,
      "resources/app.asar",
      "resources/server.asar",
      // The MIT notice travels with the binary.
      "resources/LICENSE",
      "resources/NOTICE",
    ]) {
      if (!members.includes(required))
        throw new Error(`${required} is missing from the installer.`);
    }

    const appDir = NodePath.join(scratch, "app");
    run(sevenZip, ["x", appArchive, `-o${appDir}`, "-y", bundledFrpcMember, "resources/app.asar"]);

    // The package manifest inside app.asar is where Electron takes its fallback app name from.
    const manifest = JSON.parse(
      extractFile(NodePath.join(appDir, "resources", "app.asar"), "package.json").toString("utf8"),
    ) as { readonly name?: string };
    if (manifest.name !== FORK.userDataDir) {
      throw new Error(`app.asar names the app "${manifest.name}", not "${FORK.userDataDir}".`);
    }

    const shippedFrpc = NodePath.join(appDir, ...bundledFrpcMember.split("/"));
    const [shipped, pinned] = [sha256(shippedFrpc), await pinnedFrpcDigest(scratch)];
    if (shipped !== pinned) {
      throw new Error(
        `The shipped frpc.exe (${shipped}) is not the pinned ${FRP_VERSION} (${pinned}).`,
      );
    }
    log(`frpc.exe is the pinned ${FRP_VERSION} (sha256 ${shipped}).`);
    // A cross build cannot run it; on a Windows host `frpc -v` must say the pinned version.
    if (HostProcess.Platform.defaultValue() === "win32") {
      const check = await checkFrpcVersion(shippedFrpc);
      if (!check.ok) {
        throw new Error(
          `frpc.exe -v did not report ${FRP_VERSION}: ${check.reason} ${check.found}`,
        );
      }
      log(`frpc.exe -v: ${FRP_VERSION}`);
    }
  } finally {
    NodeFS.rmSync(scratch, { recursive: true, force: true });
  }
}

/**
 * With a feed configured electron-builder writes `latest.yml` and the installer's blockmap; an installed
 * app updates from them, so `latest.yml` must name the installer that gets uploaded. It stays unchecked
 * for a build without a feed.
 */
function verifyUpdateFeed(installerPath: string): void {
  if (!process.env.T3CODE_DESKTOP_UPDATE_REPOSITORY?.trim()) {
    log("T3CODE_DESKTOP_UPDATE_REPOSITORY is unset: no update feed to check.");
    return;
  }
  const manifestPath = NodePath.join(outputDir, "latest.yml");
  const installerName = NodePath.basename(installerPath);
  if (!NodeFS.existsSync(manifestPath) || !NodeFS.existsSync(`${installerPath}.blockmap`)) {
    throw new Error(`The build has an update feed but ${manifestPath} or the blockmap is missing.`);
  }
  const manifest = NodeFS.readFileSync(manifestPath, "utf8");
  const urls = [...manifest.matchAll(/^ {2}- url: (.+)$/gmu)].map((match) => match[1]);
  if (
    !urls.includes(installerName) ||
    !new RegExp(`^path: '?${installerName.replaceAll(".", "\\.")}'?$`, "mu").test(manifest)
  ) {
    throw new Error(`latest.yml does not name ${installerName}:\n${manifest}`);
  }
  log(`Update feed: latest.yml names ${installerName}, blockmap present.`);
}

cleanOutputs();
buildInstaller();
const installerPath = findInstaller();
await verifyInstaller(installerPath);
verifyUpdateFeed(installerPath);
const digest = sha256(installerPath);
NodeFS.writeFileSync(`${installerPath}.sha256`, `${digest}  ${NodePath.basename(installerPath)}\n`);
log(`\nInstaller: ${installerPath}\nsha256: ${digest}`);
