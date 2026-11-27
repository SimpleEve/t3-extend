# T3 Extend 和上游 T3 Code 的关系

[English](./upstream.md) | 简体中文

T3 Extend 是 [T3 Code](https://github.com/pingdotgg/t3code) 的独立 fork（`SimpleEve/t3-extend`）。它跟着上游走：定期把上游 `main` 合并进来，fork 自己的改动尽量收在带 `// fork:` 注释的行和独立目录里。这份文档回答四件事：现在对应上游的哪个版本，fork 多了什么，有哪些上游能力在这里用不了，同步上游之后要更新哪里。

fork 的设计细节、身份表和合并规则都在 [FORK.md](../../FORK.md)，这份文档只做总览和导航。

## 当前版本

| 项                           | 值                                                                                                  |
| ---------------------------- | --------------------------------------------------------------------------------------------------- |
| 最近一次合入的上游提交       | `bc0f04da94f64b5e487c598761a43b4cf06b2ac9`（2026-11-26，上游正式版 `v0.1.13`）                      |
| 在上游的位置                 | 正式版标签 `v0.1.13`                                                                                |
| T3 Extend 桌面版和 server    | 0.1.12-1.9                                                                                          |
| T3 Extend Android 应用 (APK) | 2.3.0-1.9                                                                                           |
| iOS                          | 不发布。用 Xcode 和自己的 Apple 账号构建，见 [install.md](../user/install.md#ios-build-it-yourself) |

版本号由两段组成：前一段是所基于的上游版本，后一段是 fork 自己的 `主.次` 版本号。`0.1.11-1.0` 就是上游 0.1.11、T3 Extend 1.0。Android 应用在上游的移动端版本后面加同一个后缀（`2.3.0-1.0`）。fork 自己的版本号跨上游同步一直往上加，不会每次同步都清零。

### 同步历史

下表只列能在 git 历史里核实的同步：合并提交在 fork 的 `main` 上，上游提交都是它的祖先。"提交数"是这次同步相对上一次同步点新带进来的上游提交数。

| 同步日期   | 上游提交     | 上游提交日期 | 合并提交     | 提交数 |
| ---------- | ------------ | ------------ | ------------ | ------ |
| 2026-11-04 | `322f6544df` | 2026-11-03   | `92034340ac` | 302    |
| 2026-11-08 | `6417151c09` | 2026-11-08   | `76091396d5` | 373    |
| 2026-11-15 | `b9bbfda087` | 2026-11-14   | `c567a700fa` | 1928   |
| 2026-11-17 | `55c134a346` | 2026-11-16   | `aa782c0d5e` | 423    |
| 2026-11-20 | `724f5c6bec` | 2026-11-17   | `a7772bb6b5` | 141    |
| 2026-11-21 | `9cc4018c75` | 2026-11-20   | `b39cb114ac` | 459    |
| 2026-11-24 | `a7a6126a7d` | 2026-11-24   | `01fb5bc1de` | 834    |
| 2026-11-25 | `ca81b7b97a` | 2026-11-24   | `d35fbebd8c` | 209    |
| 2026-11-27 | `bc0f04da94` | 2026-11-26   | `4e14f0f93f` | 401    |

2026-11-04 之前也有过把上游并进来的合并，但没有留下可以核实的上游提交号，所以没有列。每次同步遇到的冲突和取舍记在 FORK.md 的[同步上游](../../FORK.md#同步上游)一节。

## fork 额外加的能力

### 语言和外观

- **中文界面。** 设置 → 通用 → 语言可以选英文、简体中文或跟随系统，web、桌面和 Android 都有，中文字体和字重做了单独的排版。见 [多语言](../../FORK.md#多语言)，用户说明在 [appearance.md](../user/appearance.md#language)。
- **侧栏按项目分组。** 侧栏有"按状态"和"按项目"两种视图，默认按项目，项目下再按 worktree 分组；手机的对话列表同样可选。见 [侧边栏视图](../../FORK.md#侧边栏视图)，用户说明在 [thread-sidebar.md](../user/thread-sidebar.md#choose-a-sidebar-view)。
- **侧栏状态芯片和保持唤醒。** 侧栏底部常驻订阅额度、资源占用和本项目本地服务端口三个芯片；桌面版另有"保持唤醒"开关，有任务在跑时不让电脑休眠。见 [侧边栏底部状态芯片与桌面保持唤醒](../../FORK.md#侧边栏底部状态芯片与桌面保持唤醒)。

### 对话里的信息

- **产出。** 每轮回复末尾列出这一轮产出的文件和链接，对话头部（web）或标题栏（手机）可以看整个对话的产出。不额外调用模型。见 [产出](../../FORK.md#产出)。
- **上下文圆环和 tok/s。** 输入框旁常驻上下文用量圆环和上一轮的输出速度，圆环里可以直接"立即压缩"。只有 provider 上报了本轮用量才显示速度，没有数据时不显示。见 [上下文圆环与输出速度](../../FORK.md#上下文圆环与输出速度)。

### 连接和远程使用

- **自建连接。** 用自己的 VPS 跑 registry、frps 和 Caddy，代替 T3 Connect，让电脑和手机互相连接，不经过官方 relay 和 Cloudflare。服务器一条命令部署，电脑和手机各用一把设备密钥，失败时不会回落到官方服务。见 [自建连接](../../FORK.md#自建连接)，部署步骤在 [infra/self-host/README.md](../../infra/self-host/README.md)，用户说明在 [remote-access.md](../user/remote-access.md#your-own-server)。
- **预览隧道的时钟偏差。** 远程 `localhost` 转发就是上游的预览隧道，没有改动；T3 Extend 只修了两台机器时钟差几分钟时票据过期的判断。见 FORK.md 的[远程环境的 localhost 转发](../../FORK.md#远程环境的-localhost-转发)。
- **手机新建浏览器标签页。** 手机上可以自己新建 Browser 标签页，打开宿主机上的页面（`localhost` 指宿主机），页面在宿主机渲染，手机只收画面。见 [手机新建浏览器标签页](../../FORK.md#手机新建浏览器标签页)，用户说明在 [remote-access.md](../user/remote-access.md#browser-on-a-remote-environment)。
- **Android 上不依赖 Google 的推送。** 通过 UnifiedPush 收 Agent 提醒（典型做法是在自己的 VPS 上跑 ntfy），不经过 Firebase、Cloudflare 和 Clerk，载荷端到端加密。见 [不依赖 Google 的推送](../../FORK.md#不依赖-google-的推送android)，用户说明在 [mobile-notifications.md](../user/mobile-notifications.md#push-without-google)。
- **桌面后台运行。** macOS 打包版设置 → 维护里的"在后台保持运行"开关：退出 app 之后服务继续跑，手机和推送不断。见 [后台运行（桌面版）](../../FORK.md#后台运行桌面版)，用户说明在 [background-service.md](../user/background-service.md#t3-extend-desktop-app-on-macos)。

### Provider

- **omp provider。** omp（oh-my-pi，Pi 的分支）作为原生 provider，和上游的 Pi 并存。见 [omp provider](../../FORK.md#omp-provider)，用户说明在 [providers-omp.md](../user/providers-omp.md)。
- **Codex 自定义端点下读订阅额度。** Codex 配了自定义 `openai_base_url` 时，上游会把额度显示成不支持；fork 加了一个可选开关，允许在这种配置下仍然读 ChatGPT 订阅额度。见 [Codex 自定义端点下读订阅额度](../../FORK.md#codex-自定义端点下读订阅额度)，用户说明在 [providers-codex.md](../user/providers-codex.md#read-limits-through-a-custom-endpoint)。
- **Antigravity 沿用 agy CLI 的登录。** 默认实例直接用终端里 `agy` 的登录，不用在 T3 里再登录一次；需要多账号时可以改回独立登录。见 [Antigravity 沿用本机 agy CLI 的登录](../../FORK.md#antigravity-沿用本机-agy-cli-的登录)，用户说明在 [providers-antigravity.md](../user/providers-antigravity.md#use-your-agy-cli-sign-in)。
- **Antigravity 读取额度是每个实例自己的开关，默认关闭。** 上游因为 Google 说调用它的内部接口 cloudcode-pa 可能让账号被标记，已经不再读取 Antigravity 的额度。T3 Extend 保留了这个读取，但实例要在设置里自己打开“读取 Google 额度”才会读，风险自负；账号切换不依赖它。见 [Antigravity 默认不读额度](../user/providers-antigravity.md#antigravity-quota-is-not-read-by-default) 和 FORK.md 的 [Antigravity 账号池、自动切换和网络代理](../../FORK.md#antigravity-账号池自动切换和网络代理)。

### 和官方 T3 Code 的关系

- **可以和官方 T3 Code 同机共存。** 两个应用各用各的数据目录、命令（fork 是 `t3x`）、端口、开机服务、URL scheme、bundle id 和 git 分支前缀，互不改写对方的数据。见 [身份](../../FORK.md#身份)和[共存保证](../../FORK.md#共存保证)，用户说明在 [install.md](../user/install.md#running-next-to-official-t3-code)。
- **从官方 T3 Code 导入。** 设置 → 维护里的"Import from T3 Code"，只读地读取本机官方 T3 Code 的数据，把选中的项目、对话、定时任务和设置带进 T3 Extend，官方数据不会被改动。只在桌面和 host 上的 server 可用，手机端没有入口。见 [从 T3 Code 导入](../../FORK.md#从-t3-code-导入)。
- **telemetry 默认关闭。** 产品使用数据只有设置了 `T3CODE_TELEMETRY_ENABLED=true` 才会上报。用户说明在 [telemetry.md](../user/telemetry.md)。

## 和上游不同、或者在 fork 里用不了的能力

下面这些不是 bug，是 fork 的取舍：它们依赖官方的账号、域名、签名或发布渠道，fork 没有。完整说明在 FORK.md 的[共存保证](../../FORK.md#共存保证)。

| 上游能力                                           | 在 T3 Extend 里的情况                                                                                                                                                                                                                                                                                                                                                    |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| T3 Connect、guest link、passkey                    | 默认不可用：它们需要官方的 `.env` 和云账号。连接改走[自建连接](#连接和远程使用)，或者局域网、Tailscale 直连                                                                                                                                                                                                                                                              |
| 官方移动推送                                       | 不使用；Android 改用 UnifiedPush，见上                                                                                                                                                                                                                                                                                                                                   |
| 桌面自动更新                                       | 有，从 `SimpleEve/t3-extend` 的 Releases 更新。`fork-release.yml` 的每次构建（含测试构建）都带更新 feed；本机打包没设 `T3CODE_DESKTOP_UPDATE_REPOSITORY` 就没有，菜单里也没有"Check for Updates"。0.1.11-1.6 及更早的安装没有更新器，要手动装一次 0.1.11-1.7。见[发布流程](../../deploy/release.zh-CN.md)                                                                |
| 移动端 OTA（官方 EAS）                             | 默认关闭，不带官方的 EAS 项目                                                                                                                                                                                                                                                                                                                                            |
| server 自更新（`t3x update`、"Update everything"） | 查询并下载 `SimpleEve/t3-extend` 的 [Releases](https://github.com/SimpleEve/t3-extend/releases)，跟随最新已发布的 `v<上游>-<fork>`（草稿和 CI 测试版会被跳过），不会把 fork 换成官方 T3 Code。macOS 打包版的后台运行用 app 自带的运行时，不需要下载                                                                                                                      |
| iOS 应用                                           | 不发布，以后是否发布待定。用自己的 Apple 账号自己构建签名：付费账号构建的版本有效一年，有小组件和分享扩展；免费账号每次有效 7 天，没有这两项。iOS 推送由你自己的服务端用你 Apple 账号的密钥直连 APNs 发送（[install.md](../user/install.md#ios-build-it-yourself)）。Android 以 APK 分发，不上 Google Play；设置里没有商店二维码，也没有指向官方商店和 `t3.codes` 的链接 |
| 官方安装脚本和 npm 启动器                          | 不要用于 T3 Extend：`scripts/install.sh`、`scripts/install.ps1`、`scripts/npm-launcher/` 默认安装官方的 `t3`。T3 Extend 在 macOS 上以磁盘映像分发、在 Windows 上以安装包分发，见 [install.md](../user/install.md#t3-extend-on-macos)                                                                                                                                     |
| Linux 的 fork 打包                                 | Linux 的打包身份（可执行文件名、`.desktop` 名称、metainfo）还没有隔离，fork 的包会和官方包冲突，不要在同一台 Linux 机器上同时安装两者。后台运行开关也只在 macOS 打包版里有                                                                                                                                                                                               |
| Windows 安装包                                     | Release 里有 x64 的 NSIS 安装包（`T3-Extend-<版本>-x64.exe`），用 fork 自己的身份，可以和官方 T3 Code 同机安装。没有签名：SmartScreen 会提示“未知发布者”（点“更多信息”再点“仍要运行”），开着智能应用控制（Smart App Control）时会直接拦下。没有 Windows on Arm 的包。见 [install.md](../user/install.md#t3-extend-on-windows)                                            |
| 非桌面版的 `t3x service install`                   | macOS（Apple silicon）和 Linux（x64、arm64）上可用。Release 里没有 Windows 归档，所以 Windows 上会失败。server 归档来自 fork 自己的 release，和 `scripts/install-t3x.sh` 安装、`t3x update` 跟随的是同一份；也可以用 `T3CODE_RELEASE_BASE_URL` 指向自己的镜像                                                                                                            |
| SSH 远程主机                                       | 远程主机上默认装的是官方 server，不是 fork 的；这类环境没有 localhost 转发                                                                                                                                                                                                                                                                                               |
| 上游自己的多语言（`gt-react` 等）                  | 不采用，fork 用自己的字典式 i18n                                                                                                                                                                                                                                                                                                                                         |

`FORK.md` 里[两个应用同机运行时仍然共用的东西](../../FORK.md#两个应用同机运行时仍然共用的东西)一节列出了同机运行时有意共用的资源，比如 `~/.claude`、`~/.codex` 里的登录状态和会话。

## 维护说明

每次把上游合并进 `main` 之后，更新这几处：

1. 本页[当前版本](#当前版本)里的上游提交、日期和它在上游的位置。
2. 本页[同步历史](#同步历史)表里加一行：同步日期、上游提交、合并提交、这次新带进来的上游提交数（`git rev-list --count <上次同步的上游提交>..<这次的上游提交>`）。
3. 发版后，把新版本号填进表里。
4. FORK.md 的[同步上游](../../FORK.md#同步上游)一节里记这次的冲突和取舍，这里不重复。

同步的具体步骤和检查命令也在那一节。新增或删掉 fork 的能力时，同步改本页的能力列表和上面的取舍表。

这几份文档都有中英文两版：本页、[搭建 server 与配置访问](./server-setup.zh-CN.md) 和根目录的 README。改一版就要同时改另一版，英文版是 `upstream.md`、`server-setup.md` 和 `README.md`。
