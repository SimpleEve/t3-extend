// @effect-diagnostics nodeBuiltinImport:off - a linear build pipeline of external tools.
// T3 Extend: build the macOS app with the repo's packager, sign it with a local (self-signed)
// identity, and wrap it in a DMG. Upstream's `--signed` path needs an Apple Team ID and a
// provisioning profile, so this signs after the build instead. See FORK.md "打包与签名".
import { sign } from "@electron/osx-sign";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";

import { FORK } from "@t3tools/shared/forkIdentity";

const log = (message: string): void => {
  process.stdout.write(`${message}\n`);
};

const repoRoot = NodePath.resolve(import.meta.dirname, "..");
const entitlementsDir = NodePath.join(repoRoot, "packaging/fork-macos");

const { values: flags } = NodeUtil.parseArgs({
  options: {
    identity: { type: "string", default: process.env.T3EXTEND_MAC_SIGN_IDENTITY ?? "T3 Extend Code Signing" },
    "rust-toolchain": { type: "string", default: process.env.T3EXTEND_RUST_TOOLCHAIN ?? "1.95.0" },
    "output-dir": { type: "string", default: "release/fork-mac" },
    "skip-build": { type: "boolean", default: false },
  },
});
const identity = flags.identity;
const outputDir = NodePath.resolve(repoRoot, flags["output-dir"]);

function run(command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): void {
  log(`$ ${command} ${args.join(" ")}`);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: repoRoot,
    env: env ?? process.env,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${String(result.status ?? result.signal)}`);
  }
}

function capture(command: string, args: ReadonlyArray<string>): string {
  const result = NodeChildProcess.spawnSync(command, args, { cwd: repoRoot, encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stderr}`);
  }
  // codesign -dv writes its report to stderr.
  return `${result.stdout}${result.stderr}`;
}

/** SHA-1 of the identity. Self-signed certificates are only valid under the codesigning policy. */
function resolveIdentityHash(): string {
  const identities = capture("security", ["find-identity", "-v", "-p", "codesigning"]);
  const matches = identities
    .split("\n")
    .map((line) => /^\s*\d+\) ([0-9A-F]{40}) "(.*)"$/u.exec(line))
    .filter((match) => match?.[2] === identity);
  if (matches.length !== 1) {
    throw new Error(`Expected one valid "${identity}" code signing identity:\n${identities}`);
  }
  return matches[0]![1]!;
}

function preflight(): string {
  // sysinfo needs a newer rustc than the default toolchain; RUSTUP_TOOLCHAIN pins it per process.
  capture("rustup", ["run", flags["rust-toolchain"], "rustc", "--version"]);
  return resolveIdentityHash();
}

function buildApp(): void {
  const env: NodeJS.ProcessEnv = { ...process.env, RUSTUP_TOOLCHAIN: flags["rust-toolchain"] };
  delete env.T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR;
  delete env.T3CODE_DESKTOP_SIGNED;
  run(
    "node",
    [
      "scripts/build-desktop-artifact.ts",
      "--platform",
      "mac",
      "--target",
      "dir",
      "--arch",
      "arm64",
      "--output-dir",
      outputDir,
    ],
    env,
  );
}

function findApp(): string {
  const appDir = NodePath.join(outputDir, "mac-arm64");
  const apps = NodeFS.existsSync(appDir)
    ? NodeFS.readdirSync(appDir).filter((entry) => entry.endsWith(".app"))
    : [];
  if (apps.length !== 1) {
    throw new Error(`Expected one .app in ${appDir}, found ${JSON.stringify(apps)}.`);
  }
  return NodePath.join(appDir, apps[0]!);
}

async function signApp(appPath: string, identityHash: string): Promise<void> {
  const mainEntitlements = NodePath.join(entitlementsDir, "entitlements.plist");
  const inheritEntitlements = NodePath.join(entitlementsDir, "entitlements.inherit.plist");
  log(`Signing ${appPath} as "${identity}"...`);
  // osx-sign walks the bundle and signs inside out: nested binaries, frameworks, helpers, app.
  await sign({
    app: appPath,
    identity: identityHash,
    // osx-sign's own lookup omits `-p codesigning` and so never sees a self-signed identity.
    identityValidation: false,
    platform: "darwin",
    preAutoEntitlements: false,
    preEmbedProvisioningProfile: false,
    batchCodesignCalls: true,
    optionsForFile: (filePath) => ({
      entitlements: filePath === appPath ? mainEntitlements : inheritEntitlements,
      hardenedRuntime: true,
      // Apple's timestamp service only countersigns Apple-issued certificates.
      timestamp: "none",
    }),
  });
}

/** Regular files only; recursive readdir would follow framework `Versions/Current` symlinks. */
function regularFiles(directory: string): ReadonlyArray<string> {
  return NodeFS.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const entryPath = NodePath.join(directory, entry.name);
    if (entry.isDirectory()) return regularFiles(entryPath);
    return entry.isFile() ? [entryPath] : [];
  });
}

function listMachO(appPath: string): ReadonlyArray<string> {
  const files = regularFiles(appPath);
  // -0 ends each name with NUL, so names containing ": " parse unambiguously. Universal
  // binaries add "(for architecture …)" lines whose name is not in `files`; they are skipped.
  const fileNames = new Set(files);
  return capture("file", ["-0", "-N", "--", ...files])
    .split("\n")
    .map((line) => line.split("\0"))
    .filter(([name, description]) => fileNames.has(name!) && description?.includes("Mach-O"))
    .map(([name]) => name!);
}

