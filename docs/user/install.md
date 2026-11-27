# Install T3 Code

T3 Code runs coding agents on your computer (or server) and lets you control them from the desktop app, web app, or mobile app. Install T3 Code on the machine where your agents will run first.

## Requirements

You need at least one installed, authenticated coding agent (provider) before starting a thread. You can launch T3 Code first and set up providers from the [Welcome page](./welcome-page.md) or **Settings → Providers**.

## Command line

Install the `t3` command to `~/.local/bin`:

```bash
# macOS / Linux
curl -fsSL https://t3.codes/install.sh | sh
```

```powershell
# Windows (PowerShell)
irm https://t3.codes/install.ps1 | iex
```

Set `T3CODE_CHANNEL=nightly` for nightly builds or `T3CODE_VERSION=<ver>` to pin a version. To try once without installing, run `npx t3@latest` (requires Node.js; always runs the latest stable release).

| Task                          | Command                                                                 |
| ----------------------------- | ----------------------------------------------------------------------- |
| Start server and open web app | `t3` (or `t3 ./my-project`)                                             |
| Start server without browser  | `t3 serve`                                                              |
| Set up remote access          | `t3 up` ([Remote access](./remote-access.md))                           |
| Run in the background         | `t3 service install` ([Background service](./background-service.md))    |
| Update                        | `t3 update`                                                             |
| Reclaim database space        | `t3 doctor` ([Details](./background-service.md#reclaim-database-space)) |
| Uninstall                     | `t3 uninstall`                                                          |

If `t3` reports a server is already running, connect with `t3 pair` or pass a separate `--base-dir`. Run `t3 --help` for all commands.

### Intel Macs

There is no standalone `t3` binary for Intel Macs—use the desktop app, or build a server from source with `vp` ([development runbook](../operations/00_development.md#first-checkout)):

```bash
git clone https://github.com/pingdotgg/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

## Desktop app

Download from [GitHub Releases](https://github.com/pingdotgg/t3code/releases) or install via a package manager:

| Platform                | Command                                                          |
| ----------------------- | ---------------------------------------------------------------- |
| macOS                   | `brew install --cask t3-code`                                    |
| Windows                 | `winget install T3Tools.T3Code` or `scoop install extras/t3code` |
| Debian / Ubuntu         | `sudo apt install ./T3-Code-*.deb`                               |
| Arch Linux              | `yay -S t3code-bin` (or `yay -S t3code-nightly-bin`)             |
| Nix (flakes, Nix 2.30+) | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code`     |

- **Linux AppImage**: `chmod +x ./T3-Code-*.AppImage && ./T3-Code-*.AppImage` (x86_64 and ARM64). `.deb` self-updates with a password prompt; update AUR packages via your AUR helper (`yay -Syu`).
- **NixOS / Home Manager**: Add `pkgs.t3code` to `environment.systemPackages` or `home.packages` (`t3code-desktop` launches the app; `t3` is included). Update via Nix rather than the in-app updater.

### T3 Extend on macOS

<!-- fork: T3 Extend only. Not part of upstream T3 Code. -->

The downloads and package managers above install official T3 Code. T3 Extend is
not published there. Download the disk image,
`T3-Extend-<version>-arm64.dmg`, from the
[T3 Extend releases page](https://github.com/SimpleEve/t3-extend/releases). It is
for Macs with Apple silicon.

1. Open the disk image and drag **T3 Extend (Beta)** into **Applications**.
2. Open it from Applications. The app is signed with its own certificate and is
   not notarized by Apple, so macOS refuses the first launch. Choose **Done**, then
   open **System Settings → Privacy & Security**, scroll to **Security**, and choose
   **Open Anyway** next to the message about T3 Extend (Beta). Confirm with your
   password or Touch ID, then choose **Open**. From macOS 15, Control-clicking
   the app and choosing **Open** no longer gets past this. If the button is not
   there, open the app once more and look again.
3. macOS then asks whether T3 Extend (Beta) may use "t3extend Safe Storage" in
   your keychain. Enter your login password and choose **Always Allow**. The app
   keeps its sign-ins there. If you chose anything else, quit the app, run
   `security delete-generic-password -s "t3extend Safe Storage"` in Terminal, and
   open the app again; you sign in or pair your devices again.

To skip step 2, run `xattr -d com.apple.quarantine "/Applications/T3 Extend (Beta).app"` in
Terminal before opening the app.

The app checks the releases page for updates itself and offers a new version in
the app. Installs of 0.1.11-1.6 and earlier have no updater: open the newer disk
image and drag the app into **Applications** once, replacing the old one, and
later versions update themselves.

### T3 Extend on Windows

<!-- fork: T3 Extend only. Not part of upstream T3 Code. -->

The Windows installer is `T3-Extend-<version>-x64.exe` on the
[T3 Extend releases page](https://github.com/SimpleEve/t3-extend/releases). It is
for 64-bit Windows on Intel or AMD processors; there is no build for Windows on
Arm. Next to it, `T3-Extend-<version>-x64.exe.sha256` holds the file's SHA-256, which
`Get-FileHash .\T3-Extend-<version>-x64.exe` in PowerShell should match.

The installer is not signed: there is no Windows code-signing certificate behind
T3 Extend. Windows therefore warns about it:

1. Run the installer. SmartScreen shows **Windows protected your PC** and names
   the publisher as unknown. Choose **More info**, then **Run anyway**. Only do
   this for a file you downloaded from the releases page above.
2. The installer sets up **T3 Extend (Beta)** and starts it.

If Windows blocks the installer with no **Run anyway** button, Smart App Control is
on. It refuses every unsigned program. Turn it off under **Windows Security → App &
browser control → Smart App Control settings**. On some Windows versions it cannot
be turned back on afterwards without reinstalling Windows.

T3 Extend installs beside official T3 Code: it has its own install folder, Start
menu entry, entry in **Installed apps**, `t3extend://` links, data folders
(`%APPDATA%\t3extend` and `%USERPROFILE%\.t3extend`), and background-service name.
The app checks the releases page for updates itself and offers a new version
in the app, so you do not have to download it. Installs of 0.1.11-1.6 and earlier
have no updater: install the newer `.exe` over the old one once, and later
versions update themselves.

### T3 Extend command line

<!-- fork: T3 Extend only. Not part of upstream T3 Code. -->

A computer without the desktop app (macOS on Apple silicon, or Linux on x64 or
arm64) can install the `t3x` command with one line. The script downloads the
release archive, checks it against `SHA256SUMS`, and installs it into
`~/.t3extend`. It never touches official T3 Code's `~/.t3` or its `t3` command,
so the two can sit on one machine.

```bash
curl -fsSL https://raw.githubusercontent.com/SimpleEve/t3-extend/main/scripts/install-t3x.sh | sh
```

If `~/.local/bin` is not on your `PATH`, the script prints the line to add. Then
`t3x update` moves to the newest release, and `t3x service install` keeps the
server running in the background. Set `T3X_VERSION` to install a specific
version.

### The `t3` command

The desktop app bundles `t3` and sets it up on first launch (manage anytime under **Settings → About → t3 command**). Use **Add to PATH** if needed, then open a new terminal.

- **Open a folder in the running desktop app**: Run `t3 app` (or `t3 app ../my-project`) from a terminal, or drag folders from your file manager onto the desktop sidebar.

### Running next to official T3 Code

T3 Extend and official T3 Code can run on the same computer. They keep their own
data, settings, `t3x` command (use it wherever this guide says `t3`), background
service, link scheme and ports:

|                                  | T3 Code       | T3 Extend  |
| -------------------------------- | ------------- | ---------- |
| Server port                      | 3773          | 3873       |
| Tailscale HTTPS port             | 443           | 8443       |
| Branches for new worktrees       | `t3/…`        | `t3x/…`    |
| Pull request branches from forks | `t3code/pr-…` | `t3x/pr-…` |

Some things are shared because they live outside either app:

- Your repositories, and the provider tools. Both apps share your sign-in state and
  session files in `~/.claude` and `~/.codex`, so a session started in one can be
  found from the other. Both can work in the same repository; avoid giving threads
  in both the same worktree or branch.
- Your Tailscale machine name. Each app uses its own HTTPS port on it.
- macOS permissions such as screen recording, accessibility, camera and
  microphone. macOS asks again for T3 Extend.
- Global shortcuts. Turn Snap Shot on in one app at a time, or give them different
  shortcuts.

T3 Extend never creates, changes or removes anything on HTTPS port 443. A saved
Tailscale HTTPS setting of 443 from an earlier build moves to 8443 the next time
the app starts, and stays on, so remote access keeps working at the new address.
Phones and other devices that learned the old address will find the other app (or
nothing) there; they refuse it without sending credentials, and pick up the new
address the next time they connect or pair.

The 443 route an earlier T3 Extend build created is still in your Tailscale
configuration. Remove it yourself, and only if it is T3 Extend's:

1. Run `tailscale serve status`.
2. If 443 points to `http://127.0.0.1:3873` (T3 Extend's server), run
   `tailscale serve --https=443 --set-path=/ off`.
3. If 443 points anywhere else, such as port 3773, leave it. It belongs to
   official T3 Code or another service.

### Branch names

New worktree branches are named `t3x/…`, so they are not mistaken for official
T3 Code's `t3/…`. T3 Extend renames a new worktree's branch after the first message
only when it still has its own `t3x/…` temporary name. A thread whose branch is
named `t3/…` keeps it, whichever app created it, including threads T3 Extend made
before this change: the two can't be told apart, and renaming another app's
branch would be worse than leaving a temporary name. Rename such a branch yourself
if you want. Hidden refs that earlier T3 Extend builds wrote in your repositories
under official names, such as `refs/t3code/pre-refresh`, stay where they are; they
are harmless.

### Windows Subsystem for Linux

Select a WSL distro in **Settings → Sharing & access** to run agents and projects inside WSL (install provider CLIs inside that distro). T3 Code manages its own server runtime inside WSL automatically.

## Mobile app

<!-- fork: T3 Extend only. The App Store and Google Play pages belong to official T3 Code. -->

T3 Extend's Android app is an APK on the [releases
page](https://github.com/SimpleEve/t3-extend/releases); it is not on Google
Play. Copy it to the phone and open it, or run `adb install -r <apk>` from a
computer. It installs beside the official T3 Code app instead of replacing it.
The phone connects to a server on another machine. Follow [remote
access](./remote-access.md) to link it through [your own
server](./remote-access.md#your-own-server) or a pairing URL. There is no iOS
release; to use T3 Extend on an iPhone, [build it
yourself](#ios-build-it-yourself).

If the app crashes during launch, open Settings → Diagnostics on the next launch
that succeeds. It lists startup crashes from the last 7 days with the error and
component stack that store crash reports leave out. Copy the report and paste it
into a GitHub issue. Error messages can quote values from the app, so read it over
before sharing.

### iOS: build it yourself

T3 Extend has no iOS release, on the App Store, TestFlight, or anywhere else, and
there is no hosted service behind the app. You build it on your own Mac and sign
it with your own Apple account. Whether the project will ever publish an iOS
build of its own is undecided.

You need:

- A Mac with macOS 26.6 or later and Xcode 27.1 or later. Older Xcode versions
  fail to compile one of the app's dependencies.
- The iOS platform in Xcode (Xcode → Settings → Components, or
  `xcodebuild -downloadPlatform iOS`).
- An Apple account signed in under Xcode → Settings → Accounts. Note the team
  ID shown there; it is ten letters and digits.
- The iPhone connected by cable, unlocked, with Developer Mode turned on
  (Settings → Privacy & Security).

#### With a paid Apple Developer account

This is the build to use day to day. In a checkout of this repository, run
`vp i`, then from `apps/mobile`:

```bash
APP_VARIANT=production T3EXTEND_IOS_TEAM_ID=<your team id> \
  EXPO_NO_GIT_STATUS=1 npx expo prebuild --clean --platform ios
cd ios
xcodebuild -workspace T3Extend.xcworkspace -scheme T3Extend \
  -configuration Release -destination 'generic/platform=iOS' \
  -derivedDataPath build -allowProvisioningUpdates \
  DEVELOPMENT_TEAM=<your team id> build
xcrun devicectl device install app --device <device id> \
  build/Build/Products/Release-iphoneos/T3Extend.app
```

`xcrun devicectl list devices` shows the device id. The first build registers
the app ids and the App Group under your team; `-allowProvisioningUpdates` lets
Xcode do that. If the build stops with "doesn't match the entitlements file's
value for the com.apple.security.application-groups entitlement", open
`ios/T3Extend.xcworkspace` in Xcode once, select the `expo-sharing-extension`
target, pick your team under Signing & Capabilities, and build again.

Bundle identifiers are unique across all of Apple. The project's own is
`com.simpleeve.t3extend`; if another team already registered it, set
`T3EXTEND_IOS_BUNDLE_ID=com.example.t3extend` (an id of your own) for the
prebuild.

The app installed this way works for a year. Widgets and the share extension
work.

#### With a free Apple account

A free account (a Personal Team) can install the app too, with limits: Apple
stops the app after 7 days, and there are no push notifications, widgets, or
share extension. Use the same steps with these variables for the prebuild:

```bash
T3CODE_IOS_PERSONAL_TEAM=1 \
T3EXTEND_IOS_TEAM_ID=<your Personal Team id> \
T3CODE_IOS_PERSONAL_TEAM_BUNDLE_ID=com.example.t3extend \
```

#### Push notifications on iOS

Apple delivers every iPhone notification through its own service, APNs, and
only the Apple account that signed the app can send through it. T3 Extend has no
relay: your own T3 Extend server sends to APNs directly, with a key from the same
account you built the app with. A free account cannot sign push, so this needs
the paid-account build.

1. In your Apple Developer account, under Certificates, Identifiers & Profiles →
   Keys, create a key with Apple Push Notifications service (APNs) enabled.
   Download the `.p8` file (Apple lets you download it once) and note its Key
   ID. Creating keys needs the Admin or Account Holder role.
2. On each computer the iPhone connects to, add these lines to
   `~/.t3extend/service.env` (see [background service](./background-service.md#configure-the-service-environment)),
   then run `t3x service restart` or restart the desktop app. The background
   service and the desktop app both read them from there:

   ```dotenv
   T3EXTEND_APNS_KEY_FILE=/path/to/AuthKey_XXXXXXXXXX.p8
   T3EXTEND_APNS_KEY_ID=<Key ID>
   T3EXTEND_APNS_TEAM_ID=<your team id>
   ```

   Keep the `.p8` file private; anyone who has it can send notifications to
   your app. With none of the three set, push on iOS is simply off. With only
   some of them set, or a value that does not work, it stays off and the server
   logs one warning saying why.

3. On the iPhone, open Settings → Notifications, turn on push, and allow
   notifications. Send a test notification from the same page.

The settings page shows a warning for a server that has no key configured.
Android keeps using UnifiedPush and needs none of this.

#### If the build fails

- The build cannot find RaTeX's native files: run `node postinstall.mjs` in
  `apps/mobile/node_modules/react-native-enriched-markdown`, then build again.
- "No Accounts" or "No profiles": sign in again under Xcode → Settings →
  Accounts.

Connecting works the same as on Android: LAN, Tailscale, or your own server.
See [remote access](./remote-access.md). The mobile app's
[README](../../apps/mobile/README.md) has the development build.

## Providers

Open **Settings → Providers** (web or desktop), select the environment, and enable the providers you use. Installation and sign-in always happen on the **environment's machine**.

| Provider         | Install and authenticate                                                                                                 | Guide                                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------- |
| **Codex**        | Connect with ChatGPT in Settings, or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. | [Codex](./providers-codex.md)             |
| **Claude**       | Install [Claude Code](https://claude.com/product/claude-code) and run `claude auth login`.                               | [Claude](./providers-claude.md)           |
| **Cursor**       | Sign in in Settings or install [Cursor CLI](https://cursor.com/cli) and run `agent login`.                               | [Cursor](./cursor.md)                     |
| **Grok Build**   | Install [Grok Build CLI](https://x.ai/cli) and run `grok login`.                                                         | [Grok](./providers-grok.md)               |
| **Antigravity**  | Install managed runtime and sign in with Google in Settings.                                                             | [Antigravity](./providers-antigravity.md) |
| **OpenCode**     | Install [OpenCode](https://opencode.ai) and run `opencode auth login`.                                                   | [OpenCode](./providers-opencode.md)       |
| **Kiro**         | Install [Kiro CLI](https://kiro.dev/docs/cli/) and run `kiro-cli login`.                                                 | [Kiro](./providers-kiro.md)               |
| **Pi**           | Install [Pi](./providers-pi.md) (Node.js 22.19+) and run `pi` → `/login`.                                                | [Pi](./providers-pi.md)                   |
| **omp**          | Install [omp](./providers-omp.md#set-up-omp) and run `omp` → `/login`.                                                   | [omp](./providers-omp.md)                 |
| **Muse Code**    | Install [Muse Code](https://dev.meta.ai/docs/muse-code) and run `muse login`.                                            | [Muse Code](./providers-muse.md)          |
| **fx**           | Install [fx](https://fx.sh) and run `fx login`.                                                                          | [fx](./providers-fx.md)                   |
| **ACP Registry** | Add GitHub Copilot and other agents in **Settings → Providers → Add provider → Show more**.                              | [ACP](./providers-acp.md)                 |

- **Binary path**: If a CLI isn't on the server's `PATH` (common with version managers), set **Binary path** in the provider's settings.
- **Updates**: Click **Update now** on outdated provider cards (supports Homebrew, mise `latest`, npm/pnpm/Yarn/Bun/Volta/Vite+, or the CLI's own updater; update Nix, Chocolatey, or pinned mise installs manually).
- **Multiple instances**: Add extra provider instances for separate accounts, API keys, or custom endpoints (mark secret env vars as sensitive).

### Provider check timeouts

If a working CLI times out during T3 Code's readiness check, increase its probe deadline (in milliseconds) in the server's environment (or systemd override / `service.env`) and restart:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 t3 serve
```

| Provider     | Environment variable                   |
| ------------ | -------------------------------------- |
| Codex        | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude       | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor       | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity  | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok         | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro         | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx           | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi           | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| omp          | `T3CODE_OMP_PROBE_TIMEOUT_MS`          |
| Muse Code    | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode     | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

## Next steps

- [User guide index](./README.md): overview of how T3 Code works.
- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): control when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Updating T3 Code](./updating.md): keep apps, servers, and providers up to date.
