// @effect-diagnostics nodeBuiltinImport:off - a linear build pipeline of external tools.
// T3 Extend: build a release APK signed with the fork's own keystore. The signing config is
// injected through Gradle properties, so build.gradle, app.config.ts and the native fingerprint
// stay untouched. See FORK.md "打包与签名".
//
// The store password lives only in the macOS Keychain. It never goes on a command line (which
// `ps` shows) or to stdout: keytool and Gradle read it from the environment, `security` from stdin.
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
const mobileRoot = NodePath.join(repoRoot, "apps/mobile");
const androidRoot = NodePath.join(mobileRoot, "android");

const { values: flags } = NodeUtil.parseArgs({
  options: {
    keystore: {
      type: "string",
      default:
        process.env.T3EXTEND_ANDROID_KEYSTORE ??
        NodePath.join(NodeOS.homedir(), ".config", FORK.userDataDir, "android-release.jks"),
    },
    alias: { type: "string", default: FORK.userDataDir },
    "keychain-service": { type: "string", default: `${FORK.userDataDir}-android-release` },
    abi: { type: "string", default: "arm64-v8a" },
    "output-dir": { type: "string", default: "release/fork-android" },
    "create-keystore": { type: "boolean", default: false },
  },
});
const keystorePath = NodePath.resolve(flags.keystore);
const keychainService = flags["keychain-service"];
const outputDir = NodePath.resolve(repoRoot, flags["output-dir"]);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see FORK.md "Android 开发环境".`);
  return value;
}

const javaHome = requireEnv("JAVA_HOME");
const androidHome = requireEnv("ANDROID_HOME");
const keytool = NodePath.join(javaHome, "bin/keytool");

function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string } = {},
): void {
  log(`$ ${command} ${args.join(" ")}`);
  const result = NodeChildProcess.spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    env: options.env ?? process.env,
    input: options.input,
    stdio: [options.input === undefined ? "inherit" : "pipe", "inherit", "inherit"],
  });
  if (result.status !== 0) {
    throw new Error(`${command} exited with ${String(result.status ?? result.signal)}`);
  }
}

function capture(command: string, args: ReadonlyArray<string>, env?: NodeJS.ProcessEnv): string {
  const result = NodeChildProcess.spawnSync(command, args, { encoding: "utf8", env });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.slice(0, 2).join(" ")} failed:\n${result.stderr}`);
  }
  return result.stdout;
}

function readKeychainPassword(): string | undefined {
  const result = NodeChildProcess.spawnSync(
    "security",
    ["find-generic-password", "-a", keychainService, "-s", keychainService, "-w"],
    { encoding: "utf8" },
  );
  return result.status === 0 ? result.stdout.trimEnd() : undefined;
}

function createKeystore(): void {
  if (NodeFS.existsSync(keystorePath)) {
    throw new Error(`${keystorePath} already exists; refusing to replace a release key.`);
  }
  if (readKeychainPassword() !== undefined) {
    throw new Error(
      `Keychain item "${keychainService}" already exists; remove it deliberately first.`,
    );
  }
  const password = capture("openssl", ["rand", "-base64", "24"]).trim();
  if (!/^[A-Za-z0-9+/=]{32}$/u.test(password)) throw new Error("Unexpected openssl output.");

  const directory = NodePath.dirname(keystorePath);
  NodeFS.mkdirSync(directory, { recursive: true, mode: 0o700 });
  NodeFS.chmodSync(directory, 0o700);
  // PKCS12 keeps a single password, so the key password is the store password.
  run(
    keytool,
    [
      "-genkeypair",
      "-keystore",
      keystorePath,
      "-storetype",
      "PKCS12",
      "-alias",
      flags.alias,
      "-keyalg",
      "RSA",
      "-keysize",
      "4096",
      "-validity",
      "10000",
      "-dname",
      `CN=${FORK.appBaseName}, O=SimpleEve`,
      "-storepass:env",
      "T3EXTEND_STORE_PASSWORD",
      "-keypass:env",
      "T3EXTEND_STORE_PASSWORD",
    ],
    { env: { ...process.env, T3EXTEND_STORE_PASSWORD: password } },
  );
  NodeFS.chmodSync(keystorePath, 0o600);
  // `security -i` reads its command from stdin, which keeps the password out of argv. Its
  // output is dropped because an error message could echo the command back.
  const stored = NodeChildProcess.spawnSync("security", ["-i"], {
    input: `add-generic-password -a ${keychainService} -s ${keychainService} -w ${password}\n`,
    stdio: ["pipe", "ignore", "ignore"],
  });
  if (stored.status !== 0) throw new Error("security add-generic-password failed.");
  if (readKeychainPassword() !== password) {
    throw new Error("The Keychain item does not round-trip; the keystore was kept, check both.");
  }
  log(`Created ${keystorePath} (alias ${flags.alias}) and Keychain item ${keychainService}.`);
  log("Back up the keystore and the Keychain password now: see FORK.md.");
}