function signatureProblem(filePath: string): string | undefined {
  const verified = NodeChildProcess.spawnSync("codesign", ["--verify", "--strict", filePath], {
    encoding: "utf8",
  });
  if (verified.status !== 0) return verified.stderr.trim() || "codesign --verify failed";
  const details = capture("codesign", ["-dv", "--verbose=4", filePath]);
  if (!details.includes(`Authority=${identity}\n`)) return `not signed by ${identity}`;
  if (!/^CodeDirectory .*flags=0x[0-9a-f]+\([^)]*\bruntime\b/mu.test(details)) {
    return "no hardened runtime flag";
  }
  return undefined;
}

function verifyApp(appPath: string): void {
  // Per-file checks come first so a failure names the offending files.
  const machO = listMachO(appPath);
  if (machO.length === 0) throw new Error(`No Mach-O files found in ${appPath}.`);
  const problems = machO.flatMap((filePath) => {
    const problem = signatureProblem(filePath);
    return problem === undefined ? [] : [`${NodePath.relative(appPath, filePath)}: ${problem}`];
  });
  if (problems.length > 0) {
    throw new Error(`Mach-O signature check failed in ${appPath}:\n${problems.join("\n")}`);
  }
  capture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const details = capture("codesign", ["-dv", "--verbose=4", appPath]);
  if (!/^TeamIdentifier=not set$/mu.test(details)) {
    throw new Error(`The app unexpectedly carries a Team ID:\n${details}`);
  }
  log(`Verified ${machO.length} Mach-O files in ${NodePath.basename(appPath)}.`);
}

function plistValue(appPath: string, key: string): string {
  return capture("plutil", [
    "-extract",
    key,
    "raw",
    NodePath.join(appPath, "Contents/Info.plist"),
  ]).trim();
}

function buildDmg(appPath: string, identityHash: string): string {
  const productName = plistValue(appPath, "CFBundleName");
  const version = plistValue(appPath, "CFBundleShortVersionString");
  const dmgPath = NodePath.join(
    outputDir,
    `${FORK.appBaseName.replaceAll(" ", "-")}-${version}-arm64.dmg`,
  );
  const staging = NodeFS.mkdtempSync(NodePath.join(outputDir, ".dmg-"));
  try {
    // ditto keeps the signature's extended attributes and symlinks intact.
    run("ditto", [appPath, NodePath.join(staging, NodePath.basename(appPath))]);
    NodeFS.symlinkSync("/Applications", NodePath.join(staging, "Applications"));
    run("hdiutil", [
      "create",
      "-volname",
      `${productName} ${version}`,
      "-srcfolder",
      staging,
      "-fs",
      "HFS+",
      "-format",
      "UDZO",
      "-ov",
      dmgPath,
    ]);
  } finally {
    NodeFS.rmSync(staging, { recursive: true, force: true });
  }
  run("codesign", ["--force", "--sign", identityHash, "--timestamp=none", dmgPath]);
  return dmgPath;
}

function tryRun(command: string, args: ReadonlyArray<string>): boolean {
  log(`$ ${command} ${args.join(" ")}`);
  return NodeChildProcess.spawnSync(command, args, { stdio: "inherit" }).status === 0;
}

function verifyDmg(dmgPath: string, appName: string): void {
  const mountPoint = NodeFS.mkdtempSync(NodePath.join(outputDir, ".mnt-"));
  let attached = false;
  let failure: unknown;
  try {
    run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgPath]);
    attached = true;
    const mountedApp = NodePath.join(mountPoint, appName);
    if (!NodeFS.existsSync(mountedApp)) {
      throw new Error(`${appName} is missing from the mounted DMG.`);
    }
    verifyApp(mountedApp);
  } catch (error) {
    failure = error;
  }
  // Cleanup must not mask the verification error, and must never delete through a live mount.
  const detached =
    !attached ||
    tryRun("hdiutil", ["detach", mountPoint]) ||
    tryRun("hdiutil", ["detach", "-force", mountPoint]);
  if (detached) NodeFS.rmSync(mountPoint, { recursive: true, force: true });
  if (failure !== undefined) throw failure;
  if (!detached) throw new Error(`Could not detach ${mountPoint}; detach it by hand.`);
}

function sha256(filePath: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");
}

/** Remove this script's own outputs so a rerun never sees a stale .app, DMG or checksum. */
function cleanOutputs(): void {
  if (!NodeFS.existsSync(outputDir)) return;
  const dmgPrefix = `${FORK.appBaseName.replaceAll(" ", "-")}-`;
  for (const entry of NodeFS.readdirSync(outputDir)) {
    const ours =
      (!flags["skip-build"] && entry === "mac-arm64") ||
      (entry.startsWith(dmgPrefix) && /-arm64\.dmg(\.sha256)?$/u.test(entry));
    if (ours) NodeFS.rmSync(NodePath.join(outputDir, entry), { recursive: true, force: true });
  }
}

const identityHash = preflight();
cleanOutputs();
if (!flags["skip-build"]) buildApp();
const appPath = findApp();
await signApp(appPath, identityHash);
verifyApp(appPath);
const dmgPath = buildDmg(appPath, identityHash);
verifyDmg(dmgPath, NodePath.basename(appPath));
const digest = sha256(dmgPath);
NodeFS.writeFileSync(`${dmgPath}.sha256`, `${digest}  ${NodePath.basename(dmgPath)}\n`);
log(`\nApp: ${appPath}\nDMG: ${dmgPath}\nsha256: ${digest}`);
