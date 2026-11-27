# How T3 Extend relates to upstream T3 Code

English | [简体中文](./upstream.zh-CN.md)

T3 Extend is an independent fork of [T3 Code](https://github.com/pingdotgg/t3code) (`SimpleEve/t3-extend`). It follows upstream: we merge upstream `main` in regularly, and keep the fork's own changes in lines marked `// fork:` and in separate directories where we can. This page answers four questions. Which upstream version is this? What does the fork add? Which upstream features do not work here? What do you update after syncing upstream?

The fork's design details, identity table, and merge rules are in [FORK.md](../../FORK.md) (written in Chinese). This page is only an overview and a guide to where things are.

## Current version

| Item                             | Value                                                                                                                              |
| -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Latest upstream commit merged    | `bc0f04da94f64b5e487c598761a43b4cf06b2ac9` (2026-11-26, upstream release `v0.1.13`)                                                |
| Position in upstream             | Release tag `v0.1.13`                                                                                                              |
| T3 Extend desktop app and server | 0.1.12-1.9                                                                                                                         |
| T3 Extend Android app (APK)      | 2.3.0-1.9                                                                                                                          |
| iOS                              | Not published. Build it yourself with Xcode and your own Apple account; see [install.md](../user/install.md#ios-build-it-yourself) |

A version is the upstream release it is built on, then the fork's own `major.minor`: `0.1.11-1.0` is upstream 0.1.11 and T3 Extend 1.0. The Android app puts the same suffix on upstream's mobile version (`2.3.0-1.0`). The fork's number keeps counting up across upstream syncs; it does not restart at each one.

### Sync history

This table lists only syncs you can verify in git history. The merge commit is on the fork's `main`, and the upstream commit is its ancestor. "Commits" is the number of upstream commits this sync brought in that the previous sync did not have.

| Sync date  | Upstream commit | Upstream commit date | Merge commit | Commits |
| ---------- | --------------- | -------------------- | ------------ | ------- |
| 2026-11-04 | `322f6544df`    | 2026-11-03           | `92034340ac` | 302     |
| 2026-11-08 | `6417151c09`    | 2026-11-08           | `76091396d5` | 373     |
| 2026-11-15 | `b9bbfda087`    | 2026-11-14           | `c567a700fa` | 1928    |
| 2026-11-17 | `55c134a346`    | 2026-11-16           | `aa782c0d5e` | 423     |
| 2026-11-20 | `724f5c6bec`    | 2026-11-17           | `a7772bb6b5` | 141     |
| 2026-11-21 | `9cc4018c75`    | 2026-11-20           | `b39cb114ac` | 459     |
| 2026-11-24 | `a7a6126a7d`    | 2026-11-24           | `01fb5bc1de` | 834     |
| 2026-11-25 | `ca81b7b97a`    | 2026-11-24           | `d35fbebd8c` | 209     |
| 2026-11-27 | `bc0f04da94`    | 2026-11-26           | `4e14f0f93f` | 401     |

Upstream was also merged in before 2026-11-04, but those merges did not leave an upstream commit ID we can verify, so they are not listed. The conflicts and trade-offs of each sync are recorded in the [Syncing upstream](../../FORK.md#同步上游) section of FORK.md.

## What the fork adds

### Language and appearance

- **Chinese interface.** Choose **Settings → General → Language** to use English, Simplified Chinese, or follow the system. It works on web, desktop, and Android. Chinese text has its own font and weight settings. See [Multi-language](../../FORK.md#多语言) in FORK.md. For the user guide, see [appearance.md](../user/appearance.md#language).
- **Sidebar grouped by project.** The sidebar has two views, "By status" and "By project". By project is the default, and it groups threads by worktree under each project. The thread list on the phone has the same choice. See [Sidebar views](../../FORK.md#侧边栏视图) in FORK.md. For the user guide, see [thread-sidebar.md](../user/thread-sidebar.md#choose-a-sidebar-view).
- **Sidebar status chips and keep awake.** The bottom of the sidebar always shows three chips: subscription usage limits, resource use, and the local service ports of the current project. The desktop app also has a "keep awake" switch that stops the computer from sleeping while tasks run. See [Sidebar footer status chips and desktop keep awake](../../FORK.md#侧边栏底部状态芯片与桌面保持唤醒) in FORK.md.

### Information in threads

- **Outputs.** At the end of each reply, the fork lists the files and links that turn produced. The thread header (web) or the title bar (phone) shows the outputs of the whole thread. It makes no extra model calls. See [Outputs](../../FORK.md#产出) in FORK.md.
- **Context ring and tokens per second.** Beside the composer, a context usage ring and the output speed of the last turn are always visible. You can click "Compact now" in the ring. The speed shows only when the provider reports usage for that turn. Without that data, it is hidden. See [Context ring and output speed](../../FORK.md#上下文圆环与输出速度) in FORK.md.

### Connections and remote use

- **Self-hosted connections.** Run a registry, frps, and Caddy on your own VPS instead of T3 Connect, so your computers and phone can connect to each other without the official relay or Cloudflare. You deploy the server with one command. Each computer and phone gets its own device key. If a connection fails, it does not fall back to the official service. See [Self-hosted connections](../../FORK.md#自建连接) in FORK.md. For deployment steps, see [infra/self-host/README.md](../../infra/self-host/README.md) (in Chinese). For the user guide, see [remote-access.md](../user/remote-access.md#your-own-server).
- **Clock skew in the preview tunnel.** Remote `localhost` forwarding is upstream's preview tunnel, unchanged. T3 Extend only fixes how its tickets expire when the two machines' clocks differ by minutes. See [Localhost forwarding for remote environments](../../FORK.md#远程环境的-localhost-转发) in FORK.md.
- **New browser tabs on the phone.** On the phone, you can create a Browser tab yourself and open a page on the host (`localhost` means the host). The page is rendered on the host, and the phone only receives the picture. See [New browser tabs on the phone](../../FORK.md#手机新建浏览器标签页) in FORK.md. For the user guide, see [remote-access.md](../user/remote-access.md#browser-on-a-remote-environment).
- **Push on Android without Google.** Agent alerts arrive through UnifiedPush (typically with ntfy running on your own VPS). Nothing goes through Firebase, Cloudflare, or Clerk, and the payload is end-to-end encrypted. See [Push without Google](../../FORK.md#不依赖-google-的推送android) in FORK.md. For the user guide, see [mobile-notifications.md](../user/mobile-notifications.md#push-without-google).
- **Desktop background service.** In the packaged macOS app, **Settings → Maintenance → Keep running in the background** keeps the server running after you quit the app, so your phone and push notifications keep working. See [Background service (desktop)](../../FORK.md#后台运行桌面版) in FORK.md. For the user guide, see [background-service.md](../user/background-service.md#t3-extend-desktop-app-on-macos).

### Providers

- **omp provider.** omp (oh-my-pi, a fork of Pi) is a native provider. It sits next to upstream's Pi. See [omp provider](../../FORK.md#omp-provider) in FORK.md. For the user guide, see [providers-omp.md](../user/providers-omp.md).
- **Reading subscription limits with a custom Codex endpoint.** When Codex is set up with a custom `openai_base_url`, upstream shows limits as unsupported. The fork adds an optional switch that still reads your ChatGPT subscription limits in that setup. See [Reading subscription limits with a custom Codex endpoint](../../FORK.md#codex-自定义端点下读订阅额度) in FORK.md. For the user guide, see [providers-codex.md](../user/providers-codex.md#read-limits-through-a-custom-endpoint).
- **Antigravity reuses the agy CLI sign-in.** The default instance uses the `agy` sign-in from your terminal, so you do not sign in again in T3. If you need several accounts, you can switch back to a separate sign-in. See [Antigravity reuses the local agy CLI sign-in](../../FORK.md#antigravity-沿用本机-agy-cli-的登录) in FORK.md. For the user guide, see [providers-antigravity.md](../user/providers-antigravity.md#use-your-agy-cli-sign-in).
- **Antigravity quota reading is a per-instance switch, off by default.** Upstream stopped reading Antigravity limits because Google says calling its internal cloudcode-pa API can get an account flagged. T3 Extend keeps the reading, but an instance only does it after you turn on **Read quota from Google** in its settings, at your own risk. Account switching does not need it. See [Antigravity quota is not read by default](../user/providers-antigravity.md#antigravity-quota-is-not-read-by-default) and FORK.md.

### Relationship with official T3 Code

- **Runs next to official T3 Code on the same computer.** Each app has its own data directory, command (the fork uses `t3x`), ports, login service, URL scheme, bundle id, and git branch prefix. Neither app changes the other's data. See [Identity](../../FORK.md#身份) and [Coexistence guarantees](../../FORK.md#共存保证) in FORK.md. For the user guide, see [install.md](../user/install.md#running-next-to-official-t3-code).
- **Import from official T3 Code.** **Settings → Maintenance → Import from T3 Code** reads the data of official T3 Code on this computer, read-only. It brings the projects, threads, scheduled tasks, and settings you select into T3 Extend. The official data is not changed. It is available only in the desktop app and on a host server. The phone has no entry for it. See [Import from T3 Code](../../FORK.md#从-t3-code-导入) in FORK.md.
- **Telemetry is off by default.** Product usage data is reported only if you set `T3CODE_TELEMETRY_ENABLED=true`. For the user guide, see [telemetry.md](../user/telemetry.md).

## Differences from upstream, and features that do not work in the fork

These are not bugs. They are trade-offs of the fork. These features depend on the official accounts, domains, signing, or release channels, and the fork does not have them. The full explanation is in the [Coexistence guarantees](../../FORK.md#共存保证) section of FORK.md.

| Upstream feature                                             | In T3 Extend                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T3 Connect, guest link, passkey                              | Not available by default. They need the official `.env` and cloud accounts. For connections, use [self-hosted connections](#connections-and-remote-use), or connect directly over a LAN or Tailscale                                                                                                                                                                                                                                                                                                                                 |
| Official mobile push                                         | Not used. Android uses UnifiedPush instead, see above                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Desktop auto-update                                          | Yes, from the releases of `SimpleEve/t3-extend`. Every build from `fork-release.yml`, test builds included, carries the update feed; a local build without `T3CODE_DESKTOP_UPDATE_REPOSITORY` has none, and no "Check for Updates". Installs of 0.1.11-1.6 and earlier have no updater: install 0.1.11-1.7 by hand once. See [the release procedure](../../deploy/release.md)                                                                                                                                                        |
| Mobile OTA updates (official EAS)                            | Off by default. The official EAS project is not included                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Server self-update (`t3x update`, "Update everything")       | It checks the [Releases](https://github.com/SimpleEve/t3-extend/releases) page of `SimpleEve/t3-extend` and follows its newest published `v<upstream>-<fork>` release (draft and CI test builds are skipped). It never swaps the fork for official T3 Code. The background service in the packaged macOS app uses the runtime bundled with the app, so it does not download anything                                                                                                                                                 |
| iOS app                                                      | Not published, and whether it will be is undecided. You build it yourself and sign it with your own Apple account: a paid account gives a build that lasts a year with widgets and the share extension; a free one lasts 7 days without them. On iOS, your own server sends push straight to APNs with a key from your Apple account ([install.md](../user/install.md#ios-build-it-yourself)). Android is distributed as an APK, not on Google Play. Settings has no store QR code and no links to the official stores or `t3.codes` |
| Official install scripts and npm launcher                    | Do not use them for T3 Extend. `scripts/install.sh`, `scripts/install.ps1`, and `scripts/npm-launcher/` install the official `t3` by default. T3 Extend is distributed as a disk image on macOS and an installer on Windows, see [install.md](../user/install.md#t3-extend-on-macos)                                                                                                                                                                                                                                                 |
| Fork packaging for Linux                                     | The Linux packaging identity (executable name, `.desktop` name, metainfo) is not isolated yet, so the fork's package conflicts with the official one. Do not install both on the same Linux machine. The background service switch exists only in the packaged macOS app                                                                                                                                                                                                                                                             |
| Windows installer                                            | Releases carry an x64 NSIS installer (`T3-Extend-<version>-x64.exe`) with the fork's identity, so it installs beside official T3 Code. It is unsigned: SmartScreen shows "Unknown publisher" (More info → Run anyway), and Smart App Control blocks it outright. No Windows on Arm build. See [install.md](../user/install.md#t3-extend-on-windows)                                                                                                                                                                                  |
| `t3x service install` outside the desktop app                | Works on macOS (Apple silicon) and Linux (x64, arm64). Releases have no Windows archive, so it fails on Windows. The server archive comes from the fork's own releases, the same one `scripts/install-t3x.sh` installs and `t3x update` follows. You can point `T3CODE_RELEASE_BASE_URL` at your own mirror                                                                                                                                                                                                                          |
| SSH remote hosts                                             | The server installed on a remote host is the official one by default, not the fork's. These environments have no localhost forwarding                                                                                                                                                                                                                                                                                                                                                                                                |
| Upstream's own multi-language support (`gt-react` and so on) | Not adopted. The fork uses its own dictionary-style i18n                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

The section [What stays shared when both apps run on one computer](../../FORK.md#两个应用同机运行时仍然共用的东西) in FORK.md lists the resources the two apps share on purpose, such as sign-in state and sessions in `~/.claude` and `~/.codex`.

## Maintenance

After you merge upstream into `main`, update these places:

1. In [Current version](#current-version) on this page, update the upstream commit, its date, and its position in upstream.
2. Add a row to the [Sync history](#sync-history) table: the sync date, the upstream commit, the merge commit, and the number of new upstream commits this sync brought in (`git rev-list --count <upstream commit of the last sync>..<upstream commit of this sync>`).
3. After a release, put its version in the table.
4. Record this sync's conflicts and trade-offs in the [Syncing upstream](../../FORK.md#同步上游) section of FORK.md. Do not repeat them here.

The exact steps and check commands for a sync are in that same section. When you add or remove a fork feature, also update the feature list on this page and the trade-off table above.

These docs come in two languages, English and Chinese: this page, [Set up the server and access](./server-setup.md), and the README in the repo root. When you change one version, change the other too. The Chinese files are `upstream.zh-CN.md`, `server-setup.zh-CN.md`, and `README.zh-CN.md`.
