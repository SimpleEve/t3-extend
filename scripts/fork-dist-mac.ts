// @effect-diagnostics nodeBuiltinImport:off globalDate:off - a linear build pipeline of external tools.
// T3 Extend: build the macOS app with the repo's packager, sign it with the fork's own
// self-signed identity, and wrap it in a DMG. Upstream's `--signed` path needs an Apple Team ID
// and a provisioning profile, so this signs after the build instead. `--create-identity` makes
// the identity once per machine. See FORK.md "打包与签名".
import { sign } from "@electron/osx-sign";
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
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
    identity: {
      type: "string",
      default: process.env.T3EXTEND_MAC_SIGN_IDENTITY ?? "T3 Extend Code Signing",
    },
    "rust-toolchain": { type: "string", default: process.env.T3EXTEND_RUST_TOOLCHAIN ?? "1.95.0" },
    "output-dir": { type: "string", default: "release/fork-mac" },
    "skip-build": { type: "boolean", default: false },
    "create-identity": { type: "boolean", default: false },
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

interface ListedIdentity {
  readonly hash: string;
  readonly status: string | undefined;
}

/** `-p codesigning` without `-v`: a self-signed certificate without trust settings still lists. */
function listIdentities(name: string): ReadonlyArray<ListedIdentity> {
  const listing = capture("security", ["find-identity", "-p", "codesigning"]);
  const found = new Map<string, ListedIdentity>();
  // The report repeats every identity under "Matching" and "Valid"; the hash dedupes.
  for (const line of listing.split("\n")) {
    const match = /^\s*\d+\) ([0-9A-F]{40}) "(.*)"(?: \((.*)\))?$/u.exec(line);
    if (match?.[2] === name) found.set(match[1]!, { hash: match[1]!, status: match[3] });
  }
  return [...found.values()];
}

function certificateByHash(name: string, hash: string): NodeCrypto.X509Certificate | undefined {
  const pem = NodeChildProcess.spawnSync("security", ["find-certificate", "-a", "-c", name, "-p"], {
    encoding: "utf8",
  }).stdout;
  return (pem.match(/-----BEGIN CERTIFICATE-----[^-]+-----END CERTIFICATE-----/gu) ?? [])
    .map((block) => new NodeCrypto.X509Certificate(block))
    .find((certificate) => certificate.fingerprint.replaceAll(":", "") === hash);
}

