# T3 Extend

English | [简体中文](./README.zh-CN.md)

T3 Extend is an independent fork of [T3 Code](https://github.com/pingdotgg/t3code). It adds a Chinese interface, self-hosted connections, and push notifications on Android that do not depend on Google. It can be installed on the same computer as official T3 Code and run at the same time. The two apps do not share data, commands, ports, or services.

> T3 Extend is not affiliated with, endorsed by, or sponsored by T3 Tools Inc. The name "T3 Code" is used only to say where this project comes from. See [NOTICE](./NOTICE).

## Upstream version

T3 Extend currently includes upstream commit [`55c134a346`](https://github.com/pingdotgg/t3code/commit/55c134a346d5830399c82e647f29101fec22ecee) (2026-11-16). It is the 28th commit after the upstream nightly `v0.1.11-nightly.20261117.4814`. The current release is `v0.1.11-1.0`. A T3 Extend version is the upstream release it is built on, then the fork's own release number: in `0.1.11-1.0`, `0.1.11` is upstream and `1.0` is T3 Extend's. The Android app uses upstream's mobile version with the same suffix, `2.3.0-1.0`.

T3 Extend has almost everything this upstream version has. The main differences are below.

**What the fork adds:**

- A Chinese interface (web, desktop, Android). You can choose English, Simplified Chinese, or follow the system.
- A sidebar grouped by project. The bottom of the sidebar shows usage limits, resource use, and port status. The desktop app can keep the computer awake.
- Self-hosted connections: use your own VPS instead of T3 Connect, so your phone and other computers can reach this one.
- In the desktop app, you can open dev servers on a remote environment through `localhost`. On the phone, you can open a new browser tab.
- Android push goes through UnifiedPush and a self-hosted ntfy server, not Google. On a self-built iPhone app, your own server sends push straight to APNs.
- The macOS desktop app can run in the background. The server keeps working after you quit the app.
- Each reply lists the files and links it produced. The composer shows context usage and output speed.
- The omp provider, reading usage limits when Codex uses a custom endpoint, and Antigravity reusing the `agy` sign-in.
- Read-only import of projects, threads, and settings from official T3 Code on the same computer.
- Telemetry is off by default.

**What does not work in the fork:** T3 Connect, guest links, passkeys, mobile OTA updates, an iOS release (you can [build it yourself](./docs/user/install.md#ios-build-it-yourself) with your own Apple account), the official install scripts, and the official app store channels.

For the full list of features, the reasons behind these choices, and the sync history, see [Upstream version and fork features](./docs/fork/upstream.md).

## Install

Download from the [Releases](https://github.com/SimpleEve/t3-extend/releases) page:

- macOS (Apple silicon): `T3-Extend-<version>-arm64.dmg`. For install and first launch, see [install.md](./docs/user/install.md#t3-extend-on-macos).
- Android: `T3-Extend-<version>-arm64-v8a.apk`. See [install.md](./docs/user/install.md#mobile-app).
- A computer without the desktop app (macOS on Apple silicon, Linux x64 or arm64) can install the `t3x` command with one line. It downloads the release archive, checks it against `SHA256SUMS`, and installs into `~/.t3extend`:

  ```sh
  curl -fsSL https://raw.githubusercontent.com/SimpleEve/t3-extend/main/scripts/install-t3x.sh | sh
  ```

  After that, `t3x update` keeps it current and `t3x service install` runs it in the background.

- iPhone: there is no download. Build the app on your Mac and sign it with your own Apple account; see [iOS: build it yourself](./docs/user/install.md#ios-build-it-yourself).

T3 Extend runs no hosted service: no relay, no account system, no app store listing. Everything runs on your own computers and, if you want one, your own server. Whether the project will offer an official hosted deployment or a published iOS app later is undecided.

To build from source instead, see the packaging and signing section of [FORK.md](./FORK.md#打包与签名) (in Chinese) and the [development guide](./docs/operations/development.md#first-checkout).

The T3 Extend command is `t3x`. Its data directory is `~/.t3extend`, and its default port is 3873. Official T3 Code uses `t3`, `~/.t3`, and 3773, so the two do not conflict.

## Connect your phone and other computers

T3 Extend supports LAN pairing, Tailscale (HTTPS port 8443), a self-hosted server, and SSH. For how to choose, how to set each one up, and how to revoke access, see [Set up the server and access](./docs/fork/server-setup.md). To deploy a self-hosted server on a VPS, see [infra/self-host](./infra/self-host/README.md) (in Chinese).

## Documentation

- [Upstream version and fork features](./docs/fork/upstream.md)
- [Set up the server and access](./docs/fork/server-setup.md)
- [FORK.md](./FORK.md) (in Chinese): the fork's identity, the coexistence rules, the design of each feature, and the process for syncing upstream
- [Upstream docs](./docs/README.md): the user docs inherited from upstream. Places the fork changed are marked. Where the text says `t3`, use `t3x` in T3 Extend.

## Contributing

- Read [FORK.md](./FORK.md) and [AGENTS.md](./AGENTS.md) first. Lines where the fork changes an upstream file carry a `// fork:` comment. `vp run fork:guard` must pass before you commit.
- Report problems in upstream itself at [pingdotgg/t3code](https://github.com/pingdotgg/t3code).

## License

[MIT](./LICENSE). Copyright in upstream T3 Code belongs to T3 Tools Inc. The fork's changes use the same license. Third-party components bundled with the build, and their licenses, are listed in [NOTICE](./NOTICE).

The MIT license covers the source code only. It does not grant rights to T3 Tools Inc.'s trademarks or branding; see [TRADEMARK.md](./TRADEMARK.md). T3 Extend is an unofficial fork.