function certificateSha256(password: string): string {
  const listing = capture(
    keytool,
    [
      "-list",
      "-v",
      "-keystore",
      keystorePath,
      "-alias",
      flags.alias,
      "-storepass:env",
      "T3EXTEND_STORE_PASSWORD",
    ],
    { ...process.env, T3EXTEND_STORE_PASSWORD: password },
  );
  const match = /SHA256:\s*([0-9A-F:]+)/u.exec(listing);
  if (!match) throw new Error("keytool printed no SHA-256 fingerprint.");
  return match[1]!.replaceAll(":", "").toLowerCase();
}

function newestBuildTools(): string {
  const root = NodePath.join(androidHome, "build-tools");
  const versions = NodeFS.readdirSync(root).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true }),
  );
  return NodePath.join(root, versions.at(-1)!);
}

function buildRelease(): void {
  if (!NodeFS.existsSync(keystorePath)) {
    throw new Error(`${keystorePath} is missing. Create it once with --create-keystore.`);
  }
  const password = readKeychainPassword();
  if (password === undefined) {
    throw new Error(`Keychain item "${keychainService}" is missing; see FORK.md.`);
  }
  const expectedCertificate = certificateSha256(password);

  const tracked = capture("git", ["-C", repoRoot, "ls-files", "apps/mobile/android"]);
  if (tracked.trim())
    throw new Error("apps/mobile/android has tracked files; prebuild would clobber them.");

  const buildEnv: NodeJS.ProcessEnv = {
    ...process.env,
    APP_VARIANT: "production",
    CI: "1",
    EXPO_NO_GIT_STATUS: "1",
  };
  run("vp", ["exec", "expo", "prebuild", "--clean", "--platform", "android", "--no-install"], {
    cwd: mobileRoot,
    env: buildEnv,
  });
  const gradle = NodeFS.readFileSync(NodePath.join(androidRoot, "app/build.gradle"), "utf8");
  if (!gradle.includes(`applicationId '${FORK.appId}'`)) {
    throw new Error(`Prebuild did not produce applicationId ${FORK.appId}.`);
  }

  // Non-secret signing properties go on the command line; the passwords reach Gradle as
  // ORG_GRADLE_PROJECT_* environment variables. --no-daemon keeps them out of a lingering daemon.
  run(
    "./gradlew",
    [
      "--no-daemon",
      "app:assembleRelease",
      `-PreactNativeArchitectures=${flags.abi}`,
      `-Pandroid.injected.signing.store.file=${keystorePath}`,
      `-Pandroid.injected.signing.key.alias=${flags.alias}`,
    ],
    {
      cwd: androidRoot,
      env: {
        ...buildEnv,
        "ORG_GRADLE_PROJECT_android.injected.signing.store.password": password,
        "ORG_GRADLE_PROJECT_android.injected.signing.key.password": password,
      },
    },
  );

  const builtApk = NodePath.join(androidRoot, "app/build/outputs/apk/release/app-release.apk");
  const version = /versionName "([^"]+)"/u.exec(gradle)?.[1] ?? "unknown";
  NodeFS.mkdirSync(outputDir, { recursive: true });
  const apkPath = NodePath.join(
    outputDir,
    `${FORK.appBaseName.replaceAll(" ", "-")}-${version}-${flags.abi}.apk`,
  );
  NodeFS.copyFileSync(builtApk, apkPath);

  const apksigner = NodePath.join(newestBuildTools(), "apksigner");
  const certificates = capture(apksigner, ["verify", "--print-certs", apkPath]);
  const signed = /certificate SHA-256 digest: ([0-9a-f]+)/u.exec(certificates)?.[1];
  if (signed !== expectedCertificate) {
    throw new Error(`APK is signed by ${String(signed)}, expected ${expectedCertificate}.`);
  }
  const digest = NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(apkPath)).digest("hex");
  NodeFS.writeFileSync(`${apkPath}.sha256`, `${digest}  ${NodePath.basename(apkPath)}\n`);
  log(`\n${certificates.trim()}\n\nAPK: ${apkPath}\nsha256: ${digest}`);
}

if (flags["create-keystore"]) createKeystore();
else buildRelease();
