# Install T3 Code

T3 Code runs coding agents on your computer and lets you control them from its
desktop, web, or mobile app. Set up the machine where the agents will work first.

## Requirements

You need an installed, authenticated provider before starting a thread. You can
launch T3 Code and configure providers afterwards.

## Command line

```bash
curl -fsSL https://t3.codes/install.sh | sh
```

On Windows, in PowerShell:

```powershell
irm https://t3.codes/install.ps1 | iex
```

This installs the `t3` command to `~/.local/bin`. If that folder is not on your
`PATH` yet, the installer says so and, for zsh, bash on Linux, and fish, prints
a command to add it. On Windows, `t3` works in the same PowerShell window right
away; add the folder to your `PATH` for new windows. If a `t3` that the
installer or the desktop app did not create is already there, it leaves that
one alone and stops. Set `T3CODE_CHANNEL=nightly` to install the nightly train, or
`T3CODE_VERSION` to pin an exact version.

| Task                                  | Command                                                                 |
| ------------------------------------- | ----------------------------------------------------------------------- |
| Start the server and open the web app | `t3`                                                                    |
| Start the server without a browser    | `t3 serve`                                                              |
| Use it from your other devices        | `t3 up` ([details](./remote-access.md))                                 |
| Keep it running in the background     | `t3 service install` ([details](./background-service.md))               |
| Move to the newest release            | `t3 update`                                                             |
| Reclaim database space                | `t3 doctor` ([details](./background-service.md#reclaim-database-space)) |
| Remove it again                       | `t3 uninstall`                                                          |

Run `t3 help` or `t3 --help` for the full reference. To start in a new working
directory, use an explicit path such as `t3 ./my-project`. A bare directory name
is accepted only if it already exists.

If `t3` or `t3 start` reports an already running server, run the `t3 pair`
command it names and open the pairing URL to connect to that server. Stop it
before starting a replacement, or use a different `--base-dir` for an
independent server.

To try T3 Code once without installing it, run `npx t3@latest` instead (needs
Node.js for `npx`). It offers to install the `t3` command first. If you say no,
it asks again at the next minor release, and `npx t3 install` installs it later.
`npx t3` always runs the version npm picked, even when a `t3` is installed. On
the nightly train, run your installed `t3` (for example `t3 connect`), not
`npx t3`, which runs the latest stable release.

### Intel Macs

There is no `t3` executable for Intel Macs (the desktop app is available). To
run a server there, build it from source with `vp`, which provides the Node version it needs
([Install vp](../operations/development.md#first-checkout)):

```bash
git clone https://github.com/pingdotgg/t3code
cd t3code && vp i && vp run build:desktop
node apps/server/dist/bin.mjs
```

`t3 update` and the background service do not apply to a server run this way;
update it with `git pull` and a rebuild.

## Desktop app

Download a release from [GitHub Releases](https://github.com/pingdotgg/t3code/releases),
or use a package manager:

| Platform           | Install                                                      |
| ------------------ | ------------------------------------------------------------ |
| Windows            | `winget install T3Tools.T3Code`                              |
| Windows (Scoop)    | `scoop install extras/t3code`                                |
| macOS              | `brew install --cask t3-code`                                |
| Debian, Ubuntu     | `sudo apt install ./T3-Code-*.deb`                           |
| Arch Linux         | `yay -S t3code-bin`                                          |
| Arch Linux nightly | `yay -S t3code-nightly-bin`                                  |
| Nix                | `nix profile add github:NixOS/nixpkgs/nixos-unstable#t3code` |

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

### Linux

AppImage and `.deb` downloads are available for x86_64 and ARM64. Check your
architecture with `uname -m`: for `x86_64`, choose a file ending in
`x86_64.AppImage` or `amd64.deb`; for `aarch64`, choose `arm64.AppImage` or
`arm64.deb`.

To launch an AppImage, open a terminal in its download folder. Replace
`T3-Code.AppImage` below with the exact filename you downloaded:

```bash
chmod +x ./T3-Code.AppImage
./T3-Code.AppImage
```

The `.deb` updates itself like the other desktop builds. It asks for your
password to install each update. If your desktop has no password prompt, the
update fails. Download the new `.deb` and install it the same way.

The AUR packages currently support x86_64 only; on ARM64, use the AppImage.
Update AUR installs with your AUR helper, such as `yay -Syu`, instead of the
in-app updater.

### Nix (nixpkgs)

T3 Code is maintained in [nixpkgs](https://github.com/NixOS/nixpkgs/tree/nixos-unstable/pkgs/by-name/t3/t3code).
The command above installs from `nixos-unstable` and requires Nix 2.30 or later with
`nix-command` and `flakes` enabled. Launch the desktop app with `t3code-desktop`;
the package also includes the `t3` command.

On NixOS, you can instead add the package to your system configuration, using
a nixpkgs revision that includes `t3code`:

```nix
environment.systemPackages = [ pkgs.t3code ];
```

Apply the change with `sudo nixos-rebuild switch`. For Home Manager, add
`pkgs.t3code` to `home.packages` and run `home-manager switch`.

Update a profile installation with `nix profile upgrade t3code`. For NixOS or
Home Manager, update your configuration's nixpkgs input or channel and rebuild.
Nix manages both the desktop app and the bundled
`t3` command; use Nix to update them instead of the in-app updater or `t3 update`.

### The `t3` command

The desktop app includes the `t3` command-line tool. A new install sets it up
on first launch; after an update, or any time, choose **Install** next to
**t3 command** in **Settings → About**. On macOS and Linux it adds a `t3` link
in `~/.local/bin` (or `~/bin`); on Windows it adds the app's command folder to
your `PATH`. Open a new terminal afterwards. If the folder is not on your
`PATH`, **Add to PATH** on the Welcome page or in **Settings → About** adds one
line to your shell's startup file. **Remove** takes it off, and the app does not
add it again. If you already have another `t3`, it stays as it is.

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

Choose a WSL distro in **Settings → Sharing & access** to run agents and projects
there. Install the provider CLIs inside that distro. T3 Code installs its own
server runtime there automatically; the first launch after an app update can
take longer.

### Open a project from a terminal

With the desktop app already running on the same machine:

```bash
t3 app
```

This opens a new thread for the current directory, adding the project if needed.
Pass a path, such as `t3 app ../my-project`, to open another directory. It requires
the desktop app, so a standalone server or an SSH session is not enough. If the
command cannot reach the app, start or update the desktop app and try again.

### Drop a folder on the sidebar

Drag one or more folders from Finder, Explorer, or your file manager onto the
sidebar. Each one opens as a project on this computer, the same as `t3 app`.
Files dropped on a thread still attach to that thread. Browsers do not share
folder paths, so in the web app use **Add project** instead.

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
2. On each computer the iPhone connects to, start the server with:

   ```bash
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

Open **Settings → Providers** in the web or desktop app, select the environment,
and enable the provider you want. Installation, login, and configuration belong
to that environment's machine, even when you connect from a phone or another
computer.

| Provider    | Install and authenticate                                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex       | [Connect with ChatGPT](./providers-codex.md#connect-with-chatgpt), or install [Codex CLI](https://developers.openai.com/codex/cli) and run `codex login`. |
| Claude      | Install [Claude Code](https://claude.com/product/claude-code), then run `claude auth login`.                                                              |
| Cursor      | Install [Cursor CLI](https://cursor.com/cli), then run `agent login`.                                                                                     |
| Grok Build  | Install [Grok Build CLI](https://x.ai/cli), then run `grok login`.                                                                                        |
| Kiro        | Install [Kiro CLI](https://kiro.dev/docs/cli/), then run `kiro-cli login`.                                                                                |
| OpenCode    | Install [OpenCode](https://opencode.ai), then run `opencode auth login`.                                                                                  |
| Antigravity | Install and sign in with Google from T3 Code's provider settings.                                                                                         |
| Pi          | Install [Pi](./providers-pi.md#set-up-pi) with Node.js 22.19 or newer, then run `pi` and `/login`.                                                        |
| omp         | Install [omp](./providers-omp.md#set-up-omp), then run `omp` and `/login`.                                                                                |
| Muse Code   | Install [Muse Code](https://dev.meta.ai/docs/muse-code) on the server, run `muse login`, then enable it in Settings → Providers.                          |
| fx          | Install [fx](https://fx.sh) with `curl -fsSL https://fx.sh/setup.sh \| bash`, then run `fx login`.                                                        |

Provider CLIs must be on the server's `PATH`. If T3 Code cannot find one, set its
**Binary path** in provider settings, especially when using a version manager.
Cursor's executable is `cursor-agent`, although its login command is
`agent login`. Codex connected through ChatGPT and Antigravity can use their
managed runtimes without a `PATH` entry.

T3 Code warns when a provider version has known compatibility problems with your
release. Check **Settings → Providers** on that environment for the recommended
version or range. When its package manager supports installing a specific version,
you can install the recommendation there. Otherwise use the provider's installer
on the environment's machine. An unlisted version is unverified.

When a provider CLI is behind its latest release, its provider card shows the
available version. **Update now** runs the installer that owns the CLI
(Homebrew, mise, or a global npm, pnpm, Yarn, Bun, Volta, or Vite+ install), or
the CLI's own update command when T3 Code cannot tell. Claude, Codex, and
OpenCode installs T3 Code cannot identify stay manual: update them through the
installer you used. T3 Code runs `mise upgrade`
only for a tool your mise config requests as `latest` when the provider's binary
path is a mise shim or under the tool's `installs/<tool>/latest` link; update a
pinned version, or a path into one version's directory, through mise yourself.
Update a CLI installed with Nix through Nix.
Cursor and Antigravity update with T3 Code. Homebrew and Chocolatey installs
compare against the version their package manager offers, which can trail the
npm release; update Claude installed with Chocolatey through Chocolatey.

The managed runtimes for Antigravity and for Codex connected through ChatGPT
first install the release T3 Code tested. When T3 Code finds a newer compatible
release, their setup in **Settings → Providers** offers an update.

Add another provider instance for a separate account or configuration. Each
instance can have its own environment variables, such as API keys or a custom
base URL. Mark secret values as sensitive; after saving, T3 Code does not display
their original values.

For provider-specific setup and accounts, see [Codex](./providers-codex.md),
[Claude](./providers-claude.md), [OpenCode](./providers-opencode.md),
[Antigravity](./providers-antigravity.md), [Kiro](./providers-kiro.md),
[Pi](./providers-pi.md), [omp](./providers-omp.md), [Muse Code](./providers-muse.md), and [fx](./providers-fx.md).

### Provider check timeouts

If a provider works in its CLI but T3 Code reports a timeout while checking it,
allow more time in the T3 server's environment. For example, give Codex and
Claude readiness checks 60 seconds:

```bash
T3CODE_CODEX_PROBE_TIMEOUT_MS=60000 T3CODE_CLAUDE_PROBE_TIMEOUT_MS=60000 t3 serve
```

For a remote environment, set these on the machine running the T3 server.
Keep them in your launcher or service configuration to retain them across
updates, then restart the server. For systemd, add
`Environment=T3CODE_CODEX_PROBE_TIMEOUT_MS=60000` under `[Service]` in a service
override, reload systemd, and restart the service. Provider instances can also
set their own overrides in Settings → Providers.

Each variable extends that provider's readiness-probe deadlines; a phase whose
default is already longer keeps its default. Providers with several phases can
take longer than one deadline in total. Values must be whole milliseconds no
greater than 2147483647; unset or invalid values keep the defaults.

| Provider            | Environment variable                   |
| ------------------- | -------------------------------------- |
| Codex               | `T3CODE_CODEX_PROBE_TIMEOUT_MS`        |
| Claude              | `T3CODE_CLAUDE_PROBE_TIMEOUT_MS`       |
| Cursor              | `T3CODE_CURSOR_PROBE_TIMEOUT_MS`       |
| Antigravity         | `T3CODE_ANTIGRAVITY_PROBE_TIMEOUT_MS`  |
| Grok                | `T3CODE_GROK_PROBE_TIMEOUT_MS`         |
| Kiro                | `T3CODE_KIRO_PROBE_TIMEOUT_MS`         |
| fx                  | `T3CODE_FX_PROBE_TIMEOUT_MS`           |
| Pi                  | `T3CODE_PI_PROBE_TIMEOUT_MS`           |
| omp                 | `T3CODE_OMP_PROBE_TIMEOUT_MS`          |
| Muse Code           | `T3CODE_MUSE_PROBE_TIMEOUT_MS`         |
| OpenCode            | `T3CODE_OPENCODE_PROBE_TIMEOUT_MS`     |
| ACP Registry agents | `T3CODE_ACP_REGISTRY_PROBE_TIMEOUT_MS` |

Longer deadlines also take longer to report a stalled check. These overrides
cover readiness and discovery, including OpenCode server startup. Usage and
config enrichment retain their own shorter limits. Turn execution, package
installation, update checks, and shutdown limits keep their existing behavior.

## Next steps

- [Working with threads](./thread-sidebar.md): start tasks and organize parallel work.
- [Permission modes](./permission-modes.md): choose when agents ask before acting.
- [Remote access](./remote-access.md): connect from another device.
- [Running in the background](./background-service.md): keep a host available.
- [Updating T3 Code](./updating.md): update the app and connected servers.
- [Managed policy](./managed-policy.md): configure T3 Code for everyone on a machine.