/** SHA-1 of the one valid, unexpired identity called `identity` under the codesigning policy. */
function resolveIdentityHash(): string {
  const matches = listIdentities(identity);
  if (matches.length !== 1) {
    throw new Error(
      `Expected exactly one "${identity}" code signing identity, found ${matches.length}. ` +
        "Create it once with --create-identity (see FORK.md).",
    );
  }
  const { hash, status } = matches[0]!;
  if (status !== undefined && /EXPIRED|REVOKED/u.test(status)) {
    throw new Error(`"${identity}" (${hash}) is not usable: ${status}.`);
  }
  const certificate = certificateByHash(identity, hash);
  if (certificate === undefined) throw new Error(`No certificate for "${identity}" (${hash}).`);
  const now = Date.now();
  if (now < Date.parse(certificate.validFrom) || now > Date.parse(certificate.validTo)) {
    throw new Error(`"${identity}" (${hash}) is outside its validity period.`);
  }
  log(`Signing identity "${identity}" ${hash}${status === undefined ? "" : ` (${status})`}`);
  return hash;
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

const loginKeychain = NodePath.join(NodeOS.homedir(), "Library/Keychains/login.keychain-db");
const identityPasswordVariable = "T3EXTEND_IDENTITY_P12_PASSWORD";

/** Removes the certificate and its private key by exact hash; no trust settings exist to clean. */
function removeCreatedIdentity(hash: string): string | undefined {
  if (certificateByHash(identity, hash) === undefined) return undefined;
  const deleteArgs = ["-Z", hash, loginKeychain];
  const removed =
    succeeds("security", ["delete-identity", ...deleteArgs]) ||
    succeeds("security", ["delete-certificate", ...deleteArgs]);
  return removed
    ? undefined
    : `Could not remove the created identity ${hash} from the login keychain; delete it in Keychain Access before retrying.`;
}

function succeeds(command: string, args: ReadonlyArray<string>): boolean {
  return NodeChildProcess.spawnSync(command, args, { stdio: "ignore" }).status === 0;
}

/** A codesign that hangs is waiting for a keychain prompt; kill the one process we started. */
function trialSign(hash: string, timeoutMs: number): void {
  const startedAt = Date.now();
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-trial-sign-"));
  try {
    const binary = NodePath.join(directory, "trial");
    NodeFS.copyFileSync("/usr/bin/true", binary);
    NodeFS.chmodSync(binary, 0o755);
    const signed = NodeChildProcess.spawnSync(
      "codesign",
      ["--force", "--sign", hash, "--timestamp=none", "--options", "runtime", binary],
      { encoding: "utf8", timeout: timeoutMs, killSignal: "SIGKILL" },
    );
    if ((signed.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT") {
      throw new Error(
        `Trial codesign did not finish in ${timeoutMs / 1000} s and was killed; the keychain ` +
          "is probably waiting for an access prompt.",
      );
    }
    if (signed.status !== 0) throw new Error(`Trial codesign failed:\n${signed.stderr}`);
    capture("codesign", ["--verify", "--strict", binary]);
    const details = capture("codesign", ["-dv", "--verbose=4", binary]);
    if (!details.includes(`Authority=${identity}\n`)) {
      throw new Error(`Trial binary is not signed by ${identity}:\n${details}`);
    }
    log(`Trial signing took ${((Date.now() - startedAt) / 1000).toFixed(1)} s.`);
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

function createIdentity(): void {
  if (!NodeFS.existsSync(loginKeychain)) throw new Error(`${loginKeychain} does not exist.`);
  const existing =
    listIdentities(identity).length > 0 ||
    // With -a, find-certificate exits 0 even when nothing matches.
    capture("security", ["find-certificate", "-a", "-c", identity, loginKeychain]).trim() !== "";
  if (existing) {
    throw new Error(`"${identity}" already exists in the keychain; remove it deliberately first.`);
  }

  // mkdtemp creates the directory 0700. The key and the p12 live only here.
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3x-identity-"));
  NodeFS.chmodSync(directory, 0o700);
  let createdHash: string | undefined;
  try {
    const password = NodeCrypto.randomBytes(16).toString("hex");
    const env = { ...process.env, [identityPasswordVariable]: password };
    const configPath = NodePath.join(directory, "openssl.cnf");
    const keyPath = NodePath.join(directory, "key.pem");
    const certPath = NodePath.join(directory, "cert.pem");
    const p12Path = NodePath.join(directory, "identity.p12");
    NodeFS.writeFileSync(
      configPath,
      [
        "[req]",
        "distinguished_name = dn",
        "x509_extensions = ext",
        "prompt = no",
        "[dn]",
        `CN = ${identity}`,
        "O = SimpleEve",
        "[ext]",
        "basicConstraints = critical,CA:FALSE",
        "keyUsage = critical,digitalSignature",
        "extendedKeyUsage = critical,codeSigning",
        "subjectKeyIdentifier = hash",
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
    // The system LibreSSL writes a PKCS#12 that `security import` can read; OpenSSL 3 does not.
    const openssl = "/usr/bin/openssl";
    run(openssl, [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-sha256",
      "-nodes",
      "-days",
      "3650",
      "-config",
      configPath,
      "-keyout",
      keyPath,
      "-out",
      certPath,
    ]);
    run(
      openssl,
      [
        "pkcs12",
        "-export",
        "-inkey",
        keyPath,
        "-in",
        certPath,
        "-name",
        identity,
        "-out",
        p12Path,
        "-passout",
        `env:${identityPasswordVariable}`,
      ],
      env,
    );
    const certificate = new NodeCrypto.X509Certificate(NodeFS.readFileSync(certPath));
    const hash = certificate.fingerprint.replaceAll(":", "");

    // `security -i` reads the command from stdin, which keeps the password out of argv. Only
    // codesign gets access (-T); -A would let any app use the key.
    createdHash = hash;
    const imported = NodeChildProcess.spawnSync("security", ["-i"], {
      input: `import "${p12Path}" -k "${loginKeychain}" -f pkcs12 -P ${password} -T /usr/bin/codesign\n`,
      stdio: ["pipe", "ignore", "ignore"],
    });
    if (imported.status !== 0) throw new Error("security import failed.");

    const listed = listIdentities(identity);
    if (listed.length !== 1 || listed[0]!.hash !== hash) {
      throw new Error(`Imported identity ${hash} is not listed for code signing.`);
    }
    // The first use of the new key raises a keychain prompt (the key's partition list does not
    // yet cover codesign). "Always Allow" lets the second trial run without one.
    log(
      "\nA keychain window will open now: enter the login password and click 'Always Allow'.\n" +
        "Waiting up to 10 minutes...",
    );
    trialSign(hash, 600_000);
    log("Confirming that signing no longer prompts (30 s limit)...");
    trialSign(hash, 30_000);
    createdHash = undefined;
    log(
      `Created "${identity}" in the login keychain.\n` +
        `SHA-1:   ${hash}\nSHA-256: ${certificate.fingerprint256.replaceAll(":", "").toLowerCase()}\n` +
        `Valid to ${certificate.validTo}. Trust settings were not changed` +
        `${listed[0]!.status === undefined ? "" : ` (${listed[0]!.status})`}.`,
    );
  } catch (error) {
    const leftover = createdHash === undefined ? undefined : removeCreatedIdentity(createdHash);
    if (leftover !== undefined) log(leftover);
    throw error;
  } finally {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
}

if (flags["create-identity"]) {
  createIdentity();
  process.exit(0);
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
