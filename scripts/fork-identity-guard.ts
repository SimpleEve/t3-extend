// @effect-diagnostics nodeBuiltinImport:off - a plain file scan; it must run without the app runtime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

// Fork guard: official T3 Code identity literals that must not reappear in T3 Extend's code after
// an upstream merge. Values the fork uses live in packages/shared/src/forkIdentity.ts.
const OFFICIAL_IDENTITY: ReadonlyArray<RegExp> = [
  /com\.t3tools\.t3code/u,
  /\bt3code-v2\b/u,
  /\bt3code-dev\b/u,
  /\bt3code-preview\b/u,
  /\bt3code:\/\//u,
  /["'`]t3code:["'`]/u,
  /\bt3code\.service\b/u,
  /u\.expo\.dev\/d763/u,
  /d763fcb8-d37c-41ea-a773-b54a0ab4a454/u,
  /ingest\.t3\.codes/u,
  /pingdotgg\/t3code/u,
  /["'`]\.t3["'`]/u,
  // Shared external state: one tailnet name, and one set of git refs and branch names per repo.
  /\bDEFAULT_TAILSCALE_SERVE_PORT = 443\b/u,
  /\btailscaleServePort: 443\b/u,
  /\(\) => 443,/u,
  /refs\/t3code\//u,
  /refs\/t3\/review-guide/u,
  /\bt3code\/pr-/u,
  /BRANCH_PREFIX = "t3"/u,
  // Branch-name patterns that name official T3 Code's prefixes; a write path must not use them.
  /t3code\(\?:/u,
  /\|t3\|t3code\)/u,
  /branchNamePrefix: .*succeed\("t3"\)/u,
];

const ROOTS = [
  "apps/server/src",
  "apps/server/scripts",
  "apps/web/src",
  "apps/web/vite.config.ts",
  "apps/desktop/src",
  "apps/desktop/scripts",
  "apps/desktop/package.json",
  "apps/mobile/src",
  "apps/mobile/scripts",
  "apps/mobile/app.config.ts",
  "apps/mobile/package.json",
  "packages",
  "scripts",
];

const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|sh|ps1)$/u;
const SKIPPED_DIRECTORIES = new Set(["node_modules", "dist", "dist-electron", "build", ".turbo"]);
const SKIPPED_FILE =
  /\.(?:test|browser\.test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:test|tests|__tests__|fixtures?|testkit)\//u;

interface Allowed {
  readonly path: string;
  /** Only lines containing this text are allowed; omit to allow every hit in `path`. */
  readonly line?: string;
  readonly reason: string;
}

const ALLOWED: ReadonlyArray<Allowed> = [
  {
    path: "packages/shared/src/forkIdentity.ts",
    reason:
      "Names official values on purpose: SSH remote installs and the read-only seed fallback.",
  },
  {
    path: "scripts/fork-identity-guard.ts",
    reason: "The guard lists the patterns it looks for.",
  },
  {
    path: "packages/shared/src/git.ts",
    line: 'OFFICIAL_WORKTREE_BRANCH_PREFIX = "t3"',
    reason:
      "Recognizes official T3 Code's temporary branches for display only; no write path uses it.",
  },
  {
    path: "packages/shared/src/git.ts",
    line: "t3code(?:",
    reason: "Same display-only pattern, which also covers official T3 Code's legacy t3code names.",
  },
  {
    path: "packages/shared/src/paletteSearch.ts",
    line: "|t3|t3code)",
    reason: "Strips official T3 Code's branch prefixes from search text; it renames nothing.",
  },
  {
    path: "apps/mobile/src/App.tsx",
    line: "://",
    reason: "Official scheme prefixes are parsed too, so official T3 Code links still open.",
  },
  {
    path: "packages/shared/src/devHome.ts",
    line: '".t3"',
    reason: "A linked worktree's own gitignored state directory, not official T3 Code's home.",
  },
  {
    path: "scripts/e2e.config.ts",
    line: "`.t3` is gitignored",
    reason: "Comment about the scenario homes' own gitignored state directory.",
  },
  {
    path: "scripts/setup-worktree.ts",
    line: '".t3"',
    reason: "Setup markers in the worktree's own gitignored .t3 directory.",
  },
  {
    path: "scripts/dev-runner.ts",
    line: "(gitignored) `.t3`",
    reason: "Comment about the worktree's own state directory.",
  },
  {
    path: "apps/server/src/cli/config.ts",
    line: "Bare `t3 pair` prefers a linked worktree's `.t3`",
    reason: "Comment about the worktree's own state directory.",
  },
  {
    path: "apps/server/src/cli/pair.ts",
    line: "`.t3` counts",
    reason: "Comment about the worktree's own state directory.",
  },
  {
    path: "apps/server/src/device/sshDeviceScript.ts",
    line: "'.t3', 'device'",
    reason:
      "Runs on a remote SSH device host; its scratch directory there never touches this machine.",
  },
  {
    path: "apps/desktop/scripts/dev-electron.mjs",
    line: "-root=",
    reason:
      "Process marker scoped by the desktop directory path; matches only this checkout's Electron.",
  },
  {
    path: "apps/desktop/scripts/electron-launcher.mjs",
    line: "-root=",
    reason: "Same process marker, written by the dev launcher.",
  },
  {
    path: "apps/desktop/src/preview/BrowserSession.ts",
    line: "t3code-preview-",
    reason: "Browser partition names inside the fork's own userData directory.",
  },
  {
    path: "apps/desktop/src/preview/GuestProtocol.ts",
    line: "--t3code-preview-passkey-bridge",
    reason: "Internal argv flag between the app's own processes.",
  },
  {
    path: "apps/desktop/src/preview/GuestProtocol.ts",
    line: "--t3code-preview-primary-paste-disabled",
    reason: "Internal argv flag between the app's own processes.",
  },
  {
    path: "apps/desktop/src/window/RemoteRequestHeaders.ts",
    line: "`t3code://app`",
    reason: "Comment naming the official app's scheme that Electron puts in Origin.",
  },
  {
    path: "scripts/scenarios/terminal-latched-modifier-reads-selected.e2e.ts",
    reason: "Mobile scenario that drives upstream's own dev app by its bundle id and scheme.",
  },
  {
    path: "scripts/scenarios/add-project-tab-reaches-submit.e2e.ts",
    line: "pingdotgg/t3code.git",
    reason: "A public repository URL typed into the form to enable Continue; it is never cloned.",
  },
  {
    path: "apps/server/src/provider/ModelManifest.ts",
    line: "raw.githubusercontent.com/pingdotgg/t3code",
    reason: "Read-only model list from upstream; it never replaces code.",
  },
  {
    path: "apps/server/src/telemetry/AnalyticsService.ts",
    line: "ingest.t3.codes",
    reason:
      "Telemetry defaults to off in the fork; this host is used only when explicitly enabled.",
  },
  {
    path: "apps/server/src/triage/",
    reason:
      "Model-facing triage text about the upstream project; evals cover it, so it stays verbatim.",
  },
  {
    path: "apps/server/scripts/acp-mock-agent.ts",
    reason: "Mock agent fixture output.",
  },
  {
    path: "apps/web/src/components/GitHubStarPrompt.tsx",
    reason: "Credits the upstream project.",
  },
  {
    path: "apps/web/src/components/settings/MultipleAccountsNote.tsx",
    reason: "Links to upstream user documentation.",
  },
  {
    path: "packages/contracts/src/environmentHttp.ts",
    reason: "Links to upstream T3 Connect troubleshooting documentation.",
  },
  {
    path: "scripts/build-desktop-artifact.ts",
    line: "metainfo.xml",
    reason: "Linux packaging metadata; Linux identity is out of scope until the fork ships Linux.",
  },
  {
    path: "scripts/install.sh",
    reason: "Official server installer; the fork installs with scripts/install-t3x.sh.",
  },
  {
    path: "scripts/install.ps1",
    reason: "Official server installer; the fork installs with scripts/install-t3x.sh.",
  },
  {
    path: "scripts/npm-launcher/",
    reason: "Launcher for the official `t3` npm package; the fork does not publish to npm.",
  },
  {
    path: "scripts/lib/linux-arm64-sea.ts",
    reason: "Comment linking an upstream workaround.",
  },
  {
    path: "scripts/mobile-showcase-environment.ts",
    line: "repositoryUrl",
    reason: "Screenshot fixture data.",
  },
];

// Brand guard: "T3 Code" stays only where it names official T3 Code, each place with its reason.
// \s spans line breaks, so wrapped JSX text and template literals are caught. Concatenated names
// (`"T3 " + "Code"`) are out of scope. A line starting with `//`, `/*` or `*` is a comment.
const BRAND_NAME = /T3\s+Code/gu;
const BRAND_ROOTS = [
  "apps/server/src/peer/PeerLinks.ts",
  "apps/server/src/orchestration-v2/RestartContinuation.ts", // summaries shown in the timeline
  "apps/server/src/device/EasDeviceHost.ts",
  "apps/web/index.html",
  "apps/web/public/manifest.webmanifest",
  "apps/mobile/app.config.ts",
  "apps/desktop/scripts/electron-launcher.mjs",
  "scripts/build-desktop-artifact.ts",
  "apps/web/src",
  "apps/desktop/src",
  "apps/mobile/src",
  "packages/shared/src",
  "packages/client-runtime/src",
  "packages/contracts/src",
];
/** Catalogs follow the English keys in code; `i18n:report` keeps them in step. */
const BRAND_SOURCE_FILE = /\.(?:[cm]?[jt]sx?|json|html|webmanifest)$/u;
// GT catalogs (`i18n/translations`) are generated from the source keys; scripts/fork-i18n-sync.ts rebrands them.
const BRAND_SKIPPED_FILE = /(?:^|\/)i18n\/(?:catalogs|translations)\//u;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*)/u;

const ALLOWED_BRAND: ReadonlyArray<Allowed> = [
  {
    path: "apps/web/src/components/settings/LabsSettingsPanel.tsx",
    line: "T3 Code",
    reason:
      "Hidden in the fork (capabilities.agentFeedback is false); the copy names the upstream team it reports to.",
  },
  {
    path: "apps/mobile/src/features/settings/ThreadSettingsSections.tsx",
    line: "T3 Code problems",
    reason:
      "Hidden in the fork (capabilities.agentFeedback is false); the copy names the upstream team it reports to.",
  },
  {
    path: "packages/contracts/src/orchestrationV2.ts",
    line: "[T3 Code: ",
    reason: "Model-facing provenance note; upstream's evals cover this wording.",
  },
  {
    path: "packages/shared/src/themeCss.ts",
    line: "the stock T3 Code theme",
    reason:
      "Model-facing guide: `t3-code` is the upstream built-in theme's id, which the agent must name exactly.",
  },
  {
    path: "packages/contracts/src/t3CodeImport.ts",
    reason: "OFFICIAL_APP_NAME, the one place the import names the official app it reads from.",
  },
  {
    path: "packages/shared/src/forkIdentity.ts",
    line: "OFFICIAL_APP_NAME",
    reason: "The one place the official app's name is written, for text that must name it.",
  },
  {
    path: "scripts/build-desktop-artifact.ts",
    line: "Build a desktop artifact for T3 Code",
    reason: "Maintainer-facing CLI help text.",
  },
  {
    path: "apps/web/src/components/GitHubStarPrompt.tsx",
    reason: "Asks for a star on the upstream project.",
  },
  {
    path: "apps/web/src/components/promptLinks/HostedPromptLinkLanding.tsx",
    line: "Get T3 Code",
    reason: "Links to the official download.",
  },
  {
    path: "apps/web/src/components/clerk/",
    reason: "T3 Connect account pages; the account service belongs to official T3 Code.",
  },
  {
    path: "apps/web/src/components/settings/ChatGptWelcomeCoordinator.tsx",
    reason: "OpenAI's ChatGPT plan terms name official T3 Code.",
  },
  {
    path: "packages/shared/src/usageLimits.ts",
    reason: "Message for a ChatGPT workspace admin, who knows the official product.",
  },
  {
    path: "apps/web/src/components/settings/ThemeImportDialog.tsx",
    reason: "Accepts theme files exported by official T3 Code.",
  },
  {
    path: "apps/web/src/components/settings/ThemePreviewCircles.tsx",
    reason: "Name of the built-in theme preset.",
  },
  {
    path: "apps/mobile/src/lib/mobileTheme.ts",
    reason: "Name of the built-in theme preset.",
  },
  {
    path: "apps/web/src/components/settings/MultipleAccountsNote.tsx",
    reason: "Links to upstream user documentation.",
  },
  {
    path: "apps/server/src/peer/PeerLinks.ts",
    line: "T3 Code",
    reason: "Names the linked peer, which can be official T3 Code, or a comment about it.",
  },
  {
    path: "apps/web/src/components/settings/SnapShotSetupDialog.tsx",
    line: "T3 Code ",
    reason: "Quotes the GNOME extension's name from apps/desktop/gnome-extension/metadata.json.",
  },
  {
    path: "apps/desktop/src/snapShot/GnomeCaptureSetup.ts",
    line: "T3 Code extension",
    reason: "Quotes the GNOME extension's name from apps/desktop/gnome-extension/metadata.json.",
  },
  {
    path: "apps/desktop/src/snapShot/KdeSnapShot.ts",
    line: "Name=T3 Code SnapShots",
    reason: "Desktop entry name that the KDE helper registers; Linux identity is out of scope.",
  },
  {
    path: "apps/desktop/src/snapShot/SnapShotTransition.ts",
    reason: "Window title that no one reads, and a Linux-only compositor rule may match it.",
  },
  {
    path: "apps/desktop/src/app/DesktopCliShim.ts",
    line: "MARKER",
    reason: "Marker that identifies shims this app wrote; changing it orphans existing shims.",
  },
  {
    path: "apps/desktop/src/app/DesktopLegacyLocalStorage.ts",
    reason: "Official T3 Code's v1 profile directory names, read only for matching.",
  },
  {
    path: "apps/mobile/src/features/diagnostics/SettingsDiagnosticsRouteScreen.tsx",
    reason: "Says who receives the crash report: the official T3 Code team.",
  },
  {
    path: "packages/contracts/src/t3ProjectFile.ts",
    reason: "Public JSON schema of t3.json, shared with official T3 Code.",
  },
  {
    path: "packages/contracts/src/relay.ts",
    reason: "OpenAPI title of the official relay service.",
  },
];

const repoRoot = NodePath.dirname(import.meta.dirname);

function* walk(relative: string): Generator<string> {
  const absolute = NodePath.join(repoRoot, relative);
  if (!NodeFS.existsSync(absolute)) return;
  const stat = NodeFS.statSync(absolute);
  if (stat.isFile()) {
    yield relative;
    return;
  }
  for (const entry of NodeFS.readdirSync(absolute, { withFileTypes: true })) {
    if (entry.isDirectory() && SKIPPED_DIRECTORIES.has(entry.name)) continue;
    yield* walk(NodePath.posix.join(relative, entry.name));
  }
}

const violations: Array<string> = [];
const used = new Set<Allowed>();
for (const root of ROOTS) {
  for (const file of walk(root)) {
    if (!SOURCE_FILE.test(file) || SKIPPED_FILE.test(file)) continue;
    const lines = NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8").split("\n");
    lines.forEach((line, index) => {
      if (!OFFICIAL_IDENTITY.some((pattern) => pattern.test(line))) return;
      const allowed = ALLOWED.find(
        (entry) =>
          (file === entry.path || file.startsWith(`${entry.path.replace(/\/$/u, "")}/`)) &&
          (entry.line === undefined || line.includes(entry.line)),
      );
      if (allowed) used.add(allowed);
      else violations.push(`${file}:${index + 1}: ${line.trim()}`);
    });
  }
}

const brandUsed = new Set<Allowed>();
const brandViolations: Array<string> = [];
for (const root of BRAND_ROOTS) {
  for (const file of walk(root)) {
    if (!BRAND_SOURCE_FILE.test(file) || SKIPPED_FILE.test(file) || BRAND_SKIPPED_FILE.test(file))
      continue;
    const text = NodeFS.readFileSync(NodePath.join(repoRoot, file), "utf8");
    const lines = text.split("\n");
    for (const match of text.matchAll(BRAND_NAME)) {
      const lineNumber = text.slice(0, match.index).split("\n").length;
      const line = lines[lineNumber - 1] ?? "";
      if (COMMENT_LINE.test(line)) continue;
      const allowed = ALLOWED_BRAND.find(
        (entry) =>
          (file === entry.path || file.startsWith(`${entry.path.replace(/\/$/u, "")}/`)) &&
          (entry.line === undefined || line.includes(entry.line)),
      );
      if (allowed) brandUsed.add(allowed);
      else brandViolations.push(`${file}:${lineNumber}: ${line.trim()}`);
    }
  }
}
// Files that cannot import forkIdentity.ts (a launcher script, static HTML, JSON, SVG text) hold a
// copy of the app's name. Each pattern must match and every captured name must be FORK.appBaseName.
const STATIC_NAME_COPIES: ReadonlyArray<{
  readonly path: string;
  readonly patterns: ReadonlyArray<RegExp>;
}> = [
  {
    path: "apps/desktop/scripts/electron-launcher.mjs",
    patterns: [/"([^"]+) \((?:Dev|Beta)\)"/gu],
  },
  {
    path: "apps/web/index.html",
    patterns: [
      /<title>(.+?) \(Beta\)<\/title>/gu,
      /aria-label="(.+?) splash screen"/gu,
      /id="boot-shell-logo"[^>]*alt="(.+?)"/gu,
    ],
  },
  {
    path: "apps/web/public/manifest.webmanifest",
    patterns: [/"name": "(.+?)"/gu, /"short_name": "(.+?)"/gu],
  },
  {
    path: "apps/desktop/resources/dmg/dmg-background-latest.svg",
    patterns: [/Drag (.+?) into Applications\./gu],
  },
  {
    path: "apps/desktop/resources/dmg/dmg-background-nightly.svg",
    patterns: [/Drag (.+?) into Applications\./gu],
  },
];

