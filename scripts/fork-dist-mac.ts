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

function verifyApp(appPath: string): void {
  capture("codesign", ["--verify", "--deep", "--strict", "--verbose=2", appPath]);
  const details = capture("codesign", ["-dv", "--verbose=4", appPath]);
  if (!details.includes(`Authority=${identity}`)) {
    throw new Error(`The app is not signed by ${identity}:\n${details}`);
  }
  if (!/^TeamIdentifier=not set$/mu.test(details)) {
    throw new Error(`The app unexpectedly carries a Team ID:\n${details}`);
  }
  if (!/flags=0x10000\(runtime\)/u.test(details)) {
    throw new Error(`The app is not signed with the hardened runtime:\n${details}`);
  }
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
    NodeFS.rmSync(dmgPath, { force: true });
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

function verifyDmg(dmgPath: string, appName: string): void {
  const mountPoint = NodeFS.mkdtempSync(NodePath.join(outputDir, ".mnt-"));
  run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountPoint, dmgPath]);
  try {
    const mountedApp = NodePath.join(mountPoint, appName);
    if (!NodeFS.existsSync(mountedApp)) {
      throw new Error(`${appName} is missing from the mounted DMG.`);
    }
    capture("codesign", ["--verify", "--deep", "--strict", mountedApp]);
  } finally {
    run("hdiutil", ["detach", mountPoint]);
    NodeFS.rmSync(mountPoint, { recursive: true, force: true });
  }
}

function sha256(filePath: string): string {
  return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(filePath)).digest("hex");
}

const identityHash = preflight();
if (!flags["skip-build"]) buildApp();
const appPath = findApp();
await signApp(appPath, identityHash);
verifyApp(appPath);
const dmgPath = buildDmg(appPath, identityHash);
verifyDmg(dmgPath, NodePath.basename(appPath));
const digest = sha256(dmgPath);
NodeFS.writeFileSync(`${dmgPath}.sha256`, `${digest}  ${NodePath.basename(dmgPath)}\n`);
log(`\nApp: ${appPath}\nDMG: ${dmgPath}\nsha256: ${digest}`);