const driftProblems: Array<string> = [];
const forkIdentityPath = NodePath.join(repoRoot, "packages/shared/src/forkIdentity.ts");
const appBaseName = NodeFS.existsSync(forkIdentityPath)
  ? /appBaseName:\s*"([^"]+)"/u.exec(NodeFS.readFileSync(forkIdentityPath, "utf8"))?.[1]
  : undefined;
if (appBaseName === undefined) {
  driftProblems.push("packages/shared/src/forkIdentity.ts: FORK.appBaseName not found");
} else {
  for (const copy of STATIC_NAME_COPIES) {
    const absolute = NodePath.join(repoRoot, copy.path);
    if (!NodeFS.existsSync(absolute)) {
      driftProblems.push(`${copy.path}: file missing; update STATIC_NAME_COPIES`);
      continue;
    }
    const text = NodeFS.readFileSync(absolute, "utf8");
    for (const pattern of copy.patterns) {
      const names = [...text.matchAll(pattern)].map((match) => match[1]);
      if (names.length === 0) driftProblems.push(`${copy.path}: no match for ${pattern}`);
      for (const name of names) {
        if (name !== appBaseName) {
          driftProblems.push(
            `${copy.path}: "${name}" does not match FORK.appBaseName "${appBaseName}"`,
          );
        }
      }
    }
  }
}
const brandStale = ALLOWED_BRAND.filter((entry) => !brandUsed.has(entry));
const stale = ALLOWED.filter((entry) => !used.has(entry));
if (
  violations.length > 0 ||
  stale.length > 0 ||
  brandViolations.length > 0 ||
  brandStale.length > 0 ||
  driftProblems.length > 0
) {
  for (const violation of violations) process.stderr.write(`${violation}\n`);
  for (const entry of stale)
    process.stderr.write(`stale allowlist entry: ${entry.path} ${entry.line ?? ""}\n`);
  for (const violation of brandViolations) process.stderr.write(`${violation}\n`);
  for (const entry of brandStale)
    process.stderr.write(`stale brand allowlist entry: ${entry.path} ${entry.line ?? ""}\n`);
  for (const problem of driftProblems) process.stderr.write(`${problem}\n`);
  process.stderr.write(
    `\nfork-identity-guard: ${violations.length} official identity literal(s), ${stale.length} stale allowlist entr(ies), ` +
      `${brandViolations.length} user-visible "T3 Code" literal(s), ${brandStale.length} stale brand allowlist entr(ies), ` +
      `${driftProblems.length} static name copy problem(s).` +
      "\nUse packages/shared/src/forkIdentity.ts (FORK.appBaseName for the app's name), or add an ALLOWED or ALLOWED_BRAND entry with a reason.\n",
  );
  process.exit(1);
}
process.stdout.write("fork-identity-guard: no official identity literals outside the allowlist.\n");
