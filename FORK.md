# T3 Extend

T3 Extend 是 [T3 Code](https://github.com/pingdotgg/t3code) 的二开 fork（`SimpleEve/t3-extend`）。它的 macOS 桌面版（开发版和打包版）、Windows x64 安装包、server / CLI 和 Android 应用，都可以和本机安装的官方 T3 Code 同时运行，互不改写对方的数据、命令、服务和更新。Linux 打包还没有隔离，见下文"例外和限制"。

## 身份

所有 fork 身份集中在 `packages/shared/src/forkIdentity.ts`。上游文件里引用它的地方都只改一行，并带 `// fork:` 注释。不能 import 的地方（`apps/desktop/package.json` 的 `productName`、`apps/desktop/scripts/electron-launcher.mjs`、`apps/mobile/package.json` 的 `--scheme`、iOS 小组件、移动端测试脚本）直接写字面量。

| 项                                                   | 官方 T3 Code                                    | T3 Extend                                                                                                    |
| ---------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| 应用名                                               | T3 Code (Beta / Nightly / Dev)                  | T3 Extend (Beta / Nightly / Dev)                                                                             |
| appId / bundle id / Android 包名                     | `com.t3tools.t3code`                            | `com.simpleeve.t3extend`，移动端变体加 `.dev` / `.preview`                                                   |
| Electron userData                                    | `t3code-v2` / `t3code-dev`                      | `t3extend` / `t3extend-dev`                                                                                  |
| URL scheme                                           | `t3code` / `t3code-dev` / `t3code-preview`      | `t3extend` / `t3extend-dev` / `t3extend-preview`                                                             |
| T3 home                                              | `~/.t3`                                         | `~/.t3extend`                                                                                                |
| CLI shim 与 PATH 软链接                              | `t3`                                            | `t3x`                                                                                                        |
| 开机服务                                             | `com.t3tools.t3code.service` / `t3code.service` | `com.simpleeve.t3extend.service` / `t3extend.service`                                                        |
| 默认端口（桌面后端、headless server）                | 3773                                            | 3873                                                                                                         |
| Tailscale HTTPS 端口                                 | 443                                             | 8443（`FORK.tailscaleServePort`）                                                                            |
| 新 worktree 的临时分支                               | `t3/<hex>`                                      | `t3x/<hex>`；官方的 `t3/<hex>`、`t3code/…` 只用于显示                                                        |
| 自动命名分支的默认前缀（`branchNamePrefix`）         | `t3`                                            | `t3x`                                                                                                        |
| 跨仓库 PR 的本地分支                                 | `t3code/pr-<n>/…`                               | `t3x/pr-<n>/…`                                                                                               |
| 拉取 PR 时备份被重置掉的提交的 ref                   | `refs/t3code/pre-refresh`                       | `refs/t3x/pre-refresh`                                                                                       |
| review guide 的临时 base ref                         | `refs/t3/review-guide/<n>/base`                 | `refs/t3x/review-guide/<n>/base`                                                                             |
| server 发布源                                        | `pingdotgg/t3code`                              | `SimpleEve/t3-extend` 的 Releases（`fork-release.yml` 发布）                                                 |
| 桌面更新 feed                                        | GitHub Releases                                 | `SimpleEve/t3-extend` 的 Releases；`fork-release.yml` 的每次构建（含测试构建）都带，本机打包默认不带（见下） |
| 移动端 OTA                                           | 官方 EAS 项目                                   | 无，除非设置 `T3EXTEND_EAS_PROJECT_ID` 和 `T3CODE_MOBILE_UPDATES_ENABLED=1`                                  |
| telemetry                                            | 默认开                                          | 默认关，`T3CODE_TELEMETRY_ENABLED=true` 才上报                                                               |
| 设置 > 关于 > 移动应用（商店二维码）、手机「法律」页 | 指向官方 App Store、Google Play 和 `t3.codes`   | 都去掉；Android 只发 APK，文档在 `docs/user/install.md` 的"Mobile app"                                       |

界面和用户文档对 telemetry 的说法跟着这一行走：欢迎向导和设置 > 关于里只讲"默认不收集，要开就设 `T3CODE_TELEMETRY_ENABLED=true`"，不再链到上游 `t3.codes` 的隐私政策（fork 没有自己的）。客户端读不到服务端的实际开关（`ServerConfig` 没有这个字段），所以文案不随服务端状态分支，只在 managed policy 关掉时换成组织的说明。`docs/user/telemetry.md` 开头、中继追踪和手机端崩溃报告三处是 fork 改的上游文档，同步上游时留意冲突。

git 命名空间（`FORK.gitNamespace` = `t3x`）管的是 fork 往用户仓库里新写的分支和 ref。上游把这些名字写死在 `packages/shared/src/git.ts` 的 `WORKTREE_BRANCH_PREFIX` 和 `PULL_REQUEST_BRANCH_PREFIX`、`GitVcsDriverCore.ts`、`PullRequestReviewGuideService.ts` 里，fork 的改动都带 `// fork:`。

分支谓词分成两个（`packages/shared/src/git.ts`）：`isTemporaryWorktreeBranch` 只认 fork 自己的 `t3x/<hex>` 和 `t3x-<hex>`，所有会改 git 的路径都用它；`looksLikeTemporaryWorktreeBranch` 另外认官方的 `t3/<hex>`、`t3-<hex>` 和旧的 `t3code/…`，只用于显示和元数据，不会触发任何 git 写入。调用方：`ThreadLaunchService.ts` 的 flatten 和首轮重命名、`ProviderEventIngestor.ts` 的子线程分支复查用前者（前两处会 `git branch -m` 或建分支；复查只对 fork 自己重命名过的分支有意义，不写 git）；`GitActionsControl.logic.ts` 的 `resolveLiveThreadBranchUpdate` 用后者（只决定 UI 是否同步线程分支名，不写 git）；`paletteSearch.ts` 的前缀剥离是显示用的正则，同时剥 `t3x`、`t3`、`t3code`；`threadOutboxDelivery.ts`（手机）只调用 `buildTemporaryWorktreeBranchName`，生成 `t3x/<hex>`。后果：导入的官方线程（`t3/<hex>`）不会被 fork 重命名；改动之前 fork 自己创建的 `t3/<hex>` 线程与它们无法区分，同样失去首轮重命名，宁可不动。`packages/contracts/src/settings.ts` 的 `branchNamePrefix` 默认值是同一个字符串（contracts 不能 import shared），`packages/shared/src/git.test.ts` 有用例让两者保持一致。

Tailscale 的默认端口走 `FORK.tailscaleServePort`：`packages/tailscale` 的 `DEFAULT_TAILSCALE_SERVE_PORT`、server 配置默认值、桌面设置默认值和设置页都引用它。发布的地址、配对链接、手机学到的路由都带 `:8443`（`buildTailscaleHttpsBaseUrl` 只在 443 时省略端口）。打开和关闭都只作用在这个端口。443 是官方的端口，fork 永远不对它发 `tailscale serve`：`forkTailscaleServePort`（`forkIdentity.ts`）把任何 443 换成 8443，生效点是桌面设置读取和写入（旧文件里的 443 读成 8443，`enabled` 保留）、`resolveServerConfig` 对 flag、环境变量和 bootstrap 的取值、`t3x pair --tailscale-serve-port` 和设置页的端口输入。桌面和 server 的关闭动作都用启动时配置的端口，所以不会有"关旧端口、开新端口"的步骤落到 443。设置页的端口输入直接拒绝 443（提示"443 已被官方 T3 Code 占用，T3 Extend 使用 8443"，官方应用名来自 `OFFICIAL_APP_NAME`），桌面 IPC 的 payload 也拒绝；只有没人可以问的地方才静默换成 8443 并记一条警告：读取已保存的设置，以及 CLI、环境变量和 bootstrap。

规则是绝对的：fork 只对自己配置的 serve 端口发 `tailscale serve`。上游的 managed policy 检查（`managedLimits.closeTailscaleServeTo`）原来会关掉所有转发到本服务本地端口的路由，现在多一个 `servePort` 参数，同时按端口和后端匹配，只关自己端口上的路由。别的端口上转发到本服务的路由（比如官方也配成了 3873，或旧 fork 在 443 留下的）一律不动，只记一条警告，写明端口和手动删除的命令，服务照常启动。含义：在禁止远程访问的 managed policy 下，旧 fork 在 443 留下的路由只会得到这条警告，不会被自动清掉，用户要按用户文档里的步骤自己删；主机名含糊（`localhost`、`[::]`）的路由仍然不会被自动关。

`vp run dev --share` 用 dev 的 web 端口（5733 加偏移，偏移从路径哈希起、上限约 3000）做 tailnet 端口，永远到不了 443，但范围里有 8443，会清掉并接管 fork 自己的 Tailscale HTTPS 路由，所以 `findFirstAvailableOffset` 跳过 `FORK.tailscaleServePort`。官方应用自己的 `--share` 可能占到 8443，那是官方的代码，改不了，列出。

没有改的：server 的 npm 包名和 `bin`（`t3`，改了会破坏 `--filter=t3`）、`t3code:*` localStorage key（userData 和 origin 已经不同）、版本号、CLI 帮助文本里的命令名。

## 共存保证

- 两个应用各用各的 userData、single-instance lock、T3 home、数据库、`secrets/`、worktree 目录、launchd label 和 systemd unit，互不干扰。
- fork 不会把官方的 `~/.t3` 当成自己的数据目录：`T3CODE_HOME`、`--base-dir`、bootstrap 或软链接解析出来等于它时，server（`resolveBaseDir`）和桌面版（`main.ts` 里在任何写入之前）都会报错退出，不创建任何文件；它下面的子目录（比如开发用的 worktree `.t3`）不受影响。开发种子数据仍然只读拷贝它。
- 桌面版写的是 `~/.t3extend/bin/t3x`，以及 PATH 上的 `t3x` 软链接，不会碰官方的 `~/.t3/bin/t3`、`/opt/homebrew/bin/t3`。
- fork 不会被官方更新覆盖：
  - 桌面构建只认显式设置的 `T3CODE_DESKTOP_UPDATE_REPOSITORY`，不会从 CI 的 `GITHUB_REPOSITORY` 推断 feed。`fork-release.yml` 把它设成 `SimpleEve/t3-extend`，所以它构建的每个桌面包（正式发布和 `-ci.N` 测试构建一样）都带着 `app-update.yml`，从本仓库的 Releases 自更新，不会去官方的 feed。测试构建查的也是真正的 latest release：草稿永远不会被提示，所以无害，还能用测试构建来试更新器；本机打包不设它就没有 feed（不生成 `app-update.yml`，菜单里也没有 "Check for Updates..."）。electron-builder 只在目标含 dmg 或 zip 时才写 `app-update.yml`，而 `fork-dist-mac.ts` 用 `dir` 目标，所以 macOS 的 `app-update.yml`、更新 zip 和 `latest-mac.yml` 都由这个脚本自己写（`scripts/lib/fork-mac-update-feed.ts`）。0.1.11-1.6 及更早的安装没有 feed，要手动装一次 0.1.11-1.7。
  - server 自更新（`t3x update`、客户端的 "Update everything"、`t3x service install`）只从 `SimpleEve/t3-extend` 查询和下载，不会换成官方 T3 Code。查询时取 Releases 列表里第一个非草稿、渠道相同的 release（`newestCliReleaseVersion`），所以发布的 tag 必须只增不减，规则见“打包与签名”。已经装好的运行时（带 sentinel 的版本目录）不会被删除或替换，`apps/server/src/cloud/pinnedRuntime.test.ts` 有对应用例。唯一的例外是目标版本目录里上次没下载完的残留：上游逻辑会在下载前先清掉它。
  - 移动端默认关闭 OTA，也不带官方 EAS 的 `projectId` 和 `owner`。
- 配对链接两种都认：fork 客户端能扫官方 server 的二维码（`t3code://pair`），fork 生成的链接是 `t3extend://pair`。
  mobile 把 `pair` 当作 `connections/new` 的别名（`apps/mobile/src/Stack.tsx`），系统相机扫码直接进添加环境页。上游只在 `__DEV__` 下用链接里的 `pairingUrl` 预填表单，release 包会打开空表单。
  Android 冷启动时，启动画面会挡住窗口绘制，这期间弹出的 formSheet 会停在屏幕外。所以冷启动链接的初始 state 先不带弹层，等启动画面隐藏后再 navigate 过去（`apps/mobile/src/fork/initialLinkSheet.ts`）。

例外和限制：

- SSH 远程主机默认装的是同版本的官方 server 归档（`OFFICIAL_CLI_RELEASE_DOWNLOAD_URL`），不影响本机的 fork。
- 没有官方 `.env`，所以 T3 Connect、guest link、passkey 默认都不可用；Android 的移动推送改走自建的 UnifiedPush，见下文。Clerk 回跳绑定的是官方 scheme，即使自己提供 `.env`，Connect 登录也可能失败。
- 非桌面版的 `t3x service install`（安装脚本、npm 等）下载的是 fork 自己的 release 归档，安装脚本装过的版本会被直接复用；可以用 `T3CODE_RELEASE_BASE_URL` 指向自己的发布镜像。macOS 打包版从 app 自带的 `t3x` 运行时不下载，见"后台运行（桌面版）"。
- Linux 打包身份（`executableName`、`StartupWMClass`、metainfo、`.desktop` 名称）还没有改，fork 的 deb / AppImage 会和官方包冲突。不要在同一台 Linux 机器上同时安装两者。
- `scripts/install.sh`、`scripts/install.ps1`、`scripts/npm-launcher/` 是官方的安装器，默认把官方 `t3` 装进 `~/.t3`。只有上游的 release workflow 会用到它们，而这个 workflow 限定在 `pingdotgg/t3code` 仓库运行。fork 不要用它们安装；没有桌面版的机器用 fork 自己的 `scripts/install-t3x.sh`（见“打包与签名”）。
- 远程 model manifest 仍然读上游的 `raw.githubusercontent.com/pingdotgg/t3code`，它是只读数据。

## 两个应用同机运行时仍然共用的东西

下面是读代码审计后的结论，没有在运行时抓取验证。能用 fork 身份分开的已经分开（见上表）；其余是有意共用，或者无害，或者要用户自己处理。

| 共用的资源                                                                                               | 风险                                                                                       | 处理                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tailscale 机器名                                                                                         | 两边在同一个名字下抢 HTTPS 端口，一边开关会改掉另一边的映射                                | 已分开：fork 用 8443。fork 旧版本在 443 留下的路由要用户自己清：`tailscale serve status` 确认 443 指向 fork 后，`tailscale serve --https=443 --set-path=/ off`                                                                                                                                                                    |
| `refs/t3code/pre-refresh`、`refs/t3/review-guide/<n>/base`                                               | 同一个 ref 被两边覆盖；review guide 的 `<n>` 是每个进程从 0 开始的计数，一定会撞           | 已分开：`refs/t3x/...`。旧 fork 版本写在官方名字下的 ref 留在原处：分不清是谁写的，而且无害（review guide 的 base ref 用完即删，pre-refresh 只是一个备份指针）                                                                                                                                                                    |
| 新 worktree 的临时分支 `t3/<hex>`、命名分支默认前缀 `t3/`                                                | 两边的分支混在一起，看不出是谁建的                                                         | 已分开：`t3x/`。没有任何地方按前缀批量删分支，所以不是数据风险，只影响辨认                                                                                                                                                                                                                                                        |
| 跨仓库 PR 的本地分支 `t3code/pr-<n>/…`                                                                   | 另一边建的同名分支和它的 worktree 会被当成自己的复用，在官方的 worktree 里 checkout 或快进 | 已分开：`t3x/pr-<n>/…`。已存在的旧分支不迁移                                                                                                                                                                                                                                                                                      |
| 隐藏的 checkpoint refs `refs/t3/orchestration-v2/checkpoints/<scope 哈希>/ordinal/<n>`                   | 无：scope id 来自各自数据库里分配的唯一 id，清理只删按名字列出的 ref，不扫前缀             | 列出，没改。改命名空间会让 fork 已有的 checkpoint 失联                                                                                                                                                                                                                                                                            |
| worktree 删除（`removeLinkedWorktree`）                                                                  | fork 删了官方 worktrees 目录下的东西                                                       | 已由 `t3/import-from-t3-code` 分支的 SharedWorktreePolicy 兜底（还没合进来）。其余路径：存储清理处理默认的 `worktreesDir`（在各自 home 下）以及设置里的 `worktreesDirectory` 和 `previousWorktreesDirectories`，设置如果指到官方的目录，同样靠 SharedWorktreePolicy 拦住；`git worktree prune` 只清磁盘上已不存在的登记，不按名字 |
| 仓库的 git config（`branch.<名>.remote`、`.rebase`，新增 remote）                                        | 两边都会写                                                                                 | 列出：语义相同；`ensureRemote` 按 URL 复用已有 remote                                                                                                                                                                                                                                                                             |
| `~/.claude`、`~/.codex` 里的会话、skills、sqlite、锁                                                     | 并发写同一批文件                                                                           | 列出，有意共用（两边也共用登录状态）：和同时开两个 Codex / Claude CLI 一样。server 没有写 `~/.claude.json`、`~/.claude/settings.json`、`~/.codex/config.toml`；T3 的 MCP 服务是每个会话的运行期参数（Codex 的 thread config、Claude 的 SDK `mcpServers`），不落盘                                                                 |
| `/tmp/t3code-<uid>/<state 哈希>.sock`（桌面应用控制 socket，Windows 是命名管道）                         | 目录共用                                                                                   | 列出，没改：目录 0700 属同一用户，socket 名是 state 目录的哈希，互不覆盖，也只 unlink 自己 bind 的 inode                                                                                                                                                                                                                          |
| server CLI 的编译缓存 `t3code/compile-cache`                                                             | 共用缓存目录                                                                               | 列出，没改：Node 按文件路径和内容校验，共用无害（桌面版的缓存目录已分开）                                                                                                                                                                                                                                                         |
| SSH 远程主机上的 `~/.t3/runtime`、`~/.t3/device/tools`                                                   | 和官方共用                                                                                 | 列出：runtime 装的就是官方 server 归档，工具按版本分目录；`~/.t3/device/hosts/<owner>` 的 owner 由 environment id、state 目录和 host id 哈希得出，两边不同                                                                                                                                                                        |
| Snap Shot 全局快捷键                                                                                     | 两边同时开且快捷键相同，后注册的失败                                                       | 列出：默认关；失败时会提示，要用户错开快捷键                                                                                                                                                                                                                                                                                      |
| macOS 权限（屏幕录制、辅助功能、相机、麦克风）和 Keychain 项                                             | 无冲突，但 fork 要重新授权                                                                 | 按 bundle id 和应用名分开，不用处理                                                                                                                                                                                                                                                                                               |
| 单实例锁、URL scheme、登录项、通知                                                                       | 无                                                                                         | 单实例锁跟 userData 走，scheme 和 AUMID 在 `FORK` 里，没有 login item，开机服务 label 已分开                                                                                                                                                                                                                                      |
| 其他端口                                                                                                 | 无                                                                                         | server 默认 3873，占用时顺延；OAuth 回调、预览浏览器、MCP 都是随机端口或挂在主端口下；`T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT` 是用户显式设置才开                                                                                                                                                                                   |
| Linux：`/etc/t3code/policy.json`、AppArmor profile 路径、`.desktop` 名称、systemd scope `t3code-*.scope` | 共用                                                                                       | 列出：Linux 打包本来就没有隔离；scope 只停自己记录的 unit                                                                                                                                                                                                                                                                         |

用户文档在 `docs/user/install.md` 的 "Running next to official T3 Code"，Tailscale 部分在 `docs/user/remote-access.md`。

## 开发流程

- 公开仓库 `SimpleEve/t3-extend` 是唯一的开发仓库：自己的改动、外部贡献者的 PR、上游同步都在这里完成。开源之前的完整历史在一个已归档的私有仓库里，只读，不再往里提交，也不往这里同步。
- 私人内容（任务清单、调研笔记、服务器和域名这类运维信息）放在单独的私有仓库，不进这个仓库。本地的 `.git/info/exclude` 忽略了 `tasks/`。
- `.vite-hooks/pre-push` 会检查要推送的新提交：提交说明或新增的行里，只要出现 `~/.config/t3extend/denylist` 里的任何一个字符串（每行一个，不区分大小写），就拒绝这次推送。这份清单只存在维护者的机器上；文件不存在时，钩子什么都不做。仓库在 GitHub 上还开了 secret scanning 和 push protection。
- 只在 linked worktree 里开发和测试。主 checkout 只用来合并和同步上游。
- shell 里先把 vp 放进 PATH，不要 source `~/.config/vite-plus/env`：

  ```bash
  export PATH="$HOME/.local/share/vite-plus/bin:$PATH:$HOME/.local/share/vite-plus/fallback-bin"
  ```

- 在 linked worktree 里跑 `vp run dev`，状态放在 worktree 自己的 `.t3`。第一次启动时会从 `~/.t3extend/userdata/statev2.sqlite` 只读拷贝种子数据；fork home 没有数据库时，改用官方的 `~/.t3/userdata/statev2.sqlite`。源库超过 500 MiB 时会跳过自动种子，这时在 dev server 停止的状态下跑 `vp run migrate-dev-db`，它用同样的来源规则生成一份裁剪过的拷贝。
- 在 agent 的终端里启动 Electron（打包产物或 `vp run dev:desktop`）之前，先 `unset ELECTRON_RUN_AS_NODE T3CODE_CLI_PATH`。这两个变量是宿主 T3 Code 注入的：前者会让 Electron 进入 Node REPL，后者指向官方 CLI。
- 主 checkout 不带参数时，dev 的 baseDir 是 `~/.t3extend`，也就是 fork 正在使用的数据。确实要在主 checkout 跑 dev，必须带 `--home-dir`，例如 `vp run dev --home-dir ~/.t3extend-dev`。
- 系统 Node 是 26.5.1，仓库锁定 26.12.1。开发和测试用系统 Node；打包时如果因为 Node 版本报错，用 `vp env exec --node 26.12.1 <命令>`。
- 提交前跑 `vp run fork:guard` 和 `vp run check:changed`。

## Android 开发环境

本机没有系统 JDK（`/usr/bin/java` 是占位程序），`ANDROID_HOME` 默认也没设。每个 shell 先执行：

```bash
export PATH="$HOME/.local/share/vite-plus/bin:$PATH:$HOME/.local/share/vite-plus/fallback-bin"
export ANDROID_HOME="$HOME/Library/Android/sdk" ANDROID_SDK_ROOT="$HOME/Library/Android/sdk"
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"   # JBR 21
export PATH="$ANDROID_HOME/platform-tools:$ANDROID_HOME/emulator:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
export T3_NATIVE_CLIENT_CACHE=off   # 不连 pinglabs 的共享缓存
```

- SDK 版本由 RN 0.88 的 `react-native/gradle/libs.versions.toml` 决定，Expo 的 `ExpoRootProjectPlugin` 原样采用：compileSdk 37、targetSdk 36、build-tools 37.0.0、NDK 27.1.12297006，原生库用 CMake 3.22.1。用 `sdkmanager --install "platforms;android-37.0" "platforms;android-36" "build-tools;37.0.0" "ndk;27.1.12297006" "cmake;3.22.1"` 补齐。升级 RN 后以 `libs.versions.toml` 为准。
- 测试用专用 AVD `t3extend-test`（pixel_8，`system-images;android-36;google_apis_playstore;arm64-v8a`，数据分区 6G、内存 4G、host GPU）。`Medium_Phone` 是用户自己的 AVD，不要用。启动：`emulator -avd t3extend-test -no-snapshot-save -no-boot-anim -no-window`，放在 tmux 这类持久 PTY 里，`nohup ... &` 会被 agent 执行器回收。关闭用 `adb -s emulator-5554 emu kill`。
- `vp run mobile:install android emulator-5554` 的产物在 `~/.cache/t3code/native-clients/artifacts/android/development-arm64-v8a/<fingerprint>/app-debug.apk`，构建日志在同目录的 `logs/`。这个缓存目录和官方 T3 Code 的 checkout 共用，靠 fingerprint 区分，不冲突。
- 冷启动 dev client 用 `am start -n com.simpleeve.t3extend.dev/.MainActivity`。`monkey -p ...` 在这个镜像上不发 intent，直接以 -5 退出。
- 本机 8081 被 Docker Desktop 占用（只监听 127.0.0.1），Metro 改端口：`vp run dev:client --port 8091`，再 `adb reverse tcp:8091 tcp:8091`，打开 `t3extend-dev://expo-development-client/?url=http%3A%2F%2F127.0.0.1%3A8091`。
- 网速：dl.google.com 约 1 MB/s，Maven Central 只有约 150 KB/s，services.gradle.org 约 700 KB/s。第一次构建（全新 Gradle 缓存）总共约 50 分钟：配置阶段下载依赖 27 分钟，编译 22 分钟；NDK 下载约 25 分钟。之后的增量构建十几秒。阿里云 Maven（`maven.aliyun.com/repository/{google,central,gradle-plugin}`）和腾讯云 Gradle 分发（`mirrors.cloud.tencent.com/gradle/`）实测 15 到 20 MB/s。要用镜像时，用独立的 `GRADLE_USER_HOME`（例如 `~/.cache/t3extend-gradle`），把改写仓库地址的 init 脚本放在它的 `init.d` 下，不要改 `~/.gradle`。

### 没有 EAS projectId 时 expo-observe 起不来（已修复）

`expo-observe` 的 Android 原生模块在启动时检查 APK 内嵌配置里的 `extra.eas.projectId`，值为空就抛错，dev client 加载 bundle 时会红屏：`Project ID is required to send observability metrics`。fork 默认不带官方 EAS 项目，所以 `apps/mobile/app.config.ts` 在没有设置 `T3EXTEND_EAS_PROJECT_ID` 时填入占位值 `00000000-0000-4000-8000-000000000000`，`updates` 不受影响。这个占位值不对应任何项目。没有 relay 时，observe 的上报地址是 `https://observe.invalid`，`observe.ts` 也会关闭发送，所以不会向任何地方上报。

`extra` 不参与 native fingerprint，改它不会让 `mobile:install` 自动重编。以后改了 `extra` 里会写进 APK 的值，要把 `~/.cache/t3code/native-clients/artifacts/android/development-arm64-v8a/<fingerprint>`（连同同名 `.json`）和 `~/.cache/t3code/native-clients/android/` 下的设备记录移走，再跑一次 `mobile:install`。

## 多语言

底层是上游的 GT（`gt-react`、`gt-react-native`、桌面主进程的 `gt-i18n`）。上游文件保持上游的 `useGT()`/`msg()`/`<T>` 写法和提交在仓库里的翻译目录（`apps/{web,mobile,desktop}/src/i18n/translations/*.json`，含 zh 和其余 8 种语言，离线可用）。语言设置就是上游的 `ClientSettings.language`（mobile 偏好里的 `language`）；fork 只把默认值改成 `system`（跟随系统，fork 一贯如此，上游默认 `en`）。

fork 自己的 `t()`（`packages/client-runtime/src/i18n/`，web 和 mobile 的 hook 是 `hooks/useT.ts`）只给 fork 独有的功能和 fork 改过的文案用，目录在 `catalogs/zh-Hans/`，只有简体中文。它不再有自己的语言设置：GT 切换语言时（web 和 mobile 的 `i18n/messages.ts` 的 `setActiveLocale`、桌面主进程的 `applyLanguage`）顺带调 `setUiLocale(uiLocaleForLanguage(locale))`，`zh` 对应 fork 的 `zh-Hans`，其他语言下 fork 文案显示英文。web 在加载 GT 目录时一起加载 fork 目录（`i18n/runtime.ts`），首屏不闪英文。

写新文案：在上游文件里优先用 GT 的写法（`gt("…")`、`msg()` + `m()`、`<T>`），这样各语言都有机会翻译；fork 独有的组件里用 `t()`，并在 `catalogs/zh-Hans/` 补中文。不要再把上游文件里的 GT 调用改成 `t()`。上游的组件（`SettingsSection` 的 `title`、`SettingsRow` 等）不会替你翻译传进来的字符串，fork 文件里要写 `title={t("…")}`，不能写 `title="…"`；fork 在上游文件里加的条目（如设置搜索的标题）用 `msg()`，脚本会从 fork 目录里补上中文。lint 的 `t3code/no-untranslated-copy` 会抓到漏写的地方。

**旧的语言设置迁移**：fork 以前存的是 `uiLanguage`（`system`/`en`/`zh-Hans`）。读取设置时一次性改写成 `language`（`zh-Hans` → `zh`，已有 `language` 时以它为准）：web 在 `clientPersistenceStorage.ts`，桌面在 `DesktopClientSettings.ts`，共用 `packages/contracts/src/forkUiLanguage.ts`；mobile 在 `mobile-preferences.ts` 的解析里。各有一条测试。

**语言入口**：web 和 mobile 都只留上游的位置（设置 → 通用里的语言行），fork 原来的「外观 → 语言」已删。

**品牌**：上游 GT 文案里指这个 app 的 "T3 Code" 在源码里直接写成 "T3 Extend"（指本机 CLI 的 `t3` 写成 `t3x`），`fork:guard` 守着；指官方 app 或给模型看的文字按 `ALLOWED_BRAND` 放行。改源码会改变 GT 的 key（key 是原文的哈希），所以每次改完或同步上游后都要跑：

```bash
vp run fork:i18n-sync   # 重新生成 en.json，把各语言旧 key 的译文搬到改过品牌的新 key，并套用中文覆盖层
node scripts/i18n-check.ts       # 上游的 CI 检查，目录与源码一致
```

同步上游时，`apps/*/src/i18n/translations/*.json` 的冲突一律取上游，再跑 `vp run fork:i18n-sync`；加 `-- --check` 只检查不写。脚本把找不到中文的 key 列出来（多数是单位、占位符这类本来就是英文的）。

**中文覆盖层**：`packages/client-runtime/src/i18n/gt-zh-overrides.json`，fork 的术语表（`GLOSSARY.md`）在 GT 的 zh 上胜出。`terms` 是整个 zh.json 里的词替换（会话→对话、智能体→Agent、提供方→provider、工作树→worktree、侧聊→侧边对话、暂缓→稍后处理、收尾→标为已处理、审查导览→审查导读、线路→路由、用量限制→用量上限；替换成拉丁词时自动补空格）；`messages` 是整句覆盖，只剩两类：settle、snooze 的句子（术语落在动词上，词替换读不通），和上游 zh 本身没有中文的句子；`keepTermFor` 指定某个词在哪些英文原文里不替换（含 session 的句子保留“会话”，其他术语照换）。除上面这些术语，译文都跟上游；fork 的 `catalogs/zh-Hans/` 里和上游同一句英文的译文也照上游的写，同一句英文在 fork 文件和上游文件里显示一样。上游 zh 里 GT 没翻译的 key，优先用 fork 目录里同一句英文的译文。覆盖层是 fork 自己的文件，同步不会冲掉；要改译法就改这个文件再跑脚本，不要手改 zh.json。

**检查**：

- `vp run i18n:report`：只看 fork 的文案，即上游没有的文件和 fork 在上游文件里新增的行（需要本地有 `upstream/main`；`I18N_REPORT_ALL=1` 连上游一起扫）。`<T>` 和 `gt()`/`msg()` 算已翻译。missing、stale 只针对 fork 的 `t()` 目录。
- `scripts/fork-zh-coverage.test.ts`：底栏端口、设备密钥、UnifiedPush、产出、上下文圆环、后台运行、主题工作室、侧栏按项目这几块代码里的每个 `t()`/`gt()`/`msg()`/`<T>`，在中文下必须有中文。新增 fork 功能时把路径加进 `FEATURES`。
- `packages/client-runtime/src/i18n/i18n.test.ts`：fork 目录的占位符、破折号、跨文件一致。

以前的 AST 扫描（找合并时丢掉的 `t()`）退役了：上游文件不再用 `t()`，对应的保障是 `i18n-check` 和上面的覆盖检查。mobile 的 `fork/appBarI18n.ts` 包装层也删了，AppBar 和 SheetHeader 的文案由上游的 GT 翻译。

中文排版层（`apps/web/src/fork/zhTypography.css`，移动端对应 `apps/mobile/src/fork/zhTypography.ts`）的规则：`text-sm` 及更大的字号下调一档、字重变轻、取消负字距；12px 及以下的字号（`text-xs`、`text-2xs`、`text-3xs`、`text-[11px]` 等）保持上游原样，固定和截断的盒子因此不变形。例外只有按位置单独抬高的几处：诊断页里实际渲染汉字的元素（`data-t3x-han-text`，10px 抬到 11px；拉丁和数字单元格带 `data-t3x-latin` 或不带属性，保持 10px）、设置里带该属性的小号 Badge（源码管理状态、自建连接状态），以及供应商徽章里的汉字首字母（`fork/hanBadgeInitial.ts`：只显示第一个字素，10px，徽章尺寸不变）。英文不匹配 `:lang(zh)`，渲染与上游逐像素一致。`T3 Extend` 字标用 `data-t3-wordmark` 恢复英文的字号、字重和字距，这个属性只能放在只包着 T3 字形和后缀的节点上。

还是英文的：上游 GT 自己没翻的英文（`I18N_REPORT_ALL=1` 下 37 处 JSX、8 处属性，如诊断页的 process/observed）；fork 文案在中文以外的语言下；服务器和模型给出的文案；桌面预览标注浮层（`PickPreload.ts`）。

## 后台运行（桌面版）

macOS 打包版的设置 > 维护 > "后台运行" 有一个开关"在后台保持运行"：打开就是 `t3x service install`，关闭就是 `t3x service uninstall`，退出 app（Cmd+Q）后服务继续跑，手机和推送不断。代码：`apps/server/src/fork/appRuntime.ts`（识别）、`apps/desktop/src/fork/backgroundService/`（开关、IPC、启动和退出的接力）、`apps/web/src/fork/BackgroundServiceSettings.tsx`（设置行）、`packages/shared/src/backgroundService.ts`（桥接类型）。

**服务直接用 app 自带的运行时，不下载。** 识别（`detectAppRuntime`，只认 macOS）要三条同时成立：`ELECTRON_RUN_AS_NODE=1`；`argv[1]` 是 `<X>.app/Contents/Resources/app.asar/apps/server/dist/bin.mjs`；`execPath` 在同一个 `<X>.app/Contents/MacOS/` 下。这正是 `DesktopCliShim` 写的 `t3x` 启动脚本和桌面开关调用 CLI 的方式，npm、pinned runtime、dev 都不满足，行为不变。命中时 `BootService.make`：

- plist 的 ProgramArguments 是 `[<app 可执行文件>, <asar 里的 bin.mjs>, "__service-launcher"]`（原来是 `[<T3 home>/runtime/versions/<版本>/t3, "__service-launcher">]`），EnvironmentVariables 多了 `T3X_APP_SERVICE=1`（身份标记）、`ELECTRON_RUN_AS_NODE=1`、`T3X_FRPC_PATH`（`Contents/Resources/bin/frpc`，取 shim 导出的值）和 `T3X_APP_RUNTIME_VERSION`（装它的 app 版本）；PATH 里不再放 app 的 `Contents/MacOS`。`BootServicePlan.environment` 只有 plist 渲染它，systemd 和计划任务不渲染，因为 app 模式只在 macOS 出现。
- `install` 跳过 `ensurePinnedRuntimeInstalled`（不访问 GitHub、不建 `runtime/versions`），其余照旧：先停、写 `service-state.json` 和 plist、`launchctl enable` 加 `bootstrap`、失败回滚。安装前先对 `.app`、可执行文件和 `app.asar` 做 realpath（`appRuntimeLocationProblem`），再判断：真实路径在磁盘映像（`/Volumes/`）或 App Translocation 下（`transient`），或可执行文件、asar 是指向别处的链接（`mismatch`），都拒绝（`BootServiceAppLocationError`）。所以 `/Applications/Foo.app` 本身是指向这些位置的符号链接也绕不过去；路径不存在（realpath 失败）时按原文判断。
- launcher（`serviceLauncher.ts`，三处 `// fork:`）：自己也是这个 app 进程，所以子进程用 `<execPath> <argv[1]> serve`，环境从 plist 继承。`runtimeExists` 在 app 模式只认"版本等于 `T3X_APP_RUNTIME_VERSION` 且可执行文件在"，所以旧 state 或被换掉的 app 会得到原来的 "runtime is missing or incomplete" 而不是启动错的版本。
- 更新交接和 prune：app 模式不会产生 `versions/` 里的目录，prune 只处理那里，碰不到 app。plist 里的 program 不匹配 `repointServiceUnit` 的正则，原样保留。app 升级后 state 的 `activeVersion` 与 app 版本不一致，`status` 变成"需要修复"，设置里的"修复"重新 install 即可；`t3x update` 对这种服务会去 Releases 下载对应版本的归档（app 版本和 CLI 归档版本相同，同一个 tag 发布）。没有做自动修复。
- `status`：新增 `app-runtime-missing`（app 被移动或删除；修复办法是放回原处，或从新位置打开 app 后把开关关掉再打开），macOS 上多一个 `running`（`launchctl print` 里 `state = running`）。`t3x service status --json` 输出整份状态，桌面开关读它。

**桌面 app 和服务的关系：交替持有，不连接服务。** 同一个 `~/.t3extend` 只能有一个 server（`server-owner.sqlite` 独占锁）。上游遇到服务占着 home 时只弹窗然后退出，没有"连到已有服务"的机制；要做就得让 app 去认证一个没有它那份随机 bootstrap secret 的服务，而且 app 自己的后端还通过私有管道带着 in-app 浏览器、遥测、原生选择器这些只属于桌面的通道，launchd 起的 server 没有这根管道，连过去会悄悄丢功能。所以：启动时（`startLocalBackend` 里，检查 home 归属之前）`pauseForApp` 对**自己的**服务执行 `launchctl bootout --wait` 让它退出并释放锁，再走原有流程起 app 自己的后端。bootout 之后再 `launchctl print` 确认确实卸载了：没卸掉（`failed`）就不等 ownership 的宽限（`BACKEND_QUIT_STOP_TIMEOUT` 7 秒加 3 秒，共约 10 秒），直接弹出"后台服务没能停下"并退出，提示 `t3x service uninstall`，不会起第二个后端；退出时（`scopedProgram` 的 finalizer 里，所有后端停掉之后、`markComplete` 之前）`resumeAfterApp`：服务还在 launchd 里就 `kickstart -k`，不在就 `enable` 加 `bootstrap`，然后 `launchctl print` 确认已加载，没加载就再试一次（只一次）；整个交接有 8 秒总期限（`RESUME_DEADLINE`，单条 `launchctl` 最多 3 秒），超时就放弃，不拖住 Cmd+Q。试了两次都不行或超时，把时间和原因写进 `<T3 home>/runtime/background-service-resume-failed.json`（写到同目录临时文件、`chmod 600` 再 rename 过去，所以不会跟着符号链接写出去，也不会沿用已有文件的宽松权限），下次启动 `getState` 读到它：设置行显示"上次退出时后台服务没能启动：原因"并给"重试"（就是重新 install，成功后清掉记录），`BackgroundServiceReporter` 同时弹一条错误 toast；卸载服务或服务本来就没装时也清掉记录。服务的 server 立刻拿到锁，不必等 launcher 每 30 秒一次的轮询。开关打开时 install 之后立刻 `pauseForApp`，因为此刻 app 正占着 home。app 崩溃或被强杀不会执行退出那一步，服务停到下一次 app 退出或重新登录（plist 有 RunAtLoad），用户文档里写了。"自己的"服务由 `ownedService` 判定：交给 macOS 的 `/usr/bin/plutil -convert json -o -` 解析 plist（选它而不是自己写解析或加依赖：系统自带、认所有 plist 编码、拒绝损坏文件，零新增依赖），再严格检查类型：ProgramArguments 必须是三个字符串且最后一个是 `__service-launcher`，EnvironmentVariables 里 `T3X_APP_SERVICE` 是字符串 `"1"`、`T3CODE_HOME` 是非空字符串。plutil 会把重复的键悄悄合并、也看不见注释，所以读取的三个键还要在原文里各数一遍，必须恰好一次，多了（含注释里的）一律当"不是自己的"。解析失败、类型不对、键重复同样如此。通过后比较可执行文件、entry、`T3CODE_HOME` 是否等于当前 app 和当前 home：先对整条路径 realpath（失败再退回只解析 `.app`），再统一去掉重复和结尾斜杠、`.` 和 `..` 段并忽略大小写（macOS 的卷默认大小写不敏感；代价是大小写敏感卷上只差大小写的两个 app 会被当成一个，不值得为此放宽所有人的匹配）。用同一个 app 给别的 `--base-dir` 装的服务、另一份 app 拷贝装的服务、手写的只带 `ELECTRON_RUN_AS_NODE` 的 npm plist，启动和退出时都不碰；`DesktopBackgroundService.test.ts` 逐个有用例。

只在 macOS 打包版显示开关（`available` = darwin 且 `isPackaged`；其他情况 IPC 返回 `unavailable`，设置行不渲染）。dev 版、Windows、Linux 保持上游行为：开机服务仍要下载运行时，桌面遇到被占用的 home 仍是弹窗加退出。没有 Linux 和 Windows 的 app 模式。

没有改的：launcher 的 `__service-launcher` 命令、service state 的格式和协议号、`t3x service` 的其余子命令。测试都用假的 ProcessRunner 和临时目录（`appService.test.ts`、`DesktopBackgroundService.test.ts`），不碰真实 launchd；真机验证的命令清单在交付报告里。

## 退出有上限（桌面版）

Cmd+Q、SIGTERM 触发的退出，在 `DesktopLifecycle.ts` 里最多等 25 秒（`SHUTDOWN_DEADLINE`）：正常的退出是后端停止（SIGTERM、5 秒宽限、SIGKILL）加后台服务交接（8 秒），到不了这个数。到期就记一条 error（`step` 写明卡在刷窗口位置、关窗口还是等 `shutdown`），然后 `app.exit(0)`，不再走 Electron 自己的 will-quit。以前只有用户再按一次 Cmd+Q（10 秒后）才会强退，`osascript` 的 quit 只发一次，所以一直挂着。

强退不会留孤儿：后端看到父进程没了，会自己停掉并带走 headless 浏览器（真机实测：打包版里开一个 headless 标签页，SIGKILL 主进程，server 和 chrome-headless-shell 都在 2 秒内退出）。刷窗口位置另有 3 秒上限，保证 `shutdown.request` 总能发出去。

2026-11-21 Mac mini 上两次退出卡死（主进程 S、server Ss，server 一直没收到 SIGTERM）的具体卡点没有查出：当时的 desktop trace 没有落盘，span 只在结束时才写，卡住的 span 看不到。在打包版里人为让一个启动期的 finalizer 永不结束，能复现同样的现象（base 上 90 秒不退，修复后 25 秒退）。真正的卡点要等下次出现时看上面那条 error 的 `step`。

## Antigravity 沿用本机 agy CLI 的登录

官方 T3 Code 让每个 Antigravity 实例用自己的 gemini home（`<T3 home>/userdata/providers/antigravity/<sha256(实例 id)>/`），并给 agy 设 `AGY_ACP_FORCE_FILE_STORAGE=1`，登录态只写进 profile 里的 `antigravity-acp/acp_token.json`。所以 T3 里的 agy 看不到用户在终端里 `agy` 的登录，要在 T3 里再登录一次。上游这样做的理由原来写在 `docs/internals/providers.md`（11-24 同步时上游把它精简成 `03_providers.md` 并删掉了这一段，见 git 历史）：agy 默认把登录放在系统 keyring（macOS 钥匙串，条目与 gemini home 无关），多个实例会共用同一条，隔离多账号只能强制文件存储。

实测（临时 profile、真实 `agy acp`，只做 `initialize` 和 `authenticate`，没发对话）：不设 `AGY_ACP_FORCE_FILE_STORAGE` 时，agy 日志是 `ChainedAuth: authenticated via keyring`，直接用 CLI 的登录，不生成 `acp_token.json`，不调浏览器；再发 `session/new` 也能取到模型列表。`~/.gemini` 下的文件 mtime 前后一致，钥匙串条目的修改时间也没变。`~/.gemini/oauth_creds.json` 是旧 gemini CLI 的凭据，和 agy 的登录无关，没用它。

做法：只共享登录，不共享 gemini home。设置里加了 `loginSource`（设置 > provider > Antigravity > Login source），三个值：

- `auto`（默认）：**默认实例**（实例 id 就是 `antigravity`）在 profile 里从没独立登录过时用 CLI 登录；额外实例一律独立登录。“独立登录过”看三样东西，任何一样在就算：profile 自己的 token（旧运行时写 `antigravity-acp/acp_token.json`，1.5 CLI 写 `antigravity-acp/antigravity-oauth-token`，见 `antigravityProfileTokenExists`），或 `antigravity-acp/login-source` 标记（内容只有 `profile`，不含凭据）。标记在驱动创建时看到 token、或在 T3 里独立登录成功时写下（`markAntigravityProfileLogin`），之后 token 被删（退出登录）也不消失，所以重启或重建驱动不会悄悄换成钥匙串里的另一个账号。读不出来（权限、IO 错误）按“用过”处理。想换回 CLI 登录就显式选 `cli`。

  **旧版本已经导入的实例**：旧导入没有把 provider 实例记进 `fork_t3code_import_map`，唯一的痕迹是 `fork_t3code_import_runs.summary_json` 里 `attention` 的 `provider-credential-imported` 通知，`subject` 是导入的实例 id（用 `, ` 连接）。选运行时一次性迁移：`T3CodeImport` 构造时（服务启动，`ensureImportTables` 之后）读出所有这样的 id（`importedProviderInstanceIds`），对设置里 driver 是 `antigravity` 且还没有 `loginSource` 的写成 `profile`，之后因为已有 `loginSource` 不会重复动。没有这条记录的实例（Extend 里自己建的，包括这台机器的默认实例）不动，仍走 CLI。局限：记录只在导入完整结束时写入，中途中断的导入没有；已经在 Extend 里被删掉又用同一个 id 自建的实例会被误固定一次（改成 `cli` 即可）。

- `cli`：强制用 CLI 登录，不管实例和 profile。
- `profile`：独立登录，也就是上游原来的行为，多账号用它。

只对 Google 账号和 Gemini Enterprise 两种浏览器登录生效；API key 和 Agent Platform 不变。判定函数是 `resolveAntigravityLoginSource`（`antigravityAuthSupport.ts`），驱动创建时算一次。官方导入只复制 provider 实例配置，不复制 `userdata/providers` 下的 profile，所以导入进来的 Antigravity 实例没有 token；`pinImportedAntigravityLogin`（`T3CodeImportRewrite.ts`）在导入时把它的 `loginSource` 写成 `profile`（实例里已有的选择保留），`auto` 不会把它当成默认实例的 CLI 登录。

用 CLI 登录时：

- 只是 `buildAntigravityAcpSpawnInput` 不再设 `AGY_ACP_FORCE_FILE_STORAGE`（`AntigravityProfile.sharedLogin`）。`--gemini-dir` 和 `GEMINI_HOME` 仍指向 T3 自己的 profile，会话、hooks、MCP、skills 链接、临时目录清理（`removeAntigravitySessionFiles`、`retireAntigravityRuntimeTempDirs`）都只在 profile 里动，碰不到 `~/.gemini`。
- 健康检查读不到 token 文件，原来的“有没有 token”判定不能用。改成 `silentSignIn`：健康检查发现不是已登录时，起一个一次性的 agy 做 `initialize` + `authenticate`（不建会话，不触发 MCP、hooks，也不拉浏览器；没登录时在 stdout 变换里就报“需要登录”），成功记为已登录。这是对 `docs/internals/03_providers.md` 里“健康检查必须保持被动”原则的最小例外：只做认证。
  - **已登录有 TTL**（`SHARED_SIGN_IN_TTL_MS`，30 分钟）：会话成功或静默检查成功时记下时间，超过 TTL 的下一次健康检查先降为 `unknown`，再静默检查一次。CLI 里 `agy logout` 后，T3 最多 30 分钟内发现。取舍：每个共享实例每半小时多起一次很短的 agy；再短没有收益（会话和手动刷新会更快确认），更长会让退出登录的提示拖太久。
  - **没登录时**同一实例最多 5 分钟检查一次（`SHARED_SIGN_IN_RECHECK_MS`）。检查结论是 `unknown`（超时或出错）时，显式写成“未检查”（`onAuthUnknown`，不保留之前的“未登录”），并且只退避 1 分钟（`SHARED_SIGN_IN_RETRY_MS`）再试，不套 5 分钟。设置里手动「刷新 provider 状态」走 `refreshModels`，不受这个间隔限制，并且会加载模型。自动检查不加载模型，重启后要等一次会话或手动刷新，和独立登录模式一致。
  - **预算 90 秒**（`SHARED_LOGIN_CHECK_TIMEOUT_MS`，与模型刷新相同；Windows 解压 agy 约要一分钟，见 `AntigravityAuth.ts`）。超时后离开作用域，子进程随之关闭；超时的结论是 `unknown`（账号显示“未检查”），不当作已退出。
  - **环境级 single-flight**（`antigravitySharedLoginCheck.ts`）：同一个 agy 可执行文件上的多个共享实例同时启动，只起一次 agy，其余等同一个答案；最近 60 秒内的明确答案（已登录或需要登录）直接复用，`unknown` 不复用。过期的答案和 `unknown` 都从表里删掉，表不会随可执行文件路径增长。放在模块作用域是因为驱动随设置重建，而可执行文件和钥匙串不变；测试里每个用例用自己的可执行文件路径当 key。
- 登出被禁用（`logoutBlockedMessage`）：原生 `logout` 会清掉 keyring 里的登录，终端里的 `agy` 也会跟着退出。T3 里点退出登录、或在对话里发 `/logout`，都会得到说明而不是执行。
- 用量限额（Usage > Limits）读不到，并且共享登录时**不读** profile 里的 token 文件（那可能是别的账号留下的）：用量探测靠 token 文件里的 refresh token 调 Google 配额接口，而 CLI 登录在 keyring 里，T3 不读（`security` 读别的应用的钥匙串条目要用户授权，后台服务里弹不出来）。所以这时限额显示"不可用"和原因。需要限额就把 Login source 改成独立登录。
- 在 T3 里点 Sign in：CLI 已登录就瞬间完成，没有浏览器；CLI 没登录时走浏览器登录，结果写进 keyring，终端的 `agy` 也会登录上（两边是同一条登录）。

没验证的：Linux 或没有 keyring 的主机上，agy 在不强制文件存储时放哪里；Windows 凭据管理器；keyring 里的登录过期且 refresh token 失效时（只看到过 keyring 里的 token 过期后自动刷新成功）；官方 T3 Code 和 Extend 同机同时运行时，两边的 agy 同时刷新同一条 keyring 登录。

## Antigravity 账号池、自动切换和网络代理

边界：不做按账号的出口 IP，不做指纹、设备 id、随机延迟之类的规避；账号只通过 agy 原生 `--login` 加入，不从别处导入或软链 token。代理只有实例级的一个。

**读取额度默认关闭**（`readUsageLimits`，实例设置“Read quota from Google / 读取 Google 额度”，默认 false）：上游 #43026（v0.1.13，`96423cb5e2`）删掉了 Antigravity 的额度读取，理由是 Google 说调用 cloudcode-pa 内部接口可能让账号被标记。fork 保留这部分代码（`antigravityUsageLimits.ts`、`antigravityBackgroundProbe.ts`、`@napi-rs/keyring` 依赖，`shared/usageLimits.ts` 里 Antigravity 的 `exhaustedUsageWindow` 分支和窗口排序），但每个实例要自己打开，开关的说明写明了风险，文档（`docs/user/usage.md`、`providers-antigravity.md`）同步。关闭时：`AntigravityDriver` 不建 `makeAntigravityUsageProbe`，也不建 `accountProber`、不启动 `startAntigravityBackgroundProbe`，所以本实例读取、后台轮流探测其他账号、手动 `refreshAccounts` 都不存在，任何情况下不发 cloudcode-pa 或额度相关的 token 刷新、userinfo 请求；`antigravityServerAccounts` 不再列出账号的 `usageLimits`、`usageProbeFailure` 和 `refreshable`（即使 `usage.json` 里留着以前打开时的读数，也不显示），`mergeAntigravityAccounts` 在实例没有实时读数且账号都没有这三样时不生成 Limits 行，所以界面上和上游一样表现为没有额度。账号池、手动切号和 `accountRotation` 不依赖读数：`markExhausted` 只看一轮报出的 QUOTA_EXHAUSTED，按池里保存的顺序挑下一个没标记用完的账号，关闭时照常工作（有测试）。`backgroundAccountCheck` 只在读取打开时有意义，说明文字里已写。CLIProxyAPI hub 读 Antigravity 账号额度的路径（`usage/cliproxyApi.ts`）跟上游一起删了，不属于这个开关；fork 没有依赖它的功能。同步上游时，如果上游继续改 `antigravityUsageLimits.ts` 相关的共享代码，要先判断是不是影响开关打开时的行为。

**网络代理**（`networkProxy`，`antigravityNetworkProxy.ts`）：agy 进程环境里设 `HTTPS_PROXY`/`HTTP_PROXY`/`ALL_PROXY` 和小写一套，`NO_PROXY` 永远含 `localhost,127.0.0.1,::1`（T3 的 MCP over HTTP 走回环），并保留机器原来的 `NO_PROXY`；设置了代理就覆盖机器全局的代理变量（不论大小写），为空时环境与以前逐字节一致。所有起 agy 的路径都经过 `antigravityEnvironment`，所以会话、静默检查、`--login`、模型刷新、文本生成都带上了。T3 自己发给 Google 的额度请求（token 刷新、userinfo、quota）走 undici 的 `ProxyAgent`，用同一份 npm undici 的 `fetch`（`makeAntigravityProxyFetch`，经 `FetchHttpClient.Fetch` 提供）发出，不能交给运行时自带的全局 fetch：Electron 44 内置 undici 7，会拒绝 8.x 的 dispatcher（`invalid onRequestStart method`），开发用的 Node 26 内置 8.x 所以看不出来；SOCKS5 用 undici 8 自带的 `Socks5ProxyAgent`（`socks5h` 改写成 `socks5`，undici 把域名交给代理解析），它在 undici 里仍是 experimental，第一次用会在 stderr 打一条 ExperimentalWarning。建不出代理时（地址不合法、构造失败）额度探测返回"不可用"和原因，不会直连。`socks4` 不支持。

**账号池**（`antigravityAccountPool.ts`）：只对 Google 账号 + 独立登录（`loginSource` 解析为 `profile`）生效。agy 只读写 `antigravity-acp/antigravity-oauth-token`；池在 `antigravity-acp/accounts/<id>/antigravity-oauth-token` 存每个账号一份，`accounts/state.json` 存顺序、当前账号和每个账号的 `exhaustedUntil`（毫秒时间戳，不含凭据）。`<id>` 是 `sha256("email\0" + 小写邮箱)` 的前 16 位十六进制（没有邮箱时用 refresh token）。写文件一律临时文件加 rename，权限 0600；当前文件是软链时按内容拷贝，之后就是普通文件。`list` 只读不写，实例原有的单个登录在第一次添加、切换、移除或额度用完时才落成第一个槽位；`state.json` 损坏按无池处理，下次改动重写（旧槽位文件不会被清）。

- 添加账号 = 现有的登录流程：`codeLogin` 先 `beginAdd`（把当前账号存回槽位并移走当前文件，否则 agy 看到有效登录会跳过浏览器），登录结束的 finalizer 跑 `settleAdd`（有新 token 就登记成当前账号，同邮箱更新槽位；没有就把原账号装回来）。启动 agy 前 `ensureAvailable` 总会修复"登录中途被杀"留下的缺文件状态。
- 切换账号、移除账号都先停掉实例所有会话和 agy 进程（`AntigravityAuth.changeAccounts`，和登录、退出登录一样走 `stopSessions`），否则运行中的 agy 会把自己的账号写回覆盖。新 RPC `provider.auth.selectMethod`（权限同 provider 登录），移除复用已有的 `provider.auth.removeMethod`。移除当前账号时先换到有额度的下一个，再换到任何剩下的，没有才是未登录。退出登录清空整个池。
- 账号列表放进 provider 快照的 `auth.accounts`（`ServerProviderAccount`），由 `AntigravityProvider` 的 `stamp()` 在每次构建快照时读，不单独存状态。

**额度用完自动切换**（`accountRotation`，默认关）：一轮以 `usage_limit` 结束（`AntigravityTurnOutcome` 识别 QUOTA_EXHAUSTED 和 429 RESOURCE_EXHAUSTED）时，同一轮内完成：`markExhausted` 记下当前账号的重置时间（失败信息没有重置时间按 5 小时）并算出下一个有额度的账号，但**不换文件**；适配器把 agy 换掉（关旧进程组，和 inactivity watchdog 的收尾一样）、起新进程，这时 `prepareSpawn` 里的 `ensureAvailable({ rotate: true })` 才把下一个账号的 token 放进当前文件，所以旧进程退出时刷新的 token 先被存回自己的槽位，不会覆盖新账号；然后 `session/load` 同一个原生会话，原样重发这一轮的 prompt。线程里出一条 retry 条目（标题"Provider recovered"，失败信息是"x•••@域名 额度用完（重置时间），已切到 y•••@域名 并继续本轮"，邮箱部分遮掩）。全部用完照常失败，信息里写最早的重置时间；单账号时不介入；一轮最多切 8 次。重发会让 agy 的原生历史里多一条同样的用户消息（失败那次已经记了一条）。

适配器侧只有一个可选 flavor 钩子 `recoverFromUsageLimit`（`packages/provider-acp/src/server/adapter.ts` 里 `followPrompt` 的 `hiddenFailure` 分支和新函数 `resendAfterAccountSwitch`，都带 `// fork:`），只有 Antigravity 设置，其他 provider 行为不变。重发沿用 steer 重发提示的写法（重置 `foregroundIdle`/`promptWireSettled`、新 watchdog、新的 `followPrompt`），激活会话时临时把 `activeTurn` 置空，和 `startTurn` 一样，加载历史的回放只填快照，不进当前轮。有后台命令或子 agent 还在跑时不切（旧进程一关它们就没了），按普通失败处理。

**每个账号的用量**（只在“读取额度”打开时）：只有当前账号能读到实时用量。其余账号的 access token 在不再是当前账号约一小时后过期，续期需要 agy 的 OAuth client secret，T3 没有，所以不为别的账号刷新 token、不起 agy、也不换 token 去探测，而是记住最后一次读数：`probeUsage` 经池的 `observeUsage` 包一层，读成功就把整份 `ServerProviderUsageLimits`（含 `checkedAt`）写到 `accounts/<id>/usage.json`（临时文件加 rename，读的几秒里账号被换走就不写）；删除账号或退出登录一并清掉。`ServerProviderAccount.usageLimits` 带出来，当前账号用实时读数，其余是快照。`collectLimitAccounts` 把有两个以上账号的 Antigravity 实例展开成每个账号一条（key 带账号 id，当前账号不和实例自己的读数重复计）；只有一个账号时仍是一条，但用 `saved[0].email` 命名，并在实时读数不可用时退回它的快照。快照里 `resetsAt` 已过的窗口读作已重置（0% 已用、无重置时间），`exhaustedUntil` 未到的账号读作 100% 已用、重置时间取 `exhaustedUntil`。快照超过 30 分钟（`paceIsMeaningful`）就不再画配速标记和图标，弹层写明读数可能过期。页脚的底栏颜色只看实例自己的实时读数，快照不影响。`useNowMinute()` 返回的是不带时区的 `YYYY-MM-DDTHH:mm`，要 `Date.parse(\`${…}Z\`)`，否则非 UTC 时区的"现在"会偏几个小时。

没处理的：同一实例里别的线程还在跑的 agy 进程仍持有旧账号，它们刷新 token 时可能把旧账号写回当前文件，下一次起 agy 前会按 `exhaustedUntil` 再换一次；这是同一个 token 文件被多个 agy 进程共用的固有问题。新增的 web 和 mobile 界面没有在真实客户端里跑过，只过了类型检查和相关的现有测试。

## Antigravity 后台命令续跑

fork 的 `continuationWithoutPromptEnd` 补丁已删除：上游 #38864（`12be92d034`，`enablePostSettleContinuation` + `wakeOnDetachedRequest` + `replyEndsWithUsageUpdate`）做了同一件事。`packages/provider-acp/src/server/adapter.ts` 和 `AntigravityAdapterV2.ts` 与上游一致。Codex 停止后清审批卡（`finalizeCodexTurn`）还在。

## Antigravity 会话预加载 profile 的 MCP server

agy 只预加载会话 `mcpServers` 里点名的 server，profile 的 `config/mcp_config.json` 里的其余 server 在后台加载，第一轮和委派任务的每一轮都用不上。`readAntigravityProfileMcpServers`（`AntigravityAcpSupport.ts`）读这个文件，`AntigravityAdapterV2.ts` 在启动、load、resume、fork 时把启用的 server 点名进会话。这是上游 #40300 的移植，和上游有两处不同，合并上游时按这个取舍：

- 上游只扩 `mcpServers`。运行时一旦 agent 声明 HTTP 或 ACP MCP，会优先用 http / acp 列表，那时 profile 的 server 会被丢掉，所以 fork 在这两个列表非空时也追加。agy 1.5.15 两者都不声明，目前只用 `mcpServers`。上游如果采纳同样的修改就取上游。
- 过滤放在每次调用里：列表里已有的名字和固定的 `t3-code` 不追加，读文件的函数不带过滤参数。

用隔离的 agy 1.5.15 副本和本地假 server 验证过：agy 按自己 config 里的定义启动被点名的 server，会话里的条目只起名字的作用，所以 header、`cwd`、`env` 都保留，`${VAR}` agy 本来就不展开。点名一个 401、OAuth 401、不存在、卡住的 server，会话和轮次都不会失败，只是没有它的工具；永远不回应的 server 会让会话启动和 resume 多等约 5 秒（agy 自己的上限）。1.5.16 没有测过。

### 实例可以用全局的 MCP 配置和 MCP 登录

实例设置 `useGlobalMcp`（Antigravity 设置里的“使用全局 MCP 服务器”，默认关）。每个实例有自己的 GEMINI_HOME，所以终端 agy 里配好并授权过的 MCP server 在实例里没有；ACP 下也走不完第一次 MCP OAuth（agy 注册客户端后等用户粘贴 code，不开浏览器）。打开后 `syncAntigravityGlobalMcp`（`antigravityGlobalMcp.ts`）在每次启动 agy（`prepareAntigravityProfile`）和驱动创建时（设置一改就生效）做两件事：

- **配置是副本，不是链接。** 把 `~/.gemini/config/mcp_config.json` 去掉 T3 自己的名字（`t3-code`）后写成 `config/mcp_config.json`。agy 按配置里的条目启动被点名的 server（隔离实验的 case 1b：会话条目指向的 URL 一次请求都没收到），链接过来的全局 `t3-code` 会顶替 T3 注入的那个，把工具调用打到官方 T3 Code。副本由 `.t3-global-mcp.json`（profile 根目录，记录上次写入内容的 sha256；第一版存的是全文，仍然认）认领：当前内容等于记录，或等于“现在会生成的副本”（记录丢了或过期也算自己的）时才刷新或删除；用户改过的、profile 自己的非空文件原样保留。副本和记录都写同目录临时文件再 rename，别的线程的 agy 读不到半截文件。全局文件不存在、不是合法 JSON 或没有 `mcpServers` 对象时删掉副本；`mcpServers` 是 `{}` 或只有 `t3-code` 时写一个空表副本（文本生成仍可用）。保留名 `t3-code` 是 `T3_MCP_SERVER_NAME`，adapter 也用它。上一版建的配置链接（指向任何 home 的 `.gemini/config/mcp_config.json`）会被替换或删除。悬空链接的问题也随之消失。
- **MCP 登录文件是链接。** `antigravity-acp/mcp_oauth_tokens.json` 指向 `~/.gemini/antigravity-cli/mcp_oauth_tokens.json`。关闭或 home 变了时，指向任何 `…/.gemini/antigravity-cli/mcp_oauth_tokens.json` 的链接都算本功能建的并被拆掉；指向别处的链接、有登录内容的真实文件原样保留（只记 warning）。空文件、`{}` 都算空，会被换成链接。

`kept`（原样保留的 profile 文件）只写日志：provider 状态的 message 只在出错和未登录时用，ready 状态不带 message，加一个提示要改 provider 状态的结构。不链接 `hooks.json`。Windows 上文件链接要提权，所以不支持，打开时只记一条日志。

用隔离的 agy 1.5.15 副本和本地假 OAuth server 验证过（证据：`global-mcp.md`，`scripts/oauth-*.mjs`）：

- ACP 只读 `<home>/antigravity-acp/mcp_oauth_tokens.json`（放在 `antigravity-cli/`、根目录、`config/` 都不读）。格式按 server URL 做 key，值里要有 `token`（`access_token`、`refresh_token`、`expiry`）、`client_id`、`token_url`，缺 `token_url` 刷新会失败。
- agy 原地改写这个文件（inode 不变）。符号链接保留，目标收到刷新后的 token。agy 跟随指向别处的 `mcp_config.json` 链接，而且从不写它。悬空的登录链接无害。
- 多进程：agy 刷新前**不重读文件**，用启动时读到的 refresh token 去刷新；刷新失败时只删**那一条**，其他条目（包括进程运行期间新加的）保留，是读改写而不是整表覆盖。所以 refresh token 会轮换的服务商下，一个进程刷新之后，其他进程（别的线程、终端 agy）再刷新会失败，并把刚写好的新条目删掉，要在终端重新登录。refresh token 不轮换的服务商不受影响。没加锁也没加代理，设置说明和用户文档里写明了这个风险。
- 独立 agy 的 token 路径 `~/.gemini/antigravity-cli/mcp_oauth_tokens.json` 是推断的：独立模式要真实的 Google 登录，隔离实验里跑不了。配置路径 `~/.gemini/config/mcp_config.json` 是实测的。
- **没验证**：用 agy CLI 登录的实例（`sharedLogin`，不设文件存储开关）的 MCP 登录是否也走这个文件，还是进钥匙串；钥匙串没法隔离，没有实验。真实 OAuth 服务商、agy 1.5.16 也没测。

副作用：`isAntigravityTextGenerationAvailable` 在 profile 的 `mcp_config.json` 里有任何条目（包括 `disabled: true` 的）时返回 false，所以全局配置里有 server 时这个实例不能再生成标题和提交信息。规则没改，设置的说明文字里写了。

## 侧边栏视图

侧边栏有"按状态"（上游的 Inbox）和"按项目"两种视图，后者在项目文件夹下再按 worktree 分子组，是默认视图：`boringSidebarEnabled` 的默认值在 contracts 里改成了 true（带 `// fork:`），手机端偏好未设置时回落到 `"project"`（`threadListViewState.ts` 的 `DEFAULT_VIEW_MODE`）。默认值只对没存过这一项的设备生效：桌面版一旦存过任何客户端设置，整份设置（包括 `boringSidebarEnabled`）都会写进 `client-settings.json`，所以以前存过 `false` 的设备要手动切一次。用户说明见 `docs/user/thread-sidebar.md` 的 "Choose a sidebar view"。

- 视图就是上游 Labs 里的 Boring sidebar 设置（`ClientSettings.boringSidebarEnabled`，经 `ensureLocalApi().persistence` 按设备保存，不跨设备同步）：开是"按项目"，关是"按状态"。顶部切换、命令面板两项和 Labs 开关读写同一个设置：`useSidebarViewMode()` 和 `getSidebarViewMode()` 直接读 `boringSidebarEnabled`，`setSidebarViewMode()` 和 Labs 一样只写 `{ boringSidebarEnabled }`；上游已删掉 `legacySidebarEnabled`。「恢复默认」（设置页 `useSettingsRestore`）把它当作"侧边栏视图"一项，不是默认值就列出并重置。fork 自己的 store（`apps/web/src/fork/sidebarViewStore.ts`，localStorage key `t3extend:sidebar-view:v1`）只存折叠状态；旧数据里的 `mode` 字段直接忽略，不迁移。折叠 key 带视图前缀（`sidebarGroupCollapseKey`），不进 `ClientSettings`，不改 contracts。
- 分组是纯函数，放在 `packages/client-runtime/src/state/threadGrouping.ts`（`@t3tools/client-runtime/state/thread-grouping`），web 和以后的 Android 共用。
- 按项目视图复用 boring 的所有分支：没有 Working shelf、不能拖拽，New thread 和 `chat.new` 的行为与 boring 相同（多个项目时弹项目选择器，只有 legacy 侧边栏直接在当前项目新建）。按项目视图就是开着 boring sidebar 的侧栏，只多了 worktree 子分组，所以没有单独的"boring 开、按状态"这种状态。
- `Sidebar.tsx` 的接线（都带 `// fork:`）：
  1. 文件头的 import（`useProjectViewFolders`、`SidebarWorktreeGroupHeader`）。
  2. `useSidebarThreads` 里 `projectFolders` 先取 `useProjectViewFolders` 的结果，`orderedThreadKeys` 因此跟着屏幕顺序走。
  3. `useSidebarThreads` 返回的 `toggleProjectFolder`：按项目视图下写 fork store。
  4. 列表渲染的文件夹循环：有 `folder.worktrees` 时先画 worktree 子组标题，再画行。
- 其他上游文件各一两行：`SidebarThreadHeader.tsx`（切换按钮）、`CommandPalette.tsx`（两条命令，定义在 `CommandPaletteSidebarViewItems.tsx`）、`lib/sidebarTree.ts` 没有 fork 改动：上游去掉了 `aria-level` 与 `role="tree"`，改用 `data-sidebar-row` / `data-sidebar-parent` 的父子链走方向键，worktree 子分组标题和它下面的对话都带这两个属性，所以第三层不用单独补（`SidebarWorktreeGroupHeader` 也不再带 `role="treeitem"` 和 `tabIndex={-1}`，和上游的文件夹标题一样留在 Tab 序里）。`chatRouteCommands.ts` 里关于侧栏视图的分支已删，只剩一处与侧栏无关的 i18n 翻译（预览仅桌面版的提示）。
- 快捷键没有加，因为要改 `packages/contracts/src/keybindings.ts`。

mobile（Android 和 iOS 的对话列表，Home 和平板侧栏共用）：

- 共享：`threadGrouping.ts` 还提供 `groupThreadsByProject`（从 web 的 `Sidebar.logic.ts` 搬来，web 里 `groupSidebarThreadsByProject` 现在是它的 re-export）、`flattenProjectViewFolders` 和 `projectViewFolderThreadCount`。测试都在 `threadGrouping.test.ts`，两端不再各写一份。
- 偏好：`threadListViewMode` 和 `threadListCollapsedGroups` 存在 mobile 偏好里（`mobile-preferences.ts`），折叠 key 和 web 相同（`sidebarGroupCollapseKey`）。hook 是 `apps/mobile/src/fork/threadListView.ts`。
- 布局：`fork/threadListProjectView.ts` 只重排按状态布局里"置顶之后、第一个货架之前"的活跃行，先按发送时间排序，再复用 `buildProjectViewFolders`。不在项目列表里的项目的对话进末尾的"Other projects"组，不会消失。表头是列表项 `v2-group-header`（`threadListV2.ts`），组件是 `fork/ThreadListGroupHeader.tsx`。
- 层级：worktree 头比项目行缩进一级（图标 `ps-7`），它下面的对话再缩进一级（`ps-12`，标题和头的标签对齐）。1px 引导线（`bg-sidebar-border`）从头的图标中心（x=35）画到该组最后一行的中线（`nested="last"`，手机同理），与下一个头之间留空，每组各自一条线：头的 `after:` 加上每行 `li` 的 `before:`（`SidebarThreadRow` 的 `nested`），行 `li` 用 `pb-px -mb-px` 盖住行间 1px 的 gap，不改变布局。主 checkout 没有徽标：标签是分支名，没有分支时是"Main checkout"，图标（分支 vs 文件夹）区分主 checkout 和 worktree。手机：`ThreadListV2NestedRow` 给 `nested` 行加缩进和引导线，头在 `hasRows` 时画一小段衔接。只有主 checkout 的项目不分组，对话直接挂在项目下。
- 按项目视图下没有 Working 货架，也不能手动上下移动；搜索时仍按相关度平铺，清空搜索后恢复分组。
- 入口：筛选菜单里的"对话分组"（Android `HomeHeader.android.tsx` 和平板侧栏 `ThreadNavigationSidebar.tsx`，菜单项在 `fork/threadListViewMenu.ts`；iOS 原生头部走 `buildHomeListFilterMenu`，iOS Home 的筛选条多一个胶囊）。
- 状态点：`resolveSidebarFolderDot`、`resolveSidebarThreadStatus`、`hasUnseenCompletion` 现在在 `threadGrouping.ts`，web 的 `Sidebar.logic.ts` re-export，测试只在共享层。规则同 web：折叠的项目头说明它藏起来的对话，worktree 头永远说明自己的全部对话；`ThreadListV2GroupHeaderListItem.dot` 带它。
- 启动：偏好没读出来之前，Home 和平板侧栏什么都不画，不会先闪一下按状态视图。冷启动时启动画面本来就等偏好，所以默认视图的用户看不到额外延迟。读取失败时立刻显示默认视图（按项目）并 `console.warn`；超过 `VIEW_PREFERENCE_GRACE_MS`（1 秒）还没读出来也先显示默认视图，所以迟到的空偏好不会让列表重排，只有真正存过的值才会切换视图。偏好读出之前用户做的选择（切视图、折叠）先记在内存里（所有列表和菜单共用），界面照常反映；偏好读出后叠加在保存值之上并保存一次，用户的选择优先于迟到的保存值（折叠按目标状态记，不会因为保存值里已有该 key 而翻转）。读出时超过上限的折叠列表只留最新的 200 个（`persistence/mobile-preferences.ts`）。逻辑在 `fork/threadListViewState.ts` 和 `threadListCollapse.ts`，测试在同目录。
- 折叠 key 不按项目列表清理：离线的环境没有加载项目，按列表清理会误删它们的折叠。改为只保留最近的 `MAX_COLLAPSED_GROUPS`（200）个，已删除项目的 key 会随新的折叠挤出去。
- iOS 没有实机或模拟器验证。

## 侧边栏底部状态芯片与桌面保持唤醒

侧边栏底部的图标行上面有一行三个状态芯片：订阅额度、资源占用、本项目的本地服务端口；桌面版另有"保持唤醒"开关。芯片开关在 设置 > 外观 > 侧边栏状态，保持唤醒开关在 设置 > 维护 > 电源（仅桌面版，紧挨着"后台活动"）。开关存在 `fork/footerStatusStore.ts`（localStorage，按设备），不进 `ClientSettings`。

- 新文件都在 `apps/web/src/fork/`：`SidebarFooterStatus.tsx`（容器，按行宽给每个芯片选 full/compact/icon 三档）、`FooterUsageLimits.tsx`、`FooterResources.tsx`、`FooterPorts.tsx`，各自的 `*.logic.ts` 放纯逻辑与测试，`FooterChip.tsx` 是共用外壳，`FooterStatusSettings.tsx` 含芯片开关和 `KeepAwakeSettings`，`KeepAwakeReporter.tsx` 把"有任务在跑"上报给桌面主进程。桌面端在 `apps/desktop/src/keepAwake/`（`powerSaveBlocker`，只在有任务运行且开关开着时持有），共享常量在 `packages/shared/src/keepAwake.ts`。
- 上游文件里的接线点（都带 `// fork:`）：`Sidebar.tsx`（把 `scopedProjectRefs` 传给 `SidebarChromeFooter`）、`sidebar/SidebarChrome.tsx`（在 `SidebarChromeFooter` 里渲染 `SidebarFooterStatus`，memo 比较 `scopedProjectRefs`）、`AppSidebarLayout.tsx`（Electron 下挂 `KeepAwakeReporter`）、`settings/AppearanceSettingsPanel.tsx`（`FooterStatusSettings`）、`settings/SettingsPanels.tsx`（`KeepAwakeSettings`）、桌面的 `preload.ts` 与 `ipc/DesktopIpcHandlers.ts`，译文在 `catalogs/zh-Hans/footer.ts`。
- 资源面板按进程树分组（每个 agent 一行、终端、T3 Extend、其他，每个进程只算一次）。服务端从不给进程打 `provider-root` / `terminal-root` 分类，所以前端沿 ppid 链找到服务端的直接子进程再按名字归类，规则与 `ProcessGroupMetrics.ts` 一致（`footerResources.logic.ts`）。要按线程精确归属得改 contracts，目前没做。
- 布局：三个芯片在图标行（设置、PR、用量、更新）上面单独占一行，图标行保持上游原样。`SidebarChrome.tsx` 只多一行接线，把 `SidebarFooterStatus` 放在 `SidebarUtilityMenu` 之前。没有任何芯片可显示时这一行不渲染。优先级是 限额 > 资源 > 端口，宽度按优先级分配（`footerDensity.logic.ts` 的 `resolveFooterLayout`）：升级按一条固定顺序走，布局就是这条顺序里放得下的最长前缀：先按优先级给每个芯片图标（某个芯片的图标放不下，它和它后面的整个不画），再按优先级给每个芯片数字，最后按优先级升级成完整文字。遇到第一个放不下的升级就停，不会跳过它去升级后面的芯片，所以侧边栏变宽时任何芯片都不会变少。宽度是估算值（数字 7.2px、其他拉丁字符 6.4px、中日韩字符 12px，每个芯片另加 26px），不是实测。限额芯片的短形式写出最紧的 provider 名，例如 "Claude 47%"。默认宽度（256px）下三个芯片都有数字，最窄（208px）时端口只剩图标。
- 限额芯片：已过 `resetsAt` 的窗口不参与最紧窗口的选择，也不决定颜色，面板里显示"现在重置"；读数的 `checkedAt` 超过服务端状态刷新间隔（设置 > 维护 > 后台活动，默认 5 分钟）的两倍就不再变色，只保留数字。两者都靠分钟时钟重新计算，没有新增轮询（`footerLimits.logic.ts`）。
- 端口芯片复用 `subscribeDiscoveredLocalServers`，不新增 RPC；只列所属线程在当前项目内的服务，"在预览中打开"，不提供结束进程。
- 后台/实时两档采样：`subscribeResourceTelemetry` 和 `subscribeDiscoveredLocalServers` 的 payload 多一个可选 `cadence: "live" | "background"`（`packages/contracts/src/rpc.ts`，`// fork:`）。芯片在窗口可见且开关开着时用 `background`，展开面板期间另加一路 `live`，窗口隐藏就退订（`documentActivity`）。服务端规则：
  - 资源采样：只有 `live` 订阅者 → 原速（1s）；只有 `background` → 插电 15s、用电池 30s、锁屏/挂起/低电量/过热 60s；两者都有取快的；都没有则停止采样。`background` 不打开进程诊断需求。
  - 端口扫描：`live` 3s 一次；只有 `background` 订阅者时至少间隔 15s；没人订阅就不扫。`retain` 保持原样，后台用新的 `retainBackground`。
  - 下限由服务端保证，与客户端怎么订阅无关：后台订阅开始时，上一次扫描（扫描器空闲后也保留）或缓存的资源快照还在间隔内，就直接用它，不再扫描/采样（`PortDiscovery.scanBackground`、`acquireBackground`）；实时订阅照旧立即扫描、立即采样。sidecar 的 `SetSampleInterval` 本来就不会立刻采样，只有启动/重启时的 `Configure` 会。有对话打开时对话视图自带一路实时端口订阅，端口仍是 3s。
  - 旧服务端：Schema 解码会丢掉多余字段，不会报错，只是 `cadence` 被忽略，退回 1s / 3s，行为正确但没有省电。
- 手机端不改：`UsageLimitsSection.tsx` / `ComposerUsageLimits.tsx` 已经显示每个窗口的剩余百分比和重置时间。

## 自建连接

用自己的 VPS（registry + frps + Caddy）代替 T3 Connect，电脑和手机互相连接，不经过官方 relay 和 Cloudflare。设计和每个决定的理由在 `research/self-host-device-keys.md`，不变的约束在 `docs/internals/self-hosted-devices.md`。

两种方式，可以同时存在：

- **你的服务器**（默认，每台设备一把密钥）：电脑和手机各有一把 P-256 密钥，VPS 的 registry 只保存公钥、邀请和子域名。电脑用自签的 ticket 登录 frps，把自己挂在 `<名字>.<域名>` 上；手机和别的电脑用短期的设备通行证换一个绑定自己 DPoP 密钥的会话。客户端用 `"t3x-device"` 授权 profile，**失败即阻断**，永远不会回落到官方 relay 或 Bearer。
- **公网地址**（Advanced，旧方案）：自己配 frps/frpc 和反代，把一个 https 地址当作普通 `Bearer` 路由，配对沿用 `https://host/pair#token=<一次性码>`。服务器那一半在 `infra/self-host/advanced/`，设置里收在 Advanced 下。

不自托管 `infra/relay`，不复用 `providerKind: "t3_relay"`。

### 代码在哪里

| 位置                                                                                                                                                                          | 内容                                                                                                                   |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `infra/self-host/registry/`                                                                                                                                                   | registry（Node 24，只用内置模块）：邀请、加入、清单、签名请求、frps 插件（`:8081`）、Caddy `ask`（`:8082`）、`cli.mjs` |
| `infra/self-host/{setup.sh,t3x,docker-compose.yml,Caddyfile,caddy/,frps.toml}`                                                                                                | 部署：一条命令装好 registry、frps、Caddy 和默认安装的 ntfy；`./t3x` 是运维 CLI                                         |
| `infra/self-host/{docker-compose.test.yml,Caddyfile.test,e2e/}`                                                                                                               | 本机试用的覆盖文件（Caddy 自己的 CA，只发布在回环地址）和 8.1 的故障场景脚本                                           |
| `infra/self-host/advanced/`                                                                                                                                                   | 旧的共享 token 方案和它的文档                                                                                          |
| `packages/contracts/src/forkDeviceKeys.ts`                                                                                                                                    | `devices.*` RPC 和注册表的 JSON 形状                                                                                   |
| `packages/shared/src/forkDeviceKeys/`、`forkFrp.ts`、`forkFrpFetch.ts`、`selfHost.ts`                                                                                         | 协议库（JWS、请求签名、通行证、ticket、邀请、子域名、隧道状态文件）；frp 版本表和带 SHA-256 校验的下载；公网地址规范化 |
| `apps/server/src/fork/deviceKeys/`、`apps/server/src/cli/devices*.ts`                                                                                                         | 设备身份、清单同步与对账、通行证换会话、隧道监听口、frpc 托管；`t3x devices` CLI                                       |
| `packages/client-runtime/src/fork/deviceKeys/`                                                                                                                                | 阻断式授权、发现、环境同步器、邀请解析                                                                                 |
| `apps/web/src/fork/`（`YourServerSettings.tsx`、`YourServerVisibility.tsx`、`deviceKeys*.ts`、`DeviceKeysSync.tsx`）、`apps/web/src/components/settings/SelfHostSettings.tsx` | 桌面里的 "Your server" 设置；旧的公网地址和隧道命令                                                                    |
| `apps/mobile/src/fork/deviceKeys/`                                                                                                                                            | 手机：密钥、加入、设备页、前台刷新                                                                                     |
| `apps/desktop/src/selfHost/`                                                                                                                                                  | 保存公网地址、托管旧方案的隧道命令、把自建地址列为配对端点                                                             |
| `scripts/fork-fetch-frp.ts`、`scripts/lib/fork-frpc.ts`、`scripts/fork-selfhost-e2e.ts`、`scripts/fork-selfhost-e2e/`                                                         | 下载 frpc；打包和端到端共用的缓存；本机端到端                                                                          |

### 上游文件里的接线（都带 `// fork:`）

以 `git grep -n "// fork:"` 为准，同步上游时用它查全；下面是按功能分的清单。

- 公网地址（Advanced）：`packages/contracts/src/server.ts`（`ServerDirectEndpointKind` 加 `"public"`，旧客户端通过 `ForwardCompatibleArray` 跳过）、`packages/client-runtime/src/connection/routes.ts`（`mergeLearnedRoutes` 只接受 https 的 `"public"`）、`apps/server/src/environment/DirectEndpoints.ts`、`apps/server/src/environment/PublicUrls.ts`、`apps/server/src/cli/{config,server,up,auth,pair}.ts` 和 `publicUrlFlags.ts`（`--public-url`、`--clear-public-urls`、`t3 pair --base-url`）、`apps/desktop/src/{main.ts,preload.ts,ipc/DesktopIpcHandlers.ts}`（`DesktopSelfHost`、`t3xSelfHostBridge`；沙箱 preload 解析不了 workspace 包，bridge 名在 `selfHost/selfHostChannels.ts` 里另存一份，`preloadSandbox.test.ts` 比对两边）、`apps/web/src/components/settings/ConnectionsSettings.tsx`。
- 你的服务器，server：`packages/contracts/src/{index,rpc,clientRpcPermissions}.ts`（并入 `devices.*`）、`apps/server/src/auth/{RpcAuthorization,replayMarkers,AuthAttemptLimiter,http}.ts` 和 `observability/RpcInstrumentation.ts`（权限表、重放标记前缀、通行证端点计入限速、两个响应头助手加 `export`）、`apps/server/src/ws.ts`（RPC handler）、`apps/server/src/server.ts`（层、通行证路由、隧道监听口）、`apps/server/src/binCli.ts`（`devices` 子命令）、`apps/server/src/environment/PublicUrls.ts`（读 `device-public-url.json`）。
- 你的服务器，桌面：`apps/desktop/src/backend/DesktopBackendConfiguration.ts`（`T3X_FRPC_PATH`）、`apps/desktop/src/ipc/methods/serverExposure.ts`（把这台电脑自己的设备地址列为端点 `self-host:device:<url>`，隧道 connected 且状态文件够新时标 available）。
- 你的服务器，client-runtime：`connection/{catalog,model,resolver,driver,registry,routes}.ts`、`state/environmentHttpAuth.ts`、`authorization/service.ts`、`rpc/client.ts`；`apps/web/src/lib/runtime.ts` 和 `apps/mobile/src/lib/runtime.ts` 提供真实的 `DeviceKeyAuthorization`；`packages/{shared,client-runtime}/package.json` 加 exports。
- 你的服务器，界面：`apps/web/src/components/{AppSidebarLayout,CommandPalette}.tsx`、`apps/web/src/components/settings/{ConnectionsSettings,settingsSearch}.ts(x)`；`apps/mobile/src/{App,Stack}.tsx`、`features/settings/{SettingsRouteScreen,components/settings-page-targets}.ts(x)`、`apps/mobile/vite.config.ts`。
- Antigravity 后台命令续跑：见上面「Antigravity 后台命令续跑」一节。
- Codex 适配器的请求清理：`apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts` 的 `pendingRequestRecord`（七处注册点各一行）和 `cancelPendingRuntimeRequests`（`finalizeCodexTurn` 里调用）。轮次结束（Stop、失败、Codex 自己结束）时取消该轮没人回答的审批和提问，卡片和侧边栏的 Approval 徽标一起撤掉；上游不清，点 Approve 什么也不会发生。`codex-session-approvals` 用例的脚本相应改成在本轮结束前回答。

### 你的服务器怎么工作

- **服务器端**：`setup.sh` 装好整套，只有 Caddy 发布 80 和 443，frps 的控制连接走 Caddy 的 `/~!frp`（wss），7000 不对外。registry 同时是 frps 的插件和 Caddy 的 `ask`，只放行登记过的子域名。镜像全部钉了版本和摘要（frps v0.71.1、Caddy 2.11.7、ntfy v2.36.0、`node:24.18.1-alpine3.24`），`registry/deploy.test.mjs` 检查这一点和"只有 Caddy 发布端口"，升级时一起改。
- **VPS 上已有别的网站**：`docker-compose.host-network.yml` 让 Caddy 用宿主机网络接管 80/443，registry、frps、ntfy 的端口只发布到 `127.0.0.1`（默认 17080/17082/17000/17088/17090，frps 的插件口 8081 不发布）；Caddyfile 的所有上游地址都是带默认值的环境变量（`{$T3X_REGISTRY_API:registry:8080}` 这种），标准装法不设它们。别的网站的配置是 `T3X_SITES_DIR`（默认 `sites/`）里的 `*.caddy`（站点）和 `*.options`（全局选项，如 `default_sni`）。ACME 邮箱可选：`caddy/conf.sh` 有邮箱时写 `email <地址>`，没有时写一行注释（`email {$ACME_EMAIL}` 在变量为空时 Caddy 会拒绝，而且用环境变量就得重建 Caddy）。
  - **按需子域名的站点写成 `*.{$T3X_DOMAIN}`，不能是裸 `https://`**：裸的站点匹配所有名字，客户端不发 SNI（用 IP 访问）时 `default_sni` 指向的证书会被当作 on-demand 去问 `ask` 而失败（实测）。
  - **代价和 `caddy/ntfy.caddy` 的 `tls { on_demand }`**：通配覆盖 `ntfy.<域名>`。真实 `Caddyfile`（ACME 签发者，没有 `local_certs`）会给 ntfy 单列一个排在通配前面的普通托管策略 `[ntfy, 主域名]`：握手时它不会被问 `ask`，又因为在通配范围内启动时也不签，于是永远签不到。ntfy 站点自己写 `tls { on_demand }`，策略变成 `[ntfy, *.域名] on_demand`；registry 的 `ask` 在推送服务器装了（`T3X_NTFY_ENABLED=1`，`setup.sh` 写进 `.env`，compose 传给 registry）时对保留名 `ntfy` 回 200，第一次访问时才签。主域名不在通配范围内，启动时照常签发。
  - **测试用真实的 `Caddyfile`，不能用 `Caddyfile.test` 代替**：`local_certs` 让所有策略签发者相同，Caddy 把它们合并，ntfy 落进排在后面的兜底策略，碰巧走按需，这就是 `9267e46bbb` 的测试在坏配置上也通过的原因。`infra/self-host/registry/caddy-certs.test.mjs` 起真实的 `Caddyfile`（容器的 DNS 指向无处，ACME 联系不到任何 CA），看 Caddy 有没有把问题问给 `ask`：ntfy、电脑的名字问，主域名不问；去掉 `ntfy.caddy` 的 `tls { on_demand }` 就失败。`deploy-config.test.mjs` 另有静态一条：adapt 之后 ntfy 和电脑名字命中的第一条策略是按需的。e2e 的测试栈用 `ntfy-off.caddy`，不装 ntfy，也不测这条。
  - **`setup.sh` 重跑（升级）**：没有再给出的选择沿用已有的 `.env`——`T3X_COMPOSE_FILES`、`T3X_SITES_DIR`、`T3X_PROJECT`、`T3X_HOST_*`、邮箱、推送服务器（`--no-ntfy`/`--ntfy`、`--no-email`/`--email` 显式给出才改）；变量设为空值表示改回默认；显式值和 `.env` 不同时按新值并打印提示。旧 `.env` 只认 `setup.sh` 自己写的格式（`KEY=值`，值里没有空格、引号、`#`、`$`，不写 `export`，键不重复），其他写法直接拒绝，不猜。compose 文件名要过白名单、文件要存在，`T3X_SITES_DIR` 一律写成绝对路径并拒绝 compose 会解释的字符，这些检查都在建目录、写 `.env` 之前做完。
  - **Caddy 的配置是目录，开关是文件的内容**：compose 把 `T3X_CADDY_CONF_DIR`（`setup.sh` 写在数据目录的 `caddy-conf/`，不进仓库）整个挂到 `/etc/caddy/conf`，Caddy 的命令指向里面的 `Caddyfile`；`caddy/conf.sh` 写出这三个文件（`Caddyfile` 或 `--test` 的 `Caddyfile.test`、`ntfy.caddy`、`acme-email.caddy`），`setup.sh`、e2e 测试栈和静态检查都用它。单文件挂载在文件被换掉（`git pull`、`mv`）后容器里还是旧 inode，只改内容又不会让 `docker compose config --hash` 变；目录挂载没有这个问题。推送服务器开关和邮箱不再是 compose 的环境变量或挂载选择，翻转它们不改 Caddy 的定义哈希（`deploy-config.test.mjs` 检查），所以不用重建 Caddy。
  - **`setup.sh` 对 Caddy 的处理**：先 `up registry frps [ntfy]`（不加 `--no-deps`：这几个服务都不依赖 Caddy，加了反而跳过 frps 对 registry 的健康等待）（关掉推送服务器时再 `--profile ntfy rm -sf ntfy`，数据卷保留），再单独 `up --no-recreate caddy`。Caddy 是新建的，就记下配置目录的摘要（`.caddy-conf.applied`，只在启动或重载成功后写）；已经在跑、定义没变而摘要变了，就 `caddy reload`，被拒绝时原样报错并以非零状态退出；定义变了（比较 `compose config --hash caddy` 和容器的 `com.docker.compose.config-hash`）就只提示，要应用加 `--recreate-caddy`，因为重建会让这台 VPS 上别的网站断几秒。线上有一次重跑把 Caddy 和 frps 也重建了：本地试用栈（compose 5.2.0）上只改 registry 的环境变量或镜像，只重建 registry，没复现；`docker compose config --hash` 显示那次升级里 Caddy 和 frps 的定义哈希没有变，compose 源码里也找不到依赖被重建就连带重建依赖它的服务的逻辑，原因没查到。再遇到时比较 `docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' t3x-caddy-1` 和 `docker compose config --hash caddy`。
  - 静态检查在 `infra/self-host/registry/deploy-config.test.mjs`（`docker compose config` 加 `caddy adapt`，需要 Docker，`CI` 有值而没有 Docker 时失败）。
- frp 版本和各平台归档的 SHA-256 在 `forkFrp.ts`，测试检查它和 compose 里的 frps 标签一致。
- **电脑端**：server 托管 frpc（`DeviceTunnel.ts`），frpc 的 `localPort` 指向只绑 `127.0.0.1` 的隧道监听口（系统分配端口），不是主端口。ticket 由电脑自己签，绑定设备 id、子域名和登记代次，24 小时有效、12 小时轮换。每 60 秒向 registry 同步一次设备清单，`GET /v1/devices` 每次都返回完整清单（`online` 和上次出现时间随时间变，`rev` 不变，所以没有条件请求），每次同步成功都推一次快照，界面直接用快照里的状态。同步失败只记 warn 并保留旧清单。
- **撤销**：`./t3x revoke` 或在桌面里移除后，registry 在 frpc 的下一次心跳（30 秒）拒绝它；电脑自己的 60 秒同步发现被移除时，会自清理（状态变成 `removed`，成员身份、密钥、地址清掉，隧道 `disabled`）。其他电脑和手机的会话在各自下一次同步时撤销，已经建立的连接约 20–30 秒内断开。从另一个进程移除（CLI 的 `t3x devices remove` 和 `devices leave`，上游的 `t3 auth session revoke` 也一样）是直接写库，运行中的 server 收不到任何事件，要到下一个同步周期（约 60 秒）才断开连接，这段时间里旧 socket 仍然能收发数据（e2e 场景 18 实测 58 秒）。所以每次同步的最后，不论这台电脑有没有 membership、注册表通不通，都调用 `SessionStore.announceRevoked`，把仍被 socket 依赖、行却已被撤销的会话报成 `clientRemoved`；它失败只记 warning，不影响同步，读不了的单个会话跳过。同一进程里的移除（设备 RPC、设置界面、reconcile 发现 VPS 上的 revoke）立刻断开。`devices leave` 把 membership、密钥、清单清掉并撤销设备会话，运行中的 server 同步周期照跑，所以 socket 同样在一个周期内关闭。上游 CLI 撤销会话的这个空档，由这个检查一并补上，是 fork 多出来的行为。手机上，被电脑以 `device_unknown` 或 `device_revoked` 拒绝的第一次登录会立刻向注册表刷新一次设备列表（`DeviceAuthorizationSource.passRefused`），马上显示“已被移出”，不必等回到前台。电脑离线时错过的移除，要等它重新连上服务器才撤销。
- **清单的新鲜度**：3 分钟没同步，设置页提示"连不上服务器"；24 小时后警告；7 天后不再接受新的设备通行证，同步上以后恢复。已签发的会话最长再有效 1 小时。
- **子域名**：从名字派生，已移除电脑的子域名留墓碑，不再分配给别人，重新加入的同一台电脑拿到 `mac-2` 这样的新名字；`./t3x release <子域名>` 才能收回。
- **客户端**：设备管理的环境用 `"t3x-device"` profile。`packages/client-runtime/src/fork/deviceKeys/`：`DeviceKeyAuthorization`（`Context.Reference`，缺省实现永远阻断）、`discovery.ts`（先注册表、再 URL 检查、再 well-known 比对，最后才换通行证）、`liveAuthorization.ts`（`device_unknown` 说明对方还没同步，按 1、2、4、8、16、30 秒退避重试约 75 秒，界面显示"等待那台电脑确认…"，其他错误不重试）、`deviceEnvironmentSync.ts`（只动 `t3x-device:` 前缀的环境）、`inviteReading.ts`（粘贴或扫描的邀请，加入前只读不发请求，桌面和手机共用）。盖章只来自 resolver，`staticGuard.test.ts` 规定哪些文件可以调用 `.authorizeDpop(`、`.authorizeDpopHttp(`、`.renewDpopBeforeExpiry(`；`DeviceEnvironmentIndex` 是第二道防线，见 `docs/internals/self-hosted-devices.md`。
- **桌面界面**：设置 → Sharing & access（路由 `/settings/access`）里的 "Your server"（`apps/web/src/fork/YourServerSettings.tsx`，设置搜索条目 `your-server`），旧的公网地址和隧道命令收在 Advanced 里；命令面板的 "Invite a device" 只在桌面端出现。纯浏览器里没有这一块（没有 `t3xSelfHostBridge`，且 `devices.*` 只对桌面 app 自己的会话开放），要在 Electron 里验证。渲染进程没有设备密钥，通行证由本机 server 的 `devices.signAssertion` 签。主进程从 `<T3 home>/userdata/device-public-url.json` 读这台电脑的地址（服务器按 membership 写，离开时删）。
- **手机**：`apps/mobile/src/fork/deviceKeys/`。密钥在 SecureStore（静态加密，不是不可导出；iOS 用 `WHEN_UNLOCKED_THIS_DEVICE_ONLY`，不进备份也不换机；Android 靠 expo-secure-store 插件把 `SecureStore` 排除出备份）。注册表请求用 `expo/fetch`，因为 React Native 的全局 `fetch` 不管 `redirect: "manual"` 都会跟随重定向。`deviceSync.ts` 是不依赖 Expo 的规则层，所以能用 Node 单测；`installDeviceKeysSync.ts` 只在启动和回到前台时刷新（两次之间至少 30 秒），没有后台轮询。页面只读：手机不邀请也不移除。
- **界面规则**：邀请的有效期显示补零的 24 小时制绝对时间（"有效至 01:14"），不倒数。"连不上服务器"提示和"上次出现 X 前"用一个只触发一次的 `setTimeout` 走到下一个变化时刻（`fork/useClockWindow.ts`、上游的 `useRelativeTimeState`），没有 interval；不要在渲染里直接写 `Date.now()` 或 `formatRelativeTimeLabel(...)`，编译器会按入参把结果缓存住。
- **无头机器**：没有渲染进程，用 `t3x devices join / list / invite / remove / leave / visibility / tunnel`。`list` 只读本地保存的清单，不联网（同步由 server 做；CLI 另起一次同步会和 server 自己的同步并行，还可能删掉设备密钥）；`tunnel install` 下载钉住版本的 frpc 到 `<T3 home>/bin`，`tunnel status [--json]` 看 frpc 和隧道。数据目录参数是 `--base-dir`（等价 `T3CODE_HOME`）。

- **电脑可见性**：每台电脑可以对组里的其他设备隐藏自己，四种模式：对所有设备可见（默认）、对所有设备隐藏、对指定设备隐藏（之后新加入的默认能看到）、仅对指定设备可见（之后新加入的默认看不到）。设置只存在这台电脑本机（`<state>/secrets/fork-device-visibility`），`DeviceKeysService.setVisibility` 一个入口，RPC `devices.setVisibility`（只有桌面 bootstrap 会话）和 `t3x devices visibility` 都调它。**登录拒绝由电脑自己做**：`DeviceAssertionAuth` 每次都读本机文件，被隐藏的设备得到 `device_hidden`（在锁内再查一次，保存设置和换会话不会交叉）；文件读不出来时照样拒绝所有通行证，但这个兜底值不当成用户的设置：不写进状态、不推给 registry，状态里标 `unreadable`，设置页提示"读取失败"。registry 只负责"看不到"：`GET /v1/devices` 按请求方过滤，被隐藏的设备拿不到条目，在它那边这台电脑就像被移除了（环境消失，绑定项目显示"环境不可用"），但它自己的条目永远在列表里，所以不会触发"你已被移除"、也不会删密钥。**单向**所以过滤还不够：电脑 A 对 B 隐藏后 A 仍要登录 B，B 必须能验 A 的通行证，所以 registry 把 A 的身份（id、kind、公钥，别无其他）放进响应的 `hiddenPeers`；它不在 `devices` 里，不成为环境，B 保留它的会话。打开隐藏或缩小范围时，在同一把锁里撤销被排除设备的会话（同进程内 socket 立刻关闭；用 CLI 改则等运行中 server 的下一次同步，约 60 秒），之后才告诉 registry。registry 是旧版本时（自己的条目不带 `visibility`）设置页提示"服务器需要更新"，本机拒绝照样生效；对不上时每次同步重推。被隐藏方（含手机）既看不到也移除不了它：registry 对看不见的目标一律答 404。`./t3x devices` 列出全部设备并标出可见性。邀请列表和取消邀请也按可见性过滤（看不见的邀请取消得 404）；`hiddenPeers` 只发给电脑，不发给手机。**被隐藏的电脑必须是新版本**：旧版不认识 `hiddenPeers`，会撤销隐藏方的会话，隐藏方就连不上它（文档和对话框都提示先升级）。registry 数据库升到 schema 2（迁移在一个事务里、逐列检查，中途失败的库下次启动会补齐），迁移后不能回滚到旧镜像。registry 的同步状态（synced / pending / unsupported）存在本机 `fork-device-visibility-sync` 里，带着它对应的设置值，`t3x devices visibility show` 在新进程里也读得到；CLI 不在自己进程里同步，名字找不到时报错并提示用设备 id。设计取舍见 `docs/internals/self-hosted-devices.md`。

### 环境变量

| 变量                                                                | 作用                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `T3X_FRPC_PATH`                                                     | 用哪个 frpc。桌面后端和 app 写的 `t3x` 启动脚本都设成 `<resourcesPath>/bin/frpc`（DMG 内置的那个，无条件覆盖外面设的值，所以 `t3x devices tunnel status` 报的就是 app 在用的）。文件和目录必须属于当前用户或 root、别人不可写，并且 `-v` 恰好输出钉住的版本。没通过检查的候选会被跳过，回落到 `<T3 home>/bin/frpc`（`t3x devices tunnel install` 写的就是这里）。从不查 PATH。                          |
| `T3X_FRP_BASE_URL`                                                  | 下载 frpc 的镜像前缀（放同样的文件名）。只改字节从哪里来，SHA-256 照样校验。`tunnel install`、`fork-fetch-frp.ts`、打包脚本都认。                                                                                                                                                                                                                                                                       |
| `T3X_TUNNEL_CA_FILE`                                                | 让 frpc 额外信任一个 CA 文件（`transport.tls.trustedCaFile`）。只给本机试用和端到端用，对着 Caddy 自己的 CA。                                                                                                                                                                                                                                                                                           |
| `T3X_TEST_TICKET_LIFETIME_SECONDS`                                  | 仅测试：ticket 的寿命，1–86400 秒的整数，其他值一律用默认的 24 小时。注册表也拒绝 `exp - iat > 86400` 和 `iat` 超前当前时间 300 秒以上的 ticket。                                                                                                                                                                                                                                                       |
| `T3X_DATA_DIR`、`T3X_COMPOSE_FILES`、`T3X_PROJECT`、`T3X_SITES_DIR` | `setup.sh` 和 `./t3x` 的本地试用开关（`T3X_COMPOSE_FILES` 也用来选宿主机网络的覆盖文件，`T3X_SITES_DIR` 是别的网站的站点文件目录），见 `infra/self-host/README.md`。`setup.sh` 把项目名和 compose 文件写进数据目录的 `.env`（`COMPOSE_PROJECT_NAME`、`COMPOSE_FILE`，文件路径相对 `infra/self-host`），所以在那个目录里直接运行 `docker compose …` 操作的就是装好的那一套；显式的 `-p`、`-f` 仍然优先。 |
| `T3CODE_PUBLIC_URLS`、`T3CODE_PUBLIC_URLS_FILE`                     | 旧的公网地址方式。                                                                                                                                                                                                                                                                                                                                                                                      |

### 测试

- `vp run fork:selfhost:test`：`node --test "infra/self-host/registry/*.test.mjs"`，必须用通配符，传目录在 Node 24 和 26 上都会失败。Node 24 镜像里同样通过。
- `vp run fork:selfhost:e2e`：本机端到端，15 个设备配对的场景，约 3–4 分钟。需要 Docker Desktop；frpc 来自 `release/fork-cache/`（归档按固定摘要校验，没有就下载；离线时 `--frpc-path <文件>`，它不做摘要校验）。用法：`vp run fork:selfhost:e2e [--port 18443] [--project t3x-e2e] [--frpc-path <文件>] [--keep] [--only 1,2,4,15]`（参数直接跟在后面，不要加 `--`）。`--only` 只跑列出的场景，写某一个场景时用；有依赖的场景要把它依赖的也列上。场景 17 是模块图抓取时间的测量（见下面「远程环境的 localhost 转发」），只有 `--only` 点名时才跑，`vp run fork:selfhost:first-paint` 就是 `--only 1,2,4,17`。
  - 它起 `infra/self-host` 的测试栈（compose 项目 `t3x-e2e`，只发布在 `127.0.0.1:<port>` 和 `[::1]:<port>`），用这个 checkout 的 `apps/server/src/bin.ts` 起 A、B、C 三台"电脑"（各自一个临时 home、空闲端口、`NODE_EXTRA_CA_CERTS` 和 `T3X_TUNNEL_CA_FILE` 指向从 Caddy 容器取出的根证书），"本机 owner"会话用 `--bootstrap-fd` 传随机 token 再走真实的 `POST /oauth/token`，手机是一个 Node 脚本（shared 协议库，私钥只在内存里）。不写钥匙串、不碰 `~/.t3` 和 fork 的真实 home。
  - 端口默认 18443，被占就换一个空闲的；`--port` 指定且被占则报错。`docker-compose.test.yml` 自己写死了 18443，换端口靠脚本写在临时目录里的覆盖文件，不要改仓库里的那个。
  - 只停自己启动的 PID，结束（含失败、Ctrl-C，和 `compose up` 进行中被中断）时 `compose down -v` 并删临时目录；清理在 `up` 之前就登记好，项目名被别人占着时则拒绝启动、不会去 `down` 它。`down -v` 失败时打印 stderr、项目名和手动清理的命令，保留工作目录，整个脚本以非零退出，即使场景全部通过。失败时保留日志目录并打印路径，`--keep` 通过时也保留。
  - 等待只靠事件（进程日志行、`devices.subscribe` 的快照），没有事件可等的才用有总时限的重试。场景执行顺序是 1,2,3,4,5,9,6,8,12,11,13,18,7,10,14（18：CLI 移除手机，A 的 server 自己关掉那部手机已打开的 socket，要等一次 60 秒同步）：7（移除 B）必须在 10（重启 Caddy）之前，否则断言的 404 会变成握手失败，原因见设计文档 7.2；15、16 要用 B，所以在 7 之前。
- 桌面界面的端到端要在 Electron 里做（`test-t3-app`），本机的坑：
  - 隔离的 `HOME` 下首次用到系统钥匙串会卡在 `SecItemAdd` 的授权弹窗里，主线程被阻塞，Chromium 的调试端口随后也不再响应。必须加 `--use-mock-keychain`，不要去点那个弹窗。
  - 渲染层要信任 Caddy 的 CA：用 `--ignore-certificate-errors-spki-list=<该证书的 SPKI 哈希>` 定向信任，不要写系统钥匙串，也不要整体 `--ignore-certificate-errors`。
  - `agent-browser` 附加到 Electron 的调试端口会让它卡住，改用 `--remote-debugging-pipe` 自己说 CDP。
  - 开发模式下切换"网络访问"会让 app 以退出码 75 退出（`DesktopLifecycle.ts` 的 relaunch），等外层的 dev 进程把它重新拉起，不是崩溃。
  - 桌面 dev 的内置 server 不注册 `Replay (dev)`，所以不能把默认模型换成它；端到端里不建对话就不会花钱。
  - 开发版的桌面端没有 DMG 里内置的 frpc（只有打出来的包才有 `Contents/Resources/bin/frpc`）。照上面的步骤加入服务器后，这台电脑会显示"外网不可达"，server 日志报 `frpc was not found`。先给这台电脑的 T3 home 装一份：在 worktree 根目录运行 `node apps/server/src/bin.ts devices tunnel install --base-dir <这台电脑的 T3 home>`（下载有 SHA-256 校验；要走镜像就先设 `T3X_FRP_BASE_URL`），装好后隧道在下一次重试时自己连上。桌面后端会自己把 `T3X_FRPC_PATH` 设成 `<resourcesPath>/bin/frpc`，所以在启动 Electron 的环境里设这个变量没有用；没有 UI 的 server 才可以直接设 `T3X_FRPC_PATH`。
  - Docker 里的栈用 `*.t3.localhost`，渲染层需要 `--host-resolver-rules="MAP *.t3.localhost 127.0.0.1"`。

### 公网地址（Advanced）的实现要点

- 公网地址的规范化、环境变量名、文件格式和桌面 bridge 类型放在 `packages/shared/src/selfHost.ts`，只接受不带路径的 `https://` origin。`environment/PublicUrls.ts` 合并 `T3CODE_PUBLIC_URLS` 和保存的文件（默认 `<stateDir>/public-urls.json`，可以用 `T3CODE_PUBLIC_URLS_FILE` 指定），每次读取 server config 时重新读文件，增删地址不用重启。`DirectEndpoints` 把这些地址上报为 `"public"`，排序沿用 `ROUTE_KIND_RANK`（局域网和 tailnet 优先，然后是 public，最后是 relay）。
- CLI：`--public-url`（可重复，替换保存的列表）和 `--clear-public-urls`，`serve`、`start`、默认命令和 `up` 都能用。`t3 pair --base-url` 先用 descriptor 确认地址指向的是这台 server，再打印二维码。
- 认证限速：`auth/AuthAttemptLimiter.ts` 是一个全局 HttpRouter middleware，作用于会消耗配对码的三个端点（`POST /oauth/token`、`POST /api/auth/browser-session`（只统计 401）、`POST /oauth/mcp/decision`（统计 400，因为 MCP 批准页把错误配对码也报成 400）），再加设备通行证端点。按客户端分桶：主监听口有 `X-Forwarded-For` 时取最右一项，否则用 socket 地址，loopback 又没有转发头的请求（桌面 bootstrap、本机 CLI）不计数；隧道监听口的桶是 Caddy 写入的 `X-T3x-Client-IP`，主监听口永远忽略这个头。每个客户端 1 分钟内失败 20 次只锁它自己 60 秒，期间返回 429 和 `retry-after`；最多跟踪 10,000 个客户端。配对码 60 位、一次性、5 分钟过期，所以限速只挡噪音，不是防暴力破解的手段。
- 桌面：隧道命令存在 `self-host-tunnel.json`，由 `selfHost/ManagedTunnel.ts` 托管：用登录 shell 运行，退出后指数退避重启（1 秒起，最长 60 秒），关闭开关或退出应用时停止整个进程组。只有本机渲染进程的 `window.t3xSelfHostBridge` 能访问它，没有任何 RPC 入口。

## 手机新建浏览器标签页

手机上可以自己新建 Browser 标签页，打开宿主机上的页面。页面在宿主机的 headless Chrome 里渲染，手机只收 JPEG 帧（server 已有的 `/api/preview-stream`），所以 `localhost` 指宿主机，也没有 Android cleartext 和 mixed content 的问题。除下面"首次使用"的安装进度外，不改 server 和 contracts；原生 WebView 直连 dev server 涉及同源安全，没有做。用户说明在 `docs/user/remote-access.md` 的 "Browser on a remote environment"。

- 面板：`apps/mobile/src/features/browser/NewBrowserTabPanel.tsx`，嵌在 `BrowserPreviewRouteScreen` 里（路由参数 `newTab`），不是单独的路由。地址规范化和本地服务列表是纯函数，在 `newBrowserTab.ts`：复用 shared 的 `resolveAddressBarInput`，但不回落到搜索；本地服务列表订阅 `previewEnvironment.discoveredServers`，带上项目脚本的 Preview URL。
- 选中哪个标签页、新建模式、等待刚打开的标签页：纯函数在 `browserTabSelection.ts`，计时器和关闭事件订阅在 `useBrowserTabSelection.ts`。`preview.open` 返回的标签页最多等 10 秒（`PENDING_BROWSER_TAB_TIMEOUT_MS`），超时或收到它的 `closed` 事件就停止等待并提示"标签页没有打开"，然后按常规处理：没有标签页就关闭浏览器，有就显示最新的。
- 入口：Android 对话页标题栏的地球按钮（`ThreadHeader.tsx` 的 `onOpenNewBrowserTab`，只在 `capabilities.serverBrowser` 时传）；浏览器标题栏的 "+"（两个平台都有）。iOS 对话页标题栏走原生 header item，没有加入口。
- 权限：`previewEnvironment.open.permissionAtom`（`preview:operate`）。没有权限时入口照常显示，面板里说明原因并禁用输入。
- 首次使用时宿主机还在下载 headless 浏览器：`attachViewer` 先用 2 秒的短等待问 `PreviewBrowser.executableWithin`（`ServerBrowser.ts` 的 `awaitHeadlessBrowser`，只对还没打开、走 headless 的标签页），因为 `executable` 会为安装等 45 秒，比手机 15 秒的连接窗口还长。安装中就以关闭码 4504 收尾，reason 是 `{downloadedBytes,totalBytes,unpacking}` 的 JSON（`packages/contracts/src/forkPreviewInstall.ts`）。客户端（`serverBrowserStream.ts`）显示"正在安装浏览器：x / 105 MB"，每 3 秒重连一次，装好后第一帧到达就自己连上，不算失败也不走 `onUnauthorized`。手机收到后停掉 15 秒的启动计时器。旧客户端遇到 4504 按普通断线退避重连；旧服务端仍是 503，行为不变。
- 推流：手机请求 `quality=60`（server 默认 70）。帧尺寸本来就按视图像素（最多 2x）封顶，没有再改。`PreviewStreamTarget` 加了可选的 `quality`（`packages/client-runtime/src/preview/serverBrowserStream.ts`）。
- i18n：`apps/mobile/src/hooks/useT.ts` 写法同 web，语言设置见上文"多语言"。译文在 `catalogs/zh-Hans/mobileBrowser.ts`；`i18n:report` 也扫描 `apps/mobile/src` 了。

上游文件里的接线（都带 `// fork:`）：`ThreadHeader.tsx`（prop 和 Android 按钮）、`ThreadRouteScreen.tsx`（按 `serverBrowser` 传回调）、`PreviewStreamWebView.tsx`（`PHONE_STREAM_QUALITY`）、`serverBrowserStream.ts`（`quality`）。`BrowserPreviewRouteScreen.tsx`（`newTab` 参数、改用 `useBrowserTabSelection`、"+"、几处 `t()`）、`scripts/i18n-report.ts`（扫描 `apps/mobile/src`）。

## 产出

每条回复结束后，末尾列出这一轮产出的文件和链接；对话头部（web）或标题栏（手机）有"产出"入口，列出整个对话的产出。参考 Alma。不额外调用模型：识别全在客户端，不改 server 和 contracts。

- 识别：`packages/client-runtime/src/outputs/`，web 和 mobile 共用。以一轮（run）为单位，只在 run 结束（completed / interrupted / failed / cancelled）后计算。文件按"回复里 markdown 链接到的本地文件 → 工具写过的文件（`file_change`、检查点）"排序，删除操作和 `node_modules`、`.git` 下的不收；链接取自回复文本和命令输出，命令含 `ssh`、`ss`、`netstat`、`lsof`、`nmap`，或一条输出里有 4 个以上不同的 URL 时跳过这条命令的输出（回复里的 URL 不限）。整个对话合并后按路径、URL 去重，新的 run 排前面。命令输出被 server 省略（`outputOmitted`）时不读，否则列表会随展开而变。
- 缓存：`threadDetail.ts` 里的 `outputsAtom` / `runOutputsAtom`。只随对话结构和检查点变化，流式文本不会触发；每个 run 的结果按条目身份缓存，没变的 run 保持同一个对象，所以结束一轮时只有这一轮的条带重渲染。
- 工作区外的文件（`/tmp`、下载目录）照样列出，但不能预览：server 只读 `KnownWorkspaces` 里的路径，也没有加按任意路径读文件的接口。
- web：`apps/web/src/components/chat/outputs/`。消息条带在 `TimelineAssistantRows.tsx` 里 `showAssistantMeta` 时渲染，与 `ChangedFilesCard` 并列；头部按钮在 `ChatHeader.tsx`，数量为 0 时不渲染。"用默认应用打开"和"在访达中显示"只在桌面版、且当前环境就是桌面内置的 server（`hostEnvironmentIdAtom`）时出现，走已有的 `shell.openInEditor`（`file-manager`），没有新增桌面 IPC；远程环境的 server 会在另一台机器上打开文件，所以不提供。
- mobile：`apps/mobile/src/features/outputs/`。消息条带在 `ThreadFeed.tsx`，列表页是路由 `ThreadOutputs`（`threads/:environmentId/:threadId/outputs`），入口是 `ThreadHeader.tsx` 的"产出"按钮（数量为 0 时不出现；标题栏动作没有角标，数量写在无障碍标签里）。工作区内的文件走已有的 `ThreadFile` 路由预览，链接用系统浏览器打开，文件和链接都能复制。
- 译文：`catalogs/zh-Hans/outputs.ts`。

## 上下文圆环与输出速度

输入框底部、回形针和发送按钮之间常驻两个东西：上下文用量圆环（点开：用量、自动压缩点、上一轮速度、"立即压缩"），和一个"约 xx tok/s"标签（点开：总用时、首字延迟、输出 tokens）。参考 Alma 和 DeepSeek Harness，不改 server 和 contracts。

- 计算在 `packages/client-runtime/src/state/`：`turnSpeed.ts`（速度）、`contextWindow.ts` 里的 `deriveThreadContextMeter`、`compactNowBlocker`、`hasCompactableConversation`，web 和 mobile 共用。百分比和 80%/90% 的色阶与"对话详情"里的 Context window 行一致，没有窗口大小时不画。
- 速度口径：输出 token 只读 `providerTurn.turnTokenUsage`（每个 adapter 按本轮汇总，`usageStatus` 为 `complete` 才用），不读线程级的 `tokenUsage`：它是上下文快照，Claude 里的 `outputTokens` 只是最后一条消息，Pi 里是整个会话的累计。Pi 和没有声明本轮用量的 ACP 类 provider（Grok、Kiro、fx，以及除 GLM 外的 ACP Registry）没有这个字段，所以不显示，绝不显示 0。Muse 能显示：它在 `turn/completed` 带 usage 时写入 `complete` 的本轮用量，不带时不显示。解码时长是本轮 `assistant_message` 和 `reasoning` 条目 `startedAt` 到 `completedAt` 的并集（先裁剪到本轮的开始和结束之间，空的或逆序的区间丢弃），减去工具、审批和等待用户输入的条目占用的时间；不足 0.5 秒的不算（整段一次性到达的回复没有速度可言）。首字延迟是第一个输出条目的 `startedAt` 减本轮开始时间。因为是近似，界面带"约"。
- 只在一轮结束后更新：取最近一个已完成且有数据的轮次，生成中的轮次不影响结果。计算在 `threadDetail.ts` 的三个 atom（`contextMeterAtom`、`contextRingAtom`、`lastTurnSpeedAtom`）里，值相同就保持同一个对象；速度只在已完成且有用量的轮次集合变化时才扫描条目（`createLastTurnSpeedSelector`）。圆环只订阅取整后的百分比和色阶，弹层才订阅完整数字，所以流式输出和用量上报都不会重渲染输入框；web 和 mobile 的组件自己订阅，不经过 `ChatComposer` 的 props。
- "立即压缩"发的是和手动输入 `/compact` 完全一样的消息：web 走命令面板那条 `onCompactContext`（`sendStandaloneCommand("/compact")`），mobile 走 `enqueueThreadOutboxMessage`，都不加 RPC。是否可点只由 `compactNowBlocker` 决定（断线、没权限、provider 没有 `compact` 斜杠命令、没有可压缩内容、运行中或刚开始运行、有排队的消息、有待处理的请求），web 在 `ChatView.tsx`、mobile 在 `use-thread-composer-state.ts` 各自喂入状态；按下时再算一次，不通过就不发。置灰的原因直接写在按钮下方，不用悬停。mobile 有在途锁，连点只排一个 `/compact`。
- 布局：web 在 `ChatComposer.tsx` 底部一行（`ComposerContextMeter.tsx`），窄于 620px（`isComposerFooterCompact`）时速度标签隐藏、圆环不带百分比；录音占用底栏时也只留圆环。圆环和速度标签悬停（300ms）或点击都能打开弹层。mobile 在 `ThreadComposer.tsx` 工具栏的模型控件前，点开是输入框上方的卡片（样式同 `/usage-limits`）；速度标签只在平板的展开状态下显示，手机上只在卡片里。
- 译文：`catalogs/zh-Hans/contextMeter.ts`。

上游文件里的接线（都带 `// fork:`）：`TimelineAssistantRows.tsx`、`ChatHeader.tsx`、`ChatView.tsx`（传 `workspaceRoot`）、`threadDetail.ts`（两个 atom）、`ThreadFeed.tsx`、`ThreadHeader.tsx`、`ThreadRouteScreen.tsx`、`Stack.tsx`、`catalogs/zh-Hans/index.ts`、`packages/client-runtime/package.json`（`./outputs/*` 导出）。

## Codex 自定义端点下读订阅额度

上游 #18622 之后，Codex 配置里 `openai_base_url` 或自定义 `model_provider` 指向非 OpenAI 原生地址（`api.openai.com` / `chatgpt.com`）时不再调用 `account/rateLimits/read`，用量显示 `unsupported`。本机 magpie 把 `~/.codex/config.toml` 的 `openai_base_url` 指向 `http://127.0.0.1:3425/backend-api/codex`，网关最终仍走 ChatGPT 订阅，于是 Codex 额度整个消失。

- Codex 实例设置里加了 `readLimitsThroughCustomEndpoint`（`packages/contracts/src/settings.ts`，开关，默认关，设置 > 提供商 > 该 Codex 实例里）。打开后 `codexRoutesSpendNativeQuota`（`CodexProvider.ts`）跳过"是不是原生路由"的判断，其余条件不变：登录必须是 ChatGPT 账号（API key 或要求登录但没登录都不读），读取失败照常降级成 `probeFailed`。不改实际路由，也不改 `auth.endpoint` 的展示。
- 开关只管读额度这一件事，所以没有额度可读的端点（真正的第三方代理）别打开，否则会显示一条读失败的提示。
- 手机端没有 Codex 实例设置页，开关只在 web / 桌面设置里；额度由 server 发布，手机照常显示。
- 上游文件里的接线都带 `// fork:`：`settings.ts`、`CodexProvider.ts`（`probeCodexAppServerProvider` 入参、`checkCodexProviderStatus` 入参）。译文在 `catalogs/zh-Hans/settingsPanels.ts`。

## omp provider

omp（oh-my-pi，Pi 的分支）是原生 provider，和上游的 Pi 并存。用户说明 `docs/user/providers-omp.md`，设计要点在下面几条（上游的 `providers.md` 已精简，fork 加的 omp 段随之删除）。ACP Registry 里的 omp 入口没动。

- **复用而不是复制：** omp 的 RPC 与 Pi 同源，所以走 Pi 的 adapter，差异做成 `PiDialect`（`packages/provider-pi/src/server/dialect.ts`：driver 种类、能力表、启动参数、连接工厂、是否汇总本轮 usage）。fork 自己的代码全在新包 `packages/provider-omp`：`protocol.ts` 是 omp 帧与命令到 Pi 形状的翻译（纯函数，有单测），`connection.ts` 包住 omp 进程并用 `set_host_tools` 暴露 T3 的 MCP 工具，`dialect.ts` 管启动参数和审批模式映射，`status.ts` 探测版本、模型和命令。
- **上游文件里的接线（都带 `// fork:`）：** `packages/provider-pi/src/server/adapter.ts`（读 `options.dialect`，在 `makePiAdapterV2` 开头用同名局部常量盖住 `PI_PROVIDER`、能力表、启动函数，另有按 dialect 汇总的 `turnTokenUsage`；`PiProviderCapabilitiesV2` 加了 `export`）、`provider-pi/package.json`（多导出几个子路径）、`builtInDrivers.ts`、`managedProviders.ts`、`settingsSecrets.ts`、`providerClients.ts`、`ProviderRegistry.ts`（omp 和 Pi 一样按鉴权状态保留模型）、`model-manifest.json`（omp 条目，`updatedAt` 已更新）、contracts 的 `model.ts` 和 `settings.ts`（显示名、默认关闭）、`ProviderModelsSection.tsx`、`customModelEditor.logic.ts`、`catalogs/zh-Hans/settingsPanels.ts`、根 `package.json` 的 knip 工作区列表、`scripts/release-smoke.ts`。同步上游时 `adapter.ts` 里 `PI_PROVIDER` 的局部覆盖最容易在新增用法处出问题：新代码若在闭包外用它，会拿到 Pi 的值。
- **审批、MCP、会话：** 审批是 omp 自己的（`--approval-mode`：Supervised → `always-ask`，Auto-accept edits → `write`，Full access → `yolo`；`--approval-mode`、`--yolo`、`--auto-approve` 等写进启动参数会被拒绝）。omp 的审批弹窗是 `select`（标题 `Allow tool: <名字>`），选项没有 id，回传的就是标签文字。翻译层把它改成 Pi adapter 认得的 `confirm`，按语义（大小写和空白不敏感）找出"批准一次"、"本会话批准"和 `Deny`，与选项顺序无关。原则是拿不准就取消：每个选项都必须是 omp 发过的文案（批准一次、`Approve <标题里完整的工具名> for this session`、`Deny`，以及认得但永不选择的更宽授权 `Approve Directory: …`、`Always …`、`Approve File`）；出现任何别的选项、别的工具名的会话选项、缺批准或缺否决、重复，或者有更宽授权却没有 `Approve Once`（此时普通的 `Approve` 可能就是范围授权），都直接给 omp 回 `cancelled`（omp 当拒绝）并在回合里报一条错误通知。工具名取标题第一行 `Allow tool: ` 之后的整行，可以带空格。"像审批"的判定先把标题和每个选项做 NFKC、去首尾空白、折叠空白、转小写，再看：标题里任意位置有 `allow tool`，或者任何选项是 `Deny`/`Approve…`/`Always Approve…`，就算像审批（全角字母、前导空白、选项只是 Yes/No 都挡得住）。omp 的审批文案只有英文，不做本地化白名单；以后若有别的语言，宁可取消也不去猜。像审批却解析不了（标题不是严格的 `Allow tool: <名>`、有非字符串选项、没有选项）的 select 一律取消并通知，不会当普通 select 原样转给 adapter（否则用户的选择会不经检查回传给 omp）。"Allow for session" 经 dialect 的 `forwardsSessionApproval` 让 adapter 在回答里带上 `forSession: true`，翻译层据此回 omp 自己的会话选项；omp 没给会话选项时只批准一次，并发一条警告通知（`takeNotices`，由 `connection.ts` 推给 adapter）。这条通知的英文原文在 zh-Hans 的 `chat.ts` 里有译文，web 和手机的系统通知标签（`workEntryDisplayLabel`、`workEntryRowLabel`，带 `// fork:`）只在标签原文恰好等于 `packages/shared/src/forkNotices.ts` 里登记的 T3 自拟通知时才查 catalog（`translateForkNotice`），agent 或用户的内容即使碰巧等于某个 catalog key 也不会被误译；新增这类通知要同时登记到那个集合；其他 T3 自己拼的服务端通知（取消和错误通知里带工具名和选项的）仍是英文。MCP 走 omp 的 host tool 子协议，名字沿用 `mcp__t3-code__…`，T3 编排说明用 `--append-system-prompt` 追加。会话用 omp 自己的会话文件：`--resume <文件>`、`switch_session`、`get_entries`，omp 的 `message` 条目和 Pi 同形。**分叉和回滚：** adapter 的显式分叉先用 CLI `--fork <源文件>` 把整个会话复制进目标 cwd（omp 的参数解析器认这个参数，只是 `--help` 不列，真实 omp 18.20.3 上实测会在目标 cwd 的会话目录里建新文件、源文件不动），再用 RPC 在轮次边界截断。截断必须用 `branch{entryId}`，不能用 `fork{entryId}`：Pi 的 `fork` 在该条目**之前**截断，omp 的 `fork` 却**保留**该条目，只有 `branch` 与 Pi 同义（同样返回条目文字），所以翻译层把 `fork` 改成 `branch`，回滚走同一条路径。
- **必须用 `--mode rpc`：** 在 `rpc-ui` 里 `set_host_tools` 成功、`get_state` 也列出了工具，但 omp 不把它发给模型（用一个本地桩模型服务记录请求的 `tools` 数组证实过），所以 T3 的 MCP 工具只能用 `rpc`。代价是 omp 自带的 `ask` 工具只在 `rpc-ui` 里有，用不了；扩展的 `select`、`confirm`、`input`、`editor` 对话框不受影响。以后 omp 修了再换。
- **能力取舍：** 不支持子 agent（omp 的 `task` 工具当普通工具调用显示）、扩展状态文字（客户端的横幅写死了"Pi ·"，dialect 的 `showsExtensionStatuses: false` 把它挡掉）、文本生成（`supportsTextGeneration: false`）、用量页和从 `~/.omp` 导入会话。没有 Pi 那样的服务层级选项。`clear_queue` 在 omp 里不存在，翻译成 `abort_and_restore_queue`（会顺便中止，调用方随后本来就要中止）。omp 的"无可压缩"（`skipped`）保留为一次正常完成的压缩，说明文字用 omp 自己的，不显示成失败。`--fork`（含 `=` 写法）也被 T3 占用，显式分叉时由它自己追加。启动参数里被 T3 占用的短参数（`-c`、`-r`、`-p`、`-h`、`-v`）连 `-r=x`、`-rx`、`-cr` 这些写法也会被拒绝。omp 的会话文件第一行是 `title`，cwd 在第二行的 `session` 记录里，所以 `PiDialect.readSessionCwd`（omp 的实现是 `readOmpSessionCwd`）读开头 8 行、找 `session` 记录；dialect 提供了读取函数却读不到 cwd，就当成"记录在别处"走 `--fork`，不会在旧 checkout 里继续。Pi 没有读取函数，仍只看第一行。只有提供了读取函数的 dialect（omp）才限制只读文件开头的 64 KiB（`SESSION_HEADER_MAX_BYTES`），一行不带换行的超长损坏文件不会被整份读进来，读不到 cwd 的 omp 会话走分叉；Pi 仍和上游一样完整读首行（合法的 Pi 首行超过 64 KiB 时，cwd 在后面也读得到）。cwd 的比较也变了：记录的 cwd 和当前 cwd 先各自规范化（`realPath`，目录不存在就退回 `path.resolve`，去掉尾部斜杠），仍不等时再比文件身份（`stat` 的设备号和 inode），这样符号链接、尾部斜杠、大小写不敏感卷上的另一种大小写都算同一个目录，大小写是否折叠由文件系统回答，不按平台猜。这对 Pi 是更正确的同类规范化：以前只把当前 cwd 做了 `realPath`。
- **测试：** `protocol.test.ts` 和 `hostTools.test.ts` 是纯函数；`adapter.test.ts` 用真实录下来的 omp 帧经完整 adapter 回放；`connection.test.ts` 覆盖 host tool 往返；`live.test.ts` 在 `OMP_LIVE_AGENT_DIR` 指向一个 omp 配置目录时才跑，用真实 omp 和真实模型跑普通回合、审批回合和 host tool 回合（环境变量不能以 `T3` 开头，`vp test` 会把它们过滤掉）。

## 不依赖 Google 的推送（Android）

手机通过任意 UnifiedPush 服务器（典型的是 VPS 上的 ntfy，部署包见 `infra/self-host/`）收到 Agent 提醒，不经过 Cloudflare、Firebase 和 Clerk。上游的 relay 和 FCM 路径没有改动，仍然关闭。用户说明在 `docs/user/mobile-notifications.md` 的 "Push without Google"。

流程：

1. 手机用 UnifiedPush 官方连接库（`org.unifiedpush.android:connector`）向本机安装的推送应用（如 ntfy）注册，拿到 endpoint 和 Web Push 公钥（p256dh、auth）。
2. 手机通过 `push.register` 把这份注册发给每一个已配对的环境；endpoint 变了就再发。移除环境、关闭环境前先调 `push.unregister`（`useConnectionController.ts`）；环境撤销这台设备的会话时，服务端自己删掉这个会话的注册。一份 endpoint 在所有环境之间共用，每个环境只为自己的线程推送。
3. 环境服务端用 RFC 8291（aes128gcm）加密载荷，POST 到 endpoint；404 或 410 就删除注册。推送服务器只经手密文。
4. 手机上的 `PushService` 由连接库解密，用 Kotlin 原生代码显示通知，JS 运行时不需要在运行。点通知打开对应线程（和上游通知同一条 deep link）。

决定：

- **触发条件**复用 relay 的规则，不另起一套：事件过滤复用 `AgentAwarenessRelay.shouldPublishAgentAwarenessEvent`，状态用 `projectThreadAwarenessV2`，按 relay 的 `agentActivityAlerts.ts` 只对"进入"需要批准、需要输入、完成、失败这几个阶段提醒，完成先等 5 秒确认没有后续，已完成超过 2 分钟的不提醒，子 agent 和侧聊不提醒，每台设备有自己的开关（`push.register` 里的 `preferences`）。服务端启动或首个设备注册时，已经在等待或完成的线程只记基线，不提醒。
- **语言**放在手机上：服务端只发数据（类型、线程标题、项目、环境标签、id），手机上的 JS 在启动和每次界面语言变化时，把翻译好的模板（`pushTemplates.ts`，走 `t()` 和 zh-Hans 目录）交给原生接收器存起来，接收器填入标题后显示。这样翻译只有一份目录，应用没运行时也按手机当前界面语言显示，切换语言后马上生效。
- **VAPID 不做**：UnifiedPush 的 endpoint 本身就是写入凭据，ntfy 对 `up*` 主题允许匿名写；连接库要求 VAPID 公钥时才需要，我们没传。伪造的推送因为无法用手机的密钥加密，会被连接库丢弃（`decrypted=false` 不显示）。
- **fork 状态**：服务端的注册放在 `ServerSecretStore` 的 `fork-push-registrations`（0600 文件，0700 目录，原子写入），不碰数据库迁移。日志只写主机名。写入先落盘再改内存，写失败就报 `PushRegistrationError(storage)`，内存不变；已结束的会话即使清理没写成功也不会再收到推送。手机端 endpoint 只在内存里，设置页只显示主机名。

- **只推公网地址**（防 SSRF）：endpoint 是已配对设备给的，所以服务端只向公网单播地址 POST。`pushAddress.ts` 是范围表，拒绝回环、未指定、链路本地（含 169.254.169.254）、RFC 1918、CGNAT 100.64/10（Tailscale）、IPv6 ULA 和链路本地、多播、保留和文档地址、本机网卡地址，以及 IPv6 里嵌着的上述 IPv4（mapped、compatible、NAT64、6to4）。写出来的 IP 在注册时和发送前都查；域名由 `pushTransport.ts` 在 undici 连接自己的 DNS lookup 里解析全部 A/AAAA，任何一个不是公网就拒绝，所以 DNS rebinding 钻不了检查和连接之间的空子。主机名照常用于 SNI 和 Host。只看状态码，响应体立即销毁，不跟随重定向，连接超时 5 秒；不走代理，否则代理自己解析，检查就失效了。`T3CODE_PUSH_ALLOW_INSECURE_ENDPOINTS=1` 只给本机开发和集成检查用：只在开发运行（`ServerConfig.devUrl` 有值）里生效，生效时启动日志有一条“SSRF 防护已关闭”的警告；打包版里设了也忽略，并记一条警告。
- **RPC 模式**：`push.register`、`push.unregister`、`push.sendTest` 在 `CLIENT_GUARDED_RPC_SCOPES` 里（范围 `orchestration:read`，每台设备只管自己的注册，通知只含这台设备本来就能读的内容），手机用 `createEnvironmentRpcCommand`（`fork/push/pushCommands.ts`）；`push.status` 是普通读。

位置：服务端 `apps/server/src/fork/push/`，契约 `packages/contracts/src/forkPush.ts`（`push.*` 四个 RPC），手机 `apps/mobile/src/fork/push/` 和原生模块 `apps/mobile/modules/t3x-unified-push/`。端到端检查用 `apps/server/scripts/verify-ntfy-push.ts`（需要本机的 ntfy 容器，用法见脚本头部）。

上游文件里的接线（都带 `// fork:`）：`connection/registry.ts`（把目录绑给设备索引）、`contracts/index.ts` 和 `rpc.ts`（并入 RPC 组）、`RpcAuthorization.ts` 和 `RpcInstrumentation.ts`（权限和指标表）、`ws.ts`（handler）、`server.ts`（layer）、`AgentAwarenessRelay.ts`（导出事件过滤）、`App.tsx`（安装注册同步）、`clientRpcPermissions.ts`（受保护的写入）、`androidNotifications.ts`（正在查看的线程不提醒）、`useConnectionController.ts`、`SettingsNotificationsRouteScreen.tsx`、`zh-Hans/index.ts`。

新增原生模块和 Maven 依赖会改变 Android 的 native fingerprint（iOS 不变），之后要重新 `mobile:install` / 重新打 APK。

## 远程环境的 localhost 转发

完全照上游：桌面版为其他环境打开的标签页、端口转发、手机的"在本设备打开"都走上游的预览隧道（`/api/preview/tunnel`，桌面端 `apps/desktop/src/preview/LoopbackTunnel.ts`）。宿主机上任何回环端口都能转发，只有 server 自己的端口被上游拒绝；要关掉，在宿主机的 设置 → 共享与访问 → 预览隧道 里关。fork 以前的网关（按"谁起的进程"授权、手动放行卡片、自己的代理和票据）和之后的排除名单（调试端口、调试进程、T3 自己的进程）都已退役（2026-11-21，用户决定），上游文件不留挂钩。

fork 只保留一处修复：**时钟偏差**。上游 `packages/client-runtime/src/state/previewTunnel.ts` 判断票据还能不能复用时，拿环境报的过期时间直接和本机时钟比；两边时钟差几分钟时，一边会一直复用过期票据（隧道全部失败），另一边每条连接都重新签票据。fork 改成按本机时钟算（`src/fork/previewTunnel/ticketExpiry.ts`：收到时刻加服务器给的寿命，限在 30 秒到 5 分钟之间，服务器给的时刻已经过去就按 5 分钟）。web 和手机共用这段。

**一小时后 UNAUTHORIZED** 那个 fork 修过的问题不用搬：上游每次连接都用当前的会话凭据新签 media 票据。服务端隧道随会话 `awaitInvalidation` 关闭，fork 在 `SessionStore` 里的 `renewalOf` 让它跟着每小时的续期走，不会在续期时误关。

**老用户的残留数据。** 以前放行的端口记在 `<stateDir>/loopback-gateway-allowed-ports.json`，现在没有代码读它，启动不受影响，可以手动删；web 的"停止转发"记在 localStorage，同样不再读。

## 打包与签名

### 发布（GitHub Actions）

正式的安装包都由 `.github/workflows/fork-release.yml` 在 GitHub 托管的 runner 上构建，发布到 `SimpleEve/t3-extend` 的 Releases。本机两条命令（下一节）还在，用来本地验证或应急。

**发版本照 [deploy/release.zh-CN.md](deploy/release.zh-CN.md)**（英文版 [release.md](deploy/release.md)）：版本和 tag 规则、发布前检查、写中英双语更新说明、打 tag、发布后检查、测试构建、构建失败怎么办，都在那里，这里不再重复。

workflow 先构建所有产物，全部传上去之后才把 release 从草稿改成正式发布并标为 latest。产物：

| 产物                                                 | runner             | 说明                                                                                                           |
| ---------------------------------------------------- | ------------------ | -------------------------------------------------------------------------------------------------------------- |
| `t3-<版本>-darwin-arm64.tar.gz`                      | `macos-15`         | `t3x` 命令行，ad hoc 签名                                                                                      |
| `t3-<版本>-linux-x64.tar.gz`                         | `ubuntu-24.04`     | 同上                                                                                                           |
| `t3-<版本>-linux-arm64.tar.gz`                       | `ubuntu-24.04-arm` | 同上                                                                                                           |
| `SHA256SUMS`                                         | release 任务       | 只含上面三个归档，格式 `<sha256>  <文件名>`                                                                    |
| `T3-Extend-<版本>-arm64.dmg`（附 `.sha256`）         | `macos-26`         | `fork-dist-mac.ts` 的流程，用 fork 自己的自签名身份签名                                                        |
| `T3-Extend-<版本>-arm64.zip`、`latest-mac.yml`       | `macos-26`         | 同一个已签名的 app 打成 zip（Squirrel.Mac 从它安装），`latest-mac.yml` 点名它；供桌面自更新，不是给人下载的    |
| `T3-Extend-<版本>-x64.exe`（附 `.sha256`）           | `windows-2025`     | `fork-dist-win.ts` 的流程，NSIS 安装包，**不签名**（没有 Windows 证书）                                        |
| `T3-Extend-<版本>-x64.exe.blockmap`、`latest.yml`    | `windows-2025`     | electron-builder 生成，桌面自更新用                                                                            |
| `T3-Extend-<应用版本>-arm64-v8a.apk`（附 `.sha256`） | `ubuntu-24.04`     | `fork-build-android-release.ts` 的流程；文件名里是移动端应用版本（上游移动端版本加 fork 后缀，如 `2.3.0-1.0`） |

Windows 任务在 runner 上用 Rust 1.95.0 先编出 `t3-resource-monitor.exe`，再设 `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR=true` 让打包脚本跳过它自己的 Visual Studio 探测（那个探测要 Spectre 库，runner 上不一定有）。release 任务要等 `exe` 也传完才建 release。

每个 CLI 归档在构建它的那台 runner 上跑 `smoke-cli-archive.ts`（`--expect-version`）。DMG 构建后 workflow 再挂载一次，检查 app 的 designated requirement 含 `certificate root = H"491ecedb…8978"`（`EXPECTED_MAC_CERT_SHA1`）：换了证书的包会让用户重新授权钥匙串，所以不匹配就失败。

**tag 和版本的约束**（完整规则和操作见 [deploy/release.zh-CN.md](deploy/release.zh-CN.md)）：`t3x update` 和服务的更新靠 `newestCliReleaseVersion`：列出 `releases`（按创建时间倒序），跳过草稿，取**第一个**形如 `v<semver>` 且渠道相同的 tag，不比较大小。所以正式 tag 只能是 `v<上游 X.Y.Z>-<fork A.B>`，并且按 semver 必须比已发布的所有 tag 都大，已发布的 tag 绝不移动或复用；`-nightly.`、`-preview.` 是别的渠道，不能用。`scripts/fork-release-version.ts` 在 workflow 开头检查（`fork-release-version.test.ts` 有用例，包括用 `newestCliReleaseVersion` 对一遍）。测试用 `-ci.N` 的 tag 或手动运行，永远是草稿加 prerelease。同一时刻只有一个 release 运行（`concurrency`）。版本号就是 tag 去掉 `v`，构建前 `update-release-package-versions.ts` 把它写进各个 `package.json`。

**更新说明**：每个版本在 `docs/fork/changelog/<版本>.md` 里有 `## 中文` 和 `## English` 两段，release 正文就是它加下载列表。`scripts/fork-changelog-draft.ts`（`vp run fork:changelog`）起草，`scripts/fork-release-changelog.ts` 在 plan 任务里检查：已发布 tag 的文件缺失、含 `TODO` 或缺任一语言就失败，测试构建缺文件时现场起草。桌面版的更新弹窗（`apps/desktop/src/updates/releaseNotes.ts`）只显示与应用语言一致的那一段，没有这两个标题的旧 release 读整段。

**Secrets**（仓库 Secrets，只在 workflow 里通过 `secrets.*` 引用，不进日志）：`T3EXTEND_MAC_CERT_P12_BASE64`、`T3EXTEND_MAC_CERT_P12_PASSWORD`（只含 `T3 Extend Code Signing` 这一个身份的 p12，每次导入临时钥匙串，任务结束删除）、`T3EXTEND_ANDROID_KEYSTORE_BASE64`、`T3EXTEND_ANDROID_KEYSTORE_PASSWORD`（release keystore，PKCS12，store 和 key 同一个密码，alias 是脚本默认的 `t3extend`）。Android 脚本读到环境变量 `T3EXTEND_ANDROID_KEYSTORE_PASSWORD` 就用它，没有才去 macOS Keychain 取（`scripts/lib/fork-android-signing.ts`），本机用法不变。

**没装桌面版的机器**用 `scripts/install-t3x.sh` 装 `t3x`（上游的 `install.sh` 一行不改）：

```bash
curl -fsSL https://raw.githubusercontent.com/SimpleEve/t3-extend/main/scripts/install-t3x.sh | sh
```

它下载当前平台的归档，按 `SHA256SUMS` 校验，解到 `$T3X_HOME/runtime/versions/<版本>/`（`T3X_HOME` 默认 `~/.t3extend`，和 `t3x service install`、`t3x update` 同一个布局，有 `.install-complete` 哨兵），在 `$T3X_INSTALL_BIN_DIR`（默认 `~/.local/bin`）写一个叫 `t3x` 的启动脚本，并把它记进 `runtime/launchers`——`t3x update` 找启动器时只按名字 `t3` 找 PATH，靠这份记录才认得 `t3x`，所以记录不能省。环境变量刻意不用 `T3CODE_*`：用户为官方应用导出的 `T3CODE_HOME` 不能把它带到官方的目录里去。`T3X_HOME` 等于或指向 `~/.t3` 时拒绝；已有的 `t3x` 只有是这个 home 自己的启动脚本才会被替换。`T3X_VERSION`、`T3X_RELEASE_BASE_URL`、`T3X_LATEST_URL` 供测试和镜像使用。`install-t3x.test.ts` 用本地 HTTP 夹具跑真实脚本。

### 本机打包

两条命令，都可以直接重跑：

```bash
vp run fork:dist:mac       # → release/fork-mac/T3-Extend-<版本>-arm64.dmg（附 .sha256）
vp run fork:dist:android   # → release/fork-android/T3-Extend-<版本>-arm64-v8a.apk（附 .sha256）
vp run fork:dist:win       # → release/fork-win/T3-Extend-<版本>-x64.exe（附 .sha256），要在 Windows 上跑
```

`release/` 已在 gitignore 里。Android 命令要先设好上文"Android 开发环境"里的环境变量。

前置条件：

- macOS 签名身份：登录钥匙串里 T3 Extend 自己的自签名身份 `T3 Extend Code Signing`（RSA 2048，keyUsage 只有 digitalSignature，EKU 只有 codeSigning，CA:FALSE，有效期 10 年）。它不借用本机其他项目的证书。换身份用 `--identity` 或 `T3EXTEND_MAC_SIGN_IDENTITY`。
  - 新机器上创建一次：`node scripts/fork-dist-mac.ts --create-identity`。已有同名证书或身份时它会拒绝执行。它在 0700 的临时目录里用系统 `/usr/bin/openssl` 生成密钥和证书，打成 p12，经 `security -i` 的 stdin 导入登录钥匙串（临时口令不进 argv 和日志），只用 `-T /usr/bin/codesign` 给 codesign 访问权，不用 `-A`；用完删除临时目录。中途任何一步失败，都会按 SHA-1 删掉这次创建的证书和私钥，可以直接重跑。
  - **创建时会弹一次钥匙串授权框**：脚本末尾要用新私钥试签一个临时二进制，macOS 会问 codesign 能否使用这把密钥，输入登录密码并点"始终允许"（最多等 10 分钟，之后再试签一次确认不再弹窗，30 秒限制）。原因是 macOS 10.12 之后，光有 ACL（`-T`）不够，私钥的 partition list 还要覆盖 codesign，而改 partition list 需要登录密码，所以让用户在系统弹窗里确认一次。点了"允许"而不是"始终允许"，第二次试签会超时，脚本回滚并报错。第一次试签超时（没人点）同样回滚。所以要在电脑前、交互地跑。
  - **不改信任设置**（改了要系统密码）。没有信任设置时证书只出现在 `security find-identity -p codesigning`（不带 `-v`）里，带 `CSSMERR_TP_NOT_TRUSTED`，codesign 照样能签，`codesign --verify --strict` 也能过。打包脚本的预检按名称精确查找，要求恰好一个、没过期（看证书有效期，也拒绝状态含 EXPIRED/REVOKED 的）。
  - 备份是可选的：身份丢了，只是新包再问一次钥匙串、再授一次权，不会丢数据。要备份就在钥匙串访问里导出这条身份。
- Rust：`native/resource-monitor` 依赖的 `sysinfo` 要求 rustc 1.95，默认 stable 是 1.89。只加装、不改默认工具链：`RUSTUP_DIST_SERVER=https://rsproxy.cn RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup rustup toolchain install 1.95.0 --profile minimal`。脚本用 `RUSTUP_TOOLCHAIN=1.95.0` 从源码编译 resource-monitor（`--rust-toolchain` 可改），并清掉 `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR`。
- Node：系统的 26.5.1 能打出来。如果打包报 Node 版本不对，改用 `vp env exec --node 26.12.1 node scripts/fork-dist-mac.ts`。
- Android keystore：`~/.config/t3extend/android-release.jks`（目录 0700、文件 0600），PKCS12，alias `t3extend`，RSA 4096，有效期 10000 天，store 和 key 是同一个密码。密码只存在 macOS Keychain 的 generic password 条目里，account 和 service 都是 `t3extend-android-release`。新机器上用 `node scripts/fork-build-android-release.ts --create-keystore` 生成一次。已有 keystore 或 Keychain 条目时它会拒绝执行。它先把 keystore 生成到同目录的临时文件，Keychain 写入成功并且读回的密码一致后，才链接到正式路径；中途任何一步失败，都会删掉临时文件和这次写入的 Keychain 条目，可以直接重试。这一步只需要 `JAVA_HOME`（keytool 在 JDK 里），不需要 Android SDK。测试时用 `--keystore` 和 `--keychain-service` 指向临时路径和临时条目，不要碰正式的。

macOS 流水线（`scripts/fork-dist-mac.ts`）：

1. `build-desktop-artifact.ts --target dir` 打出未签名（ad-hoc）的 `.app`。
2. 把固定版本的 frpc 放进 `.app/Contents/Resources/bin/frpc`（桌面后端的 `T3X_FRPC_PATH` 指向这里；没有这个文件时 server 回落到 `<T3 home>/bin/frpc`）。frpc 由 `scripts/lib/fork-frpc.ts` 提供：默认走 shared 的 `fetchFrpc`（给它 `archiveCacheDir`，`t3x devices tunnel install` 用同一份代码、不给这个参数）。缓存的是下载下来的**归档**（`.tar.gz`），放在 `release/fork-cache/frp/v<版本>/<平台>-<架构>/`（已 gitignore，和官方 T3 Code 无关）。每次使用前都用 `forkFrp.ts` 里固定的归档 SHA-256 重新校验这个文件的字节，对得上才用，对不上就重新下载并校验；校验过的字节每次都重新解出 frpc（放在同目录的 `unpacked/`，上一次解出来的文件会被覆盖，不复用）。缓存目录里不存、也不信任任何自己记下的摘要，所以改写缓存目录里的文件换不进别的程序。离线时用 `--frpc-path <文件>` 指定一个本地 frpc：它只检查 `frpc -v` 恰好是固定版本，**由你提供，没有经过固定摘要校验**（日志里也这样写），文件的来源由你负责。镜像沿用 `T3X_FRP_BASE_URL`。`bin` 目录和 frpc 显式设成 0755，`--skip-build` 时同样放入。签名时 frpc 只开 hardened runtime，不带 entitlements（8.0 实测不需要）。
3. `@electron/osx-sign` 由内向外签名：嵌套的二进制和原生模块、frameworks、helpers、主程序。开启 hardened runtime，不打时间戳（Apple 的时间戳服务只给 Apple 签发的证书加签）。osx-sign 自己查找身份时不带 `-p codesigning`，所以看不到自签名证书。脚本先自己解析出 SHA-1 再传给它，并关掉它的身份校验。
4. 用 `hdiutil` 打出带 `/Applications` 链接的 UDZO DMG，再对 DMG 签名，然后挂载 DMG，校验里面的 app。签名后和挂载后各校验一次：用 `file` 找出 `.app` 里所有 Mach-O，逐个跑 `codesign --verify --strict`，并检查 Authority 是签名身份、带 runtime flag，有任何一个不满足就失败并列出文件；另外断言 `Contents/Resources/bin/frpc` 存在、在 Mach-O 清单里、文件和 `bin` 目录都是 755，并且 `frpc -v` 输出固定版本。每次开始前会删掉上一次的 `mac-arm64/`、DMG 和 `.sha256`（`--skip-build` 时保留 `mac-arm64/`）。没有上游 DMG 的背景图和窗口布局。

Windows 流水线（`scripts/fork-dist-win.ts`）：调用 `build-desktop-artifact.ts --platform win --target nsis --arch x64`，不带 `--signed`。身份全来自已有的 fork 改动：`appId` 是 `com.simpleeve.t3extend`（NSIS 的卸载项 GUID 和 AUMID 都由它得出）、`productName` 是 `T3 Extend (Beta)`（安装目录、开始菜单、可执行文件名、“已安装的应用”里的名字）、Electron userData 是 `%APPDATA%\t3extend`、home 是 `~/.t3extend`、scheme 是 `t3extend`、开机服务的计划任务文件夹和任务名用 `FORK.bootServiceName`，这些都不会和官方重合。安装包文件名在 `createBuildConfig` 的 `artifactName` 里改成 `T3-Extend-${version}-${arch}.${ext}`（原来是 `T3-Code-…`）。frpc 由同一个脚本里的 `stageForkFrpc` 放进安装包：`fetchFrpc`（和 mac 一样，归档缓存在 `release/fork-cache/frp/`，SHA-256 对 `forkFrp.ts` 里 `win32-x64` 那一行）把 `frpc.exe` 解到 stage 的 `prod-resources/frpc/`，再作为 extraResource 落在 `resources/bin/frpc.exe`，正是 `bundledFrpcPath` 在 win32 上给 `T3X_FRPC_PATH` 的位置，后端和 `t3x` 的 `.cmd` 启动器都指向它。frpc 和 LICENSE、NOTICE 都只作为 extraResource 出现一次，`files` 里排除了它们在 stage 里的副本，否则会再被打进 `app.asar.unpacked` 一份（frpc 16 MB）。LICENSE 和 NOTICE 原来从没被复制进 stage 目录，`DESKTOP_EXTRA_RESOURCES` 里的 `from: "LICENSE"` 找不到文件就被静默跳过，所以之前的 macOS 包（实测 0.1.10 的 DMG）也没有它们；现在构建时先复制进 stage。上游的“打包后不超过 80 个文件”检查是按 Linux 交叉构建定的（交叉构建不生成 server compile cache），在 Windows 主机上会多出约 24 个 cache 文件，所以 fork 把上限放到 100（`FORK_WINDOWS_PAYLOAD_FILE_LIMIT`，实测 92）。`fetchFrpc` 在 Windows 上按绝对路径用 `System32\tar.exe`（bsdtar 能解 zip），因为 Git for Windows 的 bash 会把它自带的 GNU tar 放在 PATH 最前，那个解不了 zip。

打完后脚本用 7-Zip 拆开安装包（NSIS 的 `$PLUGINSDIR/app-64.7z`），检查：根目录有 `T3 Extend (…).exe`，有 `resources/bin/frpc.exe`、`resources/app.asar`、`resources/server.asar`、`resources/LICENSE`、`resources/NOTICE`；`app.asar` 里 `package.json` 的 `name` 是 `t3extend`；`frpc.exe` 的字节和固定归档里解出来的一模一样（所以版本就是 0.71.1）；在 Windows 上再跑一次 `frpc.exe -v`。没有 Windows 机器时也能用 `7zz` 在 Mac 上对下载下来的安装包做同样的检查，但装不起来，没有实测过安装和运行。

entitlements 在 `packaging/fork-macos/`。主程序用 `entitlements.plist`，内容是 `renderMacPasskeyEntitlements` 去掉 team id、associated-domains、keychain-access-groups 和 passkey 后剩下的项：JIT、unsigned executable memory、disable-library-validation、camera、audio-input。helper 和其他嵌套程序用 `entitlements.inherit.plist`，内容就是 electron-builder 默认的前三项，和上游签名构建一致。

Android 流水线（`scripts/fork-build-android-release.ts`）：`APP_VARIANT=production` 跑 `expo prebuild --clean`，并检查 applicationId 是 `com.simpleeve.t3extend`；从 Keychain 读出密码；运行 `gradlew --no-daemon app:assembleRelease`，签名配置用 `android.injected.signing.*` 注入。store file 和 alias 走 `-P`，两个密码走 `ORG_GRADLE_PROJECT_*` 环境变量，所以不会出现在进程参数和日志里，代价是构建期间同一用户的进程能读到这些环境变量；换成临时文件同样防不住同一用户的进程，所以没换。`--no-daemon` 是为了不留一个持有密码的常驻 daemon。build.gradle、`app.config.ts` 和 plugins 都不改，native fingerprint 不变。最后用 apksigner 确认 APK 证书就是 keystore 里的证书。默认只打 `arm64-v8a`，`--abi` 可改。versionCode 固定为 1，不影响 sideload 覆盖安装：Android 只拒绝降级，相同的 versionCode 可以覆盖。以后要上架商店，就要每个版本递增。在 `app.config.ts` 里设置 versionCode 会改变 native fingerprint，所以现在不改。`apps/mobile/android` 是生成出来的目录，之后跑 `mobile:install` 会重新 prebuild 成 development。

安装：

- macOS：打开 DMG，把 `T3 Extend (Beta).app` 拖进 `/Applications`。第一次打开会被 Gatekeeper 拦下：先点"完成"，再到"系统设置 → 隐私与安全性"，在"安全性"里点"仍要打开"，用密码或 Touch ID 确认。从 macOS 15 起，按住 Control 点"打开"（右键打开）已经绕不过去；macOS 14 及更早的版本仍然可以。也可以在 Terminal 里先执行 `xattr -d com.apple.quarantine "/Applications/T3 Extend (Beta).app"`。用户面向的步骤在 `docs/user/install.md` 的"T3 Extend on macOS"，两处要一起改。
- 第一次启动时，macOS 会询问是否允许 `T3 Extend (Beta)` 访问钥匙串项 `t3extend Safe Storage`。把弹窗切到前台，选"始终允许"。签名身份不变时，重新打包以后 designated requirement（`identifier "com.simpleeve.t3extend" and certificate root = H"491ecedb…8978"`，即证书的 SHA-1；新证书未设信任，codesign 把这张自签名证书算作 root，T3 Extend Code Signing 时是 leaf）也不变，按理不会再问。这一点没有实测。**从 T3 Extend Code Signing 换到 `T3 Extend Code Signing` 是一次例外**：designated requirement 里的证书 hash 变成新证书的 SHA-1，所以换证书后的新包第一次启动时，会再问一次能否访问 `t3extend Safe Storage`，选"始终允许"即可；以前给 T3 Extend 授过的 macOS 隐私权限（屏幕录制、辅助功能等）也要重新授一次。之后再更新就不会再问。
- 如果点了拒绝，或者想让签名版重新创建这一项，执行 `security delete-generic-password -s "t3extend Safe Storage"`，然后重启 app。旧项里加密保存的本地凭据会随之失效，需要重新登录或重新配对。
- 弹窗没处理时，主线程会一直阻塞在读取 Keychain 上，app 不响应退出，第一次 SIGTERM 也不生效。这时用"强制退出"或 `kill -9 <PID>`。
- Windows：运行 `T3-Extend-<版本>-x64.exe`。安装包没有签名，SmartScreen 会弹“Windows 已保护你的电脑”，发布者显示“未知发布者”：点“更多信息”，再点“仍要运行”。开着智能应用控制（Smart App Control）时没有“仍要运行”，要先在“Windows 安全中心 → 应用和浏览器控制 → 智能应用控制设置”里关掉（有些 Windows 版本关掉后，不重装系统就没法再打开）。用户面向的步骤在 `docs/user/install.md` 的“T3 Extend on Windows”，`docs/fork/upstream.md` 和 `upstream.zh-CN.md` 的支持表里各有一行，要一起改。
- Android：`adb install -r <apk>`，或者把 APK 传到手机上安装。它和 dev client（`.dev`）是两个应用，可以并存。

**备份**：把 `android-release.jks` 拷到离线的地方，密码存进离线密码库。读密码要在受控的终端里执行 `security find-generic-password -a t3extend-android-release -s t3extend-android-release -w`，它会把密码打印出来，存好后立即清屏。两者丢了任何一个，以后的 APK 都不能覆盖安装已装的版本，只能先卸载，应用数据会一起清掉。

签名的限制：

- 自签名证书不能公证。拷到别的 Mac 上会被 Gatekeeper 拦下，要用上面的"仍要打开"或 `xattr`。本机关闭了 Gatekeeper 评估（`spctl --status` 显示 `assessments disabled`），所以本机上 `spctl -a -t exec -vv` 显示的是 `accepted` / `override=security disabled`，看不到拒绝。
- passkey 和 Associated Domains 需要 Apple 签发的 provisioning profile，不可用。
- macOS 只打 arm64，没有 universal 版本；Windows 只打 x64，没有 arm64；没有 Linux 的 fork 打包。
- Windows 安装包没有签名：没有证书，所以每次下载都会被 SmartScreen 拦一下，Smart App Control 会直接拒绝。要消除它得买代码签名证书（或用 Azure Trusted Signing，上游的 `--signed` 路径就是它），那是以后的事。Windows 上的 frpc 没有“server 被杀就带走 frpc”的看守（见“自建连接”里已知限制）。

## 从 T3 Code 导入

设置 → 维护 → "Import from T3 Code"。读取本机官方 T3 Code 的 `~/.t3/userdata`（只读，开发时可用 `T3CODE_IMPORT_SOURCE_HOME` 指向副本），把选中的项目、对话、定时任务和设置带进正在运行的 T3 Extend。服务在 `apps/server/src/fork/T3CodeImport.ts`，只有 host 上的 server 能读 `~/.t3`，所以入口放在设置页，靠 `capabilities.t3CodeImport` 判断，手机端不提供。

- **不碰官方数据**：源库只读打开，整个导入在一个读事务里完成，所有行来自同一时刻。版本比 T3 Extend 新就拒绝（"先更新 T3 Extend"）；更旧就在 `userdata/t3-import-*` 里建一个只含所选行的暂存库、迁移后再读，用完删除（见"升级路径"）。预览和预检（`preview` / `check`）只读，不写记账表、不碰 git，测试里有断言。
- **对话换新 id**：源 id → 目标 id 由 sha256 派生，同一个源永远得到同一个目标，重跑和续跑都幂等。行里所有出现旧 id 的文本（scope id、run id、检查点 ref 等派生名）一并替换，所以两个应用继续同一个对话时互不覆盖检查点。检查点 ref 用 `git update-ref --stdin` 的 `create` 按新名字复制到同一个仓库，旧 ref 不动，已存在的 ref 永远不会被移动：同名且指向同一个提交算成功（续跑），指向别的提交就跳过这个检查点（显示为缺失）并列入"需要注意"。删除 ref 的只有回滚（`CheckpointRollbackService`），没有定期清理。
- **id 的每一种写法都要换**：分配器（`packages/provider-core/src/server/IdAllocator.ts` 的 `joinId`）把每一段 `encodeURIComponent` 后用冒号连接，而 id 又会成为下一个 id 的一段，所以含冒号的对话 id（`thread:delegated-task:…`）在 scope id、checkpoint id、run id、node id 里以 0 到 3 层编码出现。重写器对每个映射的 id 生成 0–4 层 `encodeURIComponent` 的全部写法（源和目标同步编码），ref 名是 scope id 的 sha256，换完 scope id 后重算，不会留下和官方同名的 ref。测试用带冒号的对话 id 覆盖，并扫描所有表确认没有残留。
- **有更新的对话可以重导，覆盖 Extend 里那一份**：已导入的对话在官方里继续聊了之后，预览里状态是 `updated`（"T3 Code 里有更新"），可以勾选；没变化的仍是 `imported`，不可选。判定只看事件流版本：`copyThread` 在读快照里取源对话 `orchestration_events` 的 `MAX(stream_version)`，随 `fork_t3code_import_map.source_version` 一起记下（复制保留 `stream_version`，副本的事件流正好到这一版为止；真实库里版本号有空洞，因为维护任务会修剪旧事件，所以只比较最大值，不数条数）；之后源流的最新版本比它大就是有更新，子 Agent 对话有更新也让父对话显示 `updated`；首次导入时没勾"子 Agent 对话"的也算：这些被省略的子 Agent 在导入表里记一行 `state='omitted'`，带着当时的 `source_version`，不对应任何对话行（`threadTargets` 不含它们，所以父对话卡片仍打不开），只用来判断后面有没有更新（`isStale`）。父对话因此重导时，没勾子 Agent 就只把它们的基线更新到现在，勾了就把子 Agent 一起复制、父对话的卡片接上。基线只在父对话真的替换成功后才更新：替换在锁内被拦下（目标忙了或有变化）时不动，否则子 Agent 的更新会被永久吞掉。不用 `updated_at` 或时间戳，因为它们受时钟和不产生事件的改动影响；事件流的最新一行不会被 `ProjectionMaintenance` 的修剪删掉（SQL 里 `MAX(sequence)` 那一行保留），版本不会倒退。这列和 `source_runs` 是 `ensureImportTables` 里用 `pragma_table_info` 判断后 `ALTER TABLE ADD COLUMN` 加的，不是编号迁移。本功能之前导入的对话这两列为 NULL，退回按时间推：副本里 `occurred_at <= imported_at` 的最后一个版本当作"复制到哪"（副本里那个事件若已被修剪，可能把没变的对话误报成有更新，只会多提示一次，不会丢内容），运行数则数 `requested_at > imported_at` 的运行；这条路径只对旧记录生效，新导入和重导都会写上。重导就是对同一个目标 id 走 `purgeThread` 再复制，所以侧栏里还是同一个对话；检查点 ref 照旧只创建不移动，冲突列入"需要注意"。只有用户明确选中的对话和它的子 Agent 才会重导，为了挂 fork 而被带进来的父对话保持原样。
- **覆盖保护**：副本里导入之后在 Extend 里发起的运行数（`orchestration_v2_projection_runs` 里 `ordinal` 大于导入时记下的 `source_runs` 的行数）就是 `localChanges`。大于 0 时对话默认不勾；用户自己勾上后，复核步骤用单独的警告框写明"会丢弃你在 T3 Extend 里新增的 N 轮对话"，确认才覆盖。除了运行，还比较置顶、归档、延后和模式/模型设置（`metaOf`）：导入时把源对话这几项存进 `fork_t3code_import_map.source_meta`，复核时和副本现在的值比，不同就并入同一条"会丢弃你的改动"的提示，写明是哪几类（`localEdits`），对话同样默认不勾。结算、访问时间这类应用自己的记账不算。**标题不算本地改动**：标题生成器自动写的标题和用户手改的在库里分不出来（事件里没有来源标记；`lastTitleRegeneration` 只在手动重新生成时写，也不记标题；旧事件还会被修剪，追不回历史），所以标题不进 `localEdits`，不影响默认勾选，也不会让替换中途因为"变了"而停下；复核里只单独提一句 `thread-title-replaced`："它的标题会换回官方里的标题"。本功能之前的导入没有 `source_meta`，没有基线可比，只能比运行。数运行行而不是事件：一是后台事件（例如自动结算）也可能往副本里追加，那不是用户的内容；二是维护任务会把旧的 `run.created` 事件修剪掉（官方真实库里只剩一小部分），事件流数不准。副本正在运行、排队、有待处理请求、后台任务或 outbox 里有未完成的效果（`targetBlocked`，前四项和源端同一条 `directBusyThreadIds`）时一律不覆盖，列入"未导入"并说明原因；副本还有活着的 provider session 时，先用 `ProviderSessionManager.detach` 把它关掉（只摘这个对话，共用的进程不动；对话没有工作才关，所以关掉的只是一个空闲的暖进程，下一轮会按原生句柄重新打开），关不掉就不覆盖，提示"请先关闭这个对话的会话"（`thread-target-session`）。选关而不是一律拒绝，是因为空闲 session 要过一阵才会被自己释放，一律拒绝会让刚聊完的对话反复导不进去。判断"还活着"只看内存里的 `isLive`，不看库里的行：真实库里 session 和 binding 行关闭后一直留着（699 行 session 里 685 条是 `stopped`，961 个对话还挂着 binding），按"库里没有行"会拦住几乎所有聊过的对话；这些残留行由 `purgeThread` 清掉。关掉之后仍然活着、且只有这个对话绑着的 session 算占用（共用的宿主进程，别的对话也绑着，不算）。复核里另有一条 `thread-replace-idle`，提醒只在对话空闲时导入。源对话在官方里正在运行时仍然跳过。**复核和覆盖之间有时间差**，所以替换本身在对话的命令锁里、一个事务里做（`copyThread`）。命令锁就是 Orchestrator 对这个对话用的那一把：`ThreadCommandExecutor`（`orchestration-v2/ThreadCommandExecutor.ts`，一个 `KeyedLock<ThreadId>` 服务；`dispatch`、provider 事件入库和 effect 都在它下面跑）。`T3CodeImport` 构造时 `yield*` 同一个服务，`T3CodeImport.layer` 自带 `Layer.provide(ThreadCommandExecutor.layer)`，不动任何上游文件；它和 Orchestrator 的 `layer` 提供的是同一个层常量，整个服务图只建一次，所以拿到的是同一个实例（Orchestrator 自己也靠这一点和 `RunExecutionService`、`ProviderEventIngestor` 共用）。锁不可重入，导入在持锁期间不派发任何命令；先取线程锁、再取 SQLite 写锁，和 Orchestrator 的顺序一致，不会反转。取到锁之后先跑一次 `targetBlocked`（忙就不去关它的 session），再关空闲 session；然后事务一开始就拿写锁（`BEGIN IMMEDIATE`），再跑一遍 `targetBlocked` 和 session 检查，并把现在本地运行数和改动种类和复核时告诉用户的比，多了就不覆盖（`thread-target-changed`：用户只同意过丢弃复核里列的那些）；通过后才清空、复制行和事件、重写对话间的 hand-off、推进游标，失败整体回滚，旧副本原样保留。这样一条已经读了旧投影的命令要么在我们拿到锁之前提交（随后被整个替换掉），要么在替换之后基于新投影执行，不会把旧数据写回。**剩余风险（没有消除）**：provider 事件入库（`ProviderSessionManager` → `ProviderEventIngestor`）和 effect worker（`EffectWorker` → `ProviderTurnStartService`）不经过这把锁，而它们是上游核心写入路径，fork 不改。空闲门槛（没有运行、请求、后台任务、未完成的 outbox 效果，没有活着的独占 session）把窗口缩小到：门槛检查通过的那一刻之后、事务提交之前，恰好有一个在途的 provider 事件或刚被取走的 effect 落进旧副本。这个窗口很短，但存在；落进去的写入会随整个对话被替换掉，或在替换之后写进新副本里一行找不到来处的数据。所以**建议只在对话空闲时重导**：复核界面有一句同样的提示。检查点 ref 在事务前创建（只创建，所以先做无妨）；导入本身靠 `importLock` 串行。上一次中断留下的 `copying` 半成品续跑时同样先取线程锁、进同一个事务（它没有可比的基线，所以不比本地改动），不再是无锁的。测试：`T3CodeImport.test.ts` 里有一条用真实 Orchestrator（`ProviderReplayHarness`）和同一个锁的并发测试——命令持锁读到一半时，替换必须等它提交，然后整个替换掉它写的东西；去掉导入这边的加锁后该测试会失败。测试里的导入对话是夹具行、不是完整投影，所以"替换之后再发命令"这一半没有走真实 Orchestrator。清理对象不只 `thread_id` 列：`orchestration_v2_projection_context_transfers` 用 `source_thread_id` / `target_thread_id`，`replaceTransfers` 在同一事务里删掉它和其他已导入对话之间的记录（你在 Extend 里建的、对方不是导入对话的不动），再从源里读回，成对的两条由后落地的那个写入；`purgeThread` 还删这个对话的 provider session：它的 binding 全删，只属于它的 session 和 `provider_session_runtime` 行也删，别的对话还绑着的 session 留下（这些表在 `EXCLUDED_TABLES` 里，复制不带，所以不清的话副本会重新打开旧 session）。`T3CodeImport.test.ts` 里有一个扫 schema 的测试，上游以后新增不带 `thread_id` 的线程引用列时会在这里报出来。在线客户端：覆盖后照常发布 `thread.created`（`publishCommitted`），侧栏和线程头立刻更新；正开着这个对话的客户端由 `packages/client-runtime/src/state/threads.ts`（标 `// fork:`）处理：对已持有数据的线程收到 `thread.created` 就是被导入重建了，把游标退到它之前并重新订阅，服务端 `subscribeOrchestrationV2Thread` 里已有的"线程被重建"分支（`hasCreateEvent` 且线程存在就发新快照）随即发来整份快照。不改上游 `ws.ts`；web 和 mobile 共用这段。带着旧快照重连的客户端走同一个分支，因为重导写入的事件序号一定大于任何旧游标。投影游标判断也随之放宽：旧事件被清掉后，游标只要不落后于其他对话的最新事件就跟着新事件走，否则投影会把新事件再套一遍。
- **替换大对话会让其他对话短暂停顿**：替换在写锁下一次性复制，不拆事务（拆开就失去"失败时旧副本原样保留"）。用 `T3CodeImport.test.ts` 同款夹具按真实库最大线程的规模合成数据测过：官方真实库（只读统计）里最大的两类线程，一类约 9,400 行投影行（约 24 MB）加 300 条事件，一类约 5,800 行加 6,900 条事件（约 25 MB）；合成 8,032 行投影行（约 18 MB）加 6,904 条事件（约 12 MB），替换一次（含复核）约 1.2 到 1.6 秒，大约每行或每条事件 0.1 毫秒。所以事件加 `turn_items`、`nodes`、`messages` 三张表的行数达到 `LARGE_REPLACE_ROWS`（8,000）时，复核里加一条"这是个很长的对话，覆盖它时其他对话可能会短暂停顿"（`thread-large-replace`）；持锁超过 `SLOW_REPLACE_MILLIS`（1 秒）会记一条 warning 日志，带持锁和等锁的毫秒数。合成数据里的行用的是 `turn_items`、`nodes`、`messages` 三张真实表，但内容是随机填充，真实载荷更大或触发器更多时会更慢。官方真实库的 1,622 个对话里，行数加事件数达到 8,000 的有 2 个，达到 4,000 的有 10 个。
- **建议一个对话只在一边继续聊**：两边都继续的话，重导会按官方那份覆盖 Extend 的，反过来 Extend 的改动带不回官方。置顶、归档、延后、模式/模型设置的改动会在复核里警告；标题只提一句（见"覆盖保护"）。
- **检查点 ref 只创建不移动**：目标 ref 已存在且指向别的提交时视为冲突，不覆盖。预览和导入共用同一份只读计划（每个仓库一次 `git cat-file --batch-check`），所以冲突在确认前的复核步骤就能看到。冲突和源 ref 缺失的检查点不进重写映射，投影行和 `checkpoint.captured` 事件都标成 `missing` 且保留源 ref 名，两边一致；只有 `ready` 的检查点会被复制，因为上游只在 `ready` 时清理旧 ref、只允许从 `ready` 恢复。
- **不导入的子 Agent**：不勾"子 Agent 对话"时，父对话里指向它们的卡片保留，但 `child_thread_id` 和载荷里的 `childThreadId` 置空（打不开）；对它们的其余引用（事件、消息文本）换成它们将来导入时会得到的新 id，源 id 不会残留；父到子的 hand-off 记录丢弃。
- **到达时是停止状态**：正在跑、排队、有待处理请求、有恢复任务的对话整家跳过；其余的不带运行中的会话、绑定、outbox、命令回执，`limitRecovery` 清空，provider thread 只保留原生会话句柄。auth、配对链接、peer 链接、环境 id、签名密钥、`connection-catalog.json`（用官方 Electron safeStorage 加密）都不带。
- **定时任务逐个选**：对话框默认把选中的任务导成暂停（官方那边的同一个任务仍在跑，两边各跑一次没意义），每个任务的开关可以单独打开；服务端只照选择里的 `enabled` 走。导入走和编辑器相同的 `ScheduledTaskService.upsert`，首次运行是它的下一个计划时间，导入和首次启动都不会立刻触发（`ScheduledTaskService.interval.test.ts` 在调度层验证）。webhook 任务在导入后换新地址和新签名密钥（不带官方的 `webhook_secret`；带签名校验的任务生成新密钥，只在完成页显示一次，不写进运行记录），投递和重放记录不带。一次性任务（`once`）的时间已过时一律关闭导入，并列在"需要注意"里，否则保存瞬间就会触发。官方那边的同一个任务仍在跑，直到用户在那边暂停，预检里逐个提醒。
- **对话和任务的关联**：Thread Details 的 "Automations" 只列 `scheduled_tasks.thread_id` 等于当前对话的任务，所以任务一导入、绑定的对话已在这里，标志就出现；任务绑定的对话还没导入时跳过（`task-thread-missing`），之后可以只勾任务补导。对话里每条定时消息的 `scheduledTaskId`（决定"Open automation"链接和任务标题）在复制时就按固定算法改写成 `scheduled-task:import-<摘要>`，源库里所有任务都算，不管这次有没有选它，所以先导对话、后补导任务不用动对话；只改 JSON 里的 `scheduledTaskId` 字段，正文里提到任务 id 的文字不动。更早的版本导入的对话和任务（消息里还是官方 id）靠 `relinkTaskMessages` 补：对每个已导入、还没记过 `kind='task-links'` 的任务，找出消息、turn item、事件里提到它的线程，按线程 id 排序逐个在该线程的命令锁（`ThreadCommandExecutor`，和重导同一把）下、一个事务里改这个线程的行，所以读过旧消息的命令不会在补链后把官方 id 写回来（provider 事件入库不经这把锁，和重导的剩余风险相同）；所有线程都改完才写 `task-links` 记账行，中途失败整个线程回滚、任务保持待处理。改法是解析 JSON、只改对象里键名恰为 `scheduledTaskId` 的字符串属性（复制路径同一个函数 `moveTaskIdFields`），正文里引用的 payload、字符串里套的 JSON 都不动；只有真的改了的文档才重新紧凑序列化。失败立刻重试两次，仍失败只记警告、不影响导入，下一次再试：每次导入结束（不管选了什么）和每次服务启动都会再跑；打开导入对话框（`preview`）保持只读，不触发补链；没有待处理的任务时只是一次小查询。已经打开的客户端要重新加载对话才会看到。
- **受管策略**：`settings.json` 里被 `managedPolicy.lockedSettings` 锁住的键（含嵌套的父子路径）不写，列入"未导入"并写明管理方；`allowedDrivers` 之外的 provider 实例同样跳过。`client-settings.json` 不在服务端策略范围内，没有可锁的键。
- **升级路径**：源库比 T3 Extend 旧时，不复制整个库（真实的有几个 GB）。在 `userdata/t3-import-*` 里新建一个库，用 T3 Extend 自己的 migrator 迁到源库的版本，只把所选项目、对话、事件和定时任务行转进去，再把这个库迁到当前版本，最后从它走和等版本一样的复制。所以后续上游迁移（例如 077 修复布尔 `settledOverride`）自动作用在导入的行上，不需要给每个迁移手写转换；`T3CodeImport.test.ts` 的旧版本夹具用 076 的库验证这一点。暂存阶段磁盘写满时，写入报错使这次导入以"Importing from T3 Code failed."结束，作用域结束时暂存目录被删除，释放空间；暂存发生在复制到正在运行的库之前，所以那时 T3 Extend 的库里只多一条没有 `finished_at` 的运行记录，什么数据都没写，腾出空间后直接重新导入。进程在暂存中被杀会留下 `t3-import-*` 目录，下一次导入开始时（导入串行，剩下的必是遗留）先删掉它们。
- **官方名字只走一个常量**：用户可见文案里的 "T3 Code" 来自 `OFFICIAL_APP_NAME`（`packages/contracts/src/t3CodeImport.ts`），在 `t()` 里作为 `{app}` 参数传入，品牌守卫只需要为这一处写白名单。带数量的文案用显式的单数和复数两个 key（`t()` 没有复数规则），中文条目一一对应。
- **worktree 共用**：对话仍指向 `~/.t3/worktrees` 下原来的目录，不移动文件。这些路径记在导入表里（`kind='worktree'`），并且在对话行写入之前先记，所以清理任务不会看到没有标记的导入对话。拒绝删除的规则只在最底层一处：`removeLinkedWorktree`（`apps/server/src/vcs/worktreeRemoval.ts`）整个包在 `whileRemovable` 里，向 `SharedWorktreePolicy`（`apps/server/src/fork/SharedWorktrees.ts`）的 `exclusive` 段里执行。`SharedWorktreePolicy` 是带默认值的 `Context.Reference`，所以约 20 处 `GitVcsDriver.layer` 的调用方和它们的测试都不用改：默认实现只做路径规则（官方 home 的 `worktrees` 目录之下一律拒绝）；服务器在 `server.ts` 里于所有会建 Git 驱动或删 worktree 的层之下提供一次 `SharedWorktrees.layer`，它在构造时建表、把标记一次性读进内存，删除时不再访问数据库，导入在复制阶段开始、任何对话行提交之前，对所选对话引用的全部 worktree 先调 `markShared` 更新内存，再在一个事务里写库（多标记无害：这些 worktree 本来就归 T3 Code，T3 Extend 绝不该删；重复运行幂等），不用重启。读不到标记时失败即关闭：拒绝 T3 Extend 自己 worktree 目录（`config.worktreesDir`）之外的所有删除，并记错误日志；导入的 worktree 不会在自己的目录里，所以自己的清理照常工作。标记未知的状态在下一次导入开始时（`markShared` 内）重试加载，成功后切回已知集合并并入这次的标记。驱动和存储清理在构造时取这个 Reference，调用时用 `provideService` 带进去，不依赖调用方的 fiber 上下文。`T3CodeImport` 构造时 `requireLivePolicy()`，漏掉 `SharedWorktrees.layer` 服务器就起不来（`T3CodeImport.test.ts` 覆盖）。所有删除都经过它：`GitWorkflowService.removeWorktree`（`ws.ts` RPC、`ThreadLaunchService` 取消清理、`WorktreeMcpService` 回退清理）、`PullRequestReviewGuideService`（只删自己在 `config.worktreesDir` 里建的检出）、存储清理。策略有一个单许可的 Semaphore：`exclusive(路径, 破坏性操作)` 持有许可时重新检查内存里的拒绝规则，仍允许才执行；`markShared` 更新内存时拿同一个许可，所以导入不可能在“检查”和“删除”之间抢占路径。许可只包住检查和破坏性操作（`git clean`、`git worktree remove`、Windows 上的 fs 删除），数据库读写（含标记的重试加载）在外面；`removeLinkedWorktree` 整体走它，所以每个调用方都有，存储清理把 `git clean` 和移除放进同一个段（段内为此包含对子模块的有界 Git 只读检查）；Semaphore 不可重入，所以段内不能再开段：段把一个只能在段内拿到的 `SharedWorktreeSection` 凭证交给回调，存储清理用它调不带守卫的 `removeLinkedWorktreeInSection(凭证, …)`，没有环境标记，也不会被泄漏到别的 fiber。默认策略只有路径规则，没有可变状态，不需要锁。存储清理对每个 worktree 的第一步就查一次策略，早于任何对它的 Git 命令或文件操作（`git clean -ffdx` 在 `removeLinkedWorktree` 之前执行，所以只靠最底层不够）；被拒绝的整个跳过。`removeLinkedWorktree` 里那一次留给其他调用方。路径规则：含符号链接解析后在官方目录之下就拒绝（不管有没有标记）；本环境自己的 worktree 目录恰好在官方目录里时（从官方 worktree 里跑 dev server）自己建的仍可删；macOS 和 Windows 上按 NFC 加小写折叠后的路径比较，目标不存在时用最近的存在祖先做 realPath 再接上尾部。`git worktree prune` 不加守卫：它只清掉目录已不存在的 Git 记录，不删任何文件。设置里的 `previousWorktreesDirectories` 不导入，否则会让清理接管官方的目录。
- **状态记录不进编号迁移**：Effect 的 migrator 遇到重复 id 会失败，并且会跳过不大于已应用最大值的 id，fork 自己加一个 078 会让下一次同步上游出问题。**fork 不新增编号迁移**。导入的 id 映射和运行记录放在服务启动时（`SharedWorktrees.layer` 和导入服务启动时都会跑，可重复执行）`CREATE TABLE IF NOT EXISTS` 建的 `fork_t3code_import_map` / `fork_t3code_import_runs`。做法参照上游 `orchestration_v2_legacy_imports`：每个对话一行进度，`copying` 的下次从头重做该对话，`done` 的跳过（源对话有更新且被选中时例外，见"有更新的对话可以重导"）。

## 品牌与图标

fork 的标记是自己的：一条竖干加三条向右递增的短划，读作 "E"，不是上游的 T3 字标。唯一来源是 `assets/fork/mark.svg`（128 单位画布，描边 16、圆头，墨迹框 26..102）；应用图标、网页 favicon、Android 图标、DMG 背景、小组件和界面里的字标都从它派生。

```bash
vp run fork:icons   # scripts/fork-brand-icons.ts && scripts/export-android-icons.ts
```

- `scripts/fork-brand-icons.ts` 把每个变体自己的 `assets/{dev,nightly,prod}/app-icon.icon` 图层按 `icon.json`（顺序、scale、translation）合成，把 `text.svg` 换成 `mark.svg`，再套 `assets/fork/masks/` 里的圆角形状（`mask-macos-1024` 是内缩的那个，其余是全出血的方形；这些 mask 是从上游最后一次导出的图标里取的 alpha），最后写出三套 PNG/ICO、`apps/web/public/` 的四个文件、Android 的单色与通知图标、`apps/mobile/assets/widget/T3Mark.svg`。它同时把 `mark.svg` 复制成三个 `Assets/text.svg`，所以 Icon Composer 项目里的来源不会漂移。
- `scripts/export-android-icons.ts` 还是上游脚本，只改了 `TEXT` 一行（指向 fork 标记的墨迹框）；它读 `assets/prod/app-icon.icon/Assets/text.svg`，所以必须在 `fork-brand-icons.ts` 之后跑。
- 上游的 `vp run icons:export` / `icons:check` 要 macOS 的 Icon Composer，而且命令行导不出 "macOS pre-Tahoe" 预设，fork 不用它们。改标记后的检查方式就是重跑 `vp run fork:icons`，再看一眼 16 px 的 favicon。`icons:check` 拿 Icon Composer 源去比 fork 的产物，必然报错，忽略即可。
- 界面字标：web `apps/web/src/components/T3Wordmark.tsx` 和 mobile `apps/mobile/src/components/T3Wordmark.tsx` 内联同一段路径，后面仍接 `FORK.wordmarkSuffix`（"Extend"），可访问名还是 "T3 Extend"。
- 还没换的：`apps/marketing`（上游官网，fork 不构建）、`scripts/mobile-showcase-environment.ts` 里当 mock 项目 favicon 用的 T3 标记（那是一个叫 t3code 的假项目，故意留着），以及 `release/` 里的旧 APK（构建产物，重新打包即可）。

## 授权与署名

上游是 MIT（见 `LICENSE`，Copyright (c) 2026 T3 Tools Inc.）。fork 可以随意修改和分发，代价只有两条：副本里保留版权和许可声明；MIT 不给商标，所以不能用上游的字标和标识让人以为这是官方产品。名字继续叫 T3 Extend、提到上游时只做陈述（"a fork of T3 Code"）都行，视觉标记必须换成 fork 自己的。

- `NOTICE` 写明 fork 来自哪里、上游是 MIT，以及随包第三方里需要额外注意的两项：`heic-to`（LGPL-3.0-or-later，web 客户端解码 HEIC 用，未修改地打进 web 和桌面包）、KaTeX 字体与 Carlito（OFL-1.1）。
- 二进制里也必须带上声明：`DESKTOP_EXTRA_RESOURCES`（`scripts/build-desktop-artifact.ts`）把 `LICENSE` 和 `NOTICE` 放进 mac / win 应用的 Resources；Linux deb 另外把 `LICENSE` 装到 `/usr/share/doc/t3code/copyright`。
- 应用内的 "Open source licenses" 页（web / desktop / mobile 都有）读构建期生成的 `third-party-licenses.json`。`third-party-licenses.config.json` 的第一条 customNotice 就是 `NOTICE`，所以 fork 和上游的 MIT 声明在界面上也看得到。
- 打包出的应用元数据（同一个脚本里的 stage package）写的是 fork 的 author / homepage / description；提到上游名字时只走 `OFFICIAL_APP_NAME`，`fork:guard` 会拦住新的硬编码。Linux 打包身份（`executableName`、metainfo、maintainer）仍然写的是上游，见"例外和限制"。
- 上游代码里的云服务（Clerk / T3 Connect / EAS / PostHog）用的是 T3 Tools 自己的账号，服务本身不在 MIT 授权范围；fork 默认全部关闭。

## 同步上游

```bash
git fetch upstream
git merge upstream/main
# 解决冲突：fork 的改动都在带 `// fork:` 注释的行上，保留 fork 的值，接受上游其余改动。
vp i
vp run fork:guard        # 上游新增的官方身份字面量会在这里报出来
vp run i18n:report       # 上游改过的英文文案会列为 stale
vp run check:changed
vp run fork:selfhost:e2e # 需要 Docker；隧道监听口靠改写 Host、X-Forwarded-Proto、X-Forwarded-For 工作，上游改请求 URL 的读法时靠它兜底
```

GitHub Actions 在这个仓库里是开着的，但上游的 27 个 workflow 都在 GitHub 上单独 disable 了（`gh workflow disable`），只有 `fork-release.yml` 启用：`ci.yml` 指定的是上游的 `blacksmith-*` 付费 runner，每次推送都会排队；部署和发布类的 workflow 带 `github.repository == 'pingdotgg/t3code'` 守卫；其余几个是管理上游公开仓库 issue 和 PR 的。workflow 文件保持和上游一致，不删也不改，否则每次同步都会冲突。disable 是 GitHub 上的状态，不在文件里：上游同步过来的**新** workflow 默认是启用的，每次同步后跑 `gh workflow list --repo SimpleEve/t3-extend --all`，把新出现的上游 workflow 逐个 `gh workflow disable <文件名>`。`fork-release.yml` 自己的每个 job 都带 `github.repository == 'SimpleEve/t3-extend'`。私有仓库在免费套餐下用不了分支保护，本仓库没有 required checks，合并不依赖 CI。

最近一次同步到上游正式版 `v0.1.13`（`bc0f04da94`，2026-11-27，合并基点 `ca81b7b97a`，401 个 commit，78 个冲突文件：74 个文本冲突，4 个删除冲突，是 fork 删除、上游改过的 `ThemeEditorPanel.tsx`，和 fork 改过、上游删除的 `apps/mobile/scripts/measure-renders.mts`、`antigravityUsageLimits.ts` 及其测试；上一次是 11-25 同步到 `v0.1.12`（`ca81b7b97a`），11-24 同步到 `a7a6126a7d`，11-21 同步到 `9cc4018c75`，11-17 同步到 `55c134a346`，基点 `b9bbfda087`）。累计下来的取舍，下次遇到同类冲突照做：

- 受管策略（managed policy）：macOS 的 managed preferences 和描述文件模板按 `FORK.appId` / `FORK.appBaseName` 生成（`packages/shared/src/managedPolicyFile.ts`、`apps/server/src/policy/policyTemplates.ts`，后者有测试守着）。`/Library/Application Support/T3Code/policy.json` 和 Windows 的 `SOFTWARE\Policies\T3Tools\T3Code` 注册表路径仍是上游的，fork 和官方共用同一份策略；Windows 的 ADMX 模板同理。
- `DesktopUpdates.hasUpdateFeed` 把受管镜像（`policy.feedUrl`）也算作更新源，否则管理员配了镜像、构建里却没有 `app-update.yml` 时，入口会被隐藏。
- 侧栏"按项目"就是上游的 Boring 侧栏（视图由 `boringSidebarEnabled` 决定，`Sidebar.tsx` 里那一行是上游原样）。上游把 `sidebarTree.ts` 的 `role=tree` / `aria-level` 去掉了，fork 在 `lib/sidebarTree.ts` 已经没有改动，`shortcuts/chatRouteCommands.ts` 里 `chat.new` 的项目视图分支也删了（`chat.new` 在项目视图里和 boring 一样走项目选择器）。
- 上游把 `app.t3.codes` 的链接声明加进了 `app.config.ts`。Android 的 intentFilter fork 不采用：没验证过的 http 链接过滤器会让 fork 出现在"用哪个应用打开"的选择框里，用户看得到。iOS 的 `applinks:app.t3.codes` 保留上游原样，不加 fork 改动：官方站点的 apple-app-site-association 不会列出 fork 的 bundle id，这条声明在 fork 里不起作用；fork 目前不发 iOS；iOS 的 native fingerprint 本来就会因为麦克风文案变化而变。原则是只在用户看得到影响时才偏离上游。
- Effect 升到 4.1.2 后 `effect/Crypto` 拆成 `effect/crypto/Digest` 和 `effect/crypto/SecureRandom`；fork 的 `T3CodeImport`、`DeviceAssertionAuth` 和测试夹具都改用新服务，测试要用 `NodeCrypto.layer`（`@effect/platform-node/NodeCrypto`）。同一版本不再读 `X-Forwarded-Proto`，上游加了 `apps/server/src/requestUrl.ts`；server 里取请求 URL 一律走它，不要直接调 `HttpServerRequest.toURL`（隧道监听口的夹具也一样）；端到端的场景 3、4、14（经隧道的 DPoP、限速桶、伪造的 `X-T3x-Client-IP`）验证的就是这一点。
- 上游新增的测试经常写死官方标识（`t3code://`、`t3code.service`、默认端口 3773、Tailscale Serve 的默认端口）；换成 `FORK.scheme`、`FORK.bootServiceName`、`FORK.defaultPort`、`FORK.tailscaleServePort`。服务端新增清理原因要同步 `apps/web/src/fork/storageCleanupReasons.ts` 的模板表和 zh-Hans 目录，否则 `storageCleanupReasons.test.ts` 会报。`T3CodeImport.test.ts` 把源库固定在迁移 76（077 之前），不要写成"当前 head 减一"，上游每加迁移就会失效。
- `vp i` 在 npmmirror 缺新包版本时会 404：用 `vp i -- --registry=https://registry.npmjs.org/`，只对这一条命令生效。`check:changed` 的默认基准是 `origin/main`，会把 `.repos` 上万个文件算进来、子进程报 `E2BIG`；同步后用上一次同步到的上游 commit 当基准（这次是 `vp run check:changed 9cc4018c75`，下次用 `bc0f04da94`）。它的 "unused patches" 一步也要联网解析依赖，同样受镜像影响。
- mobile 的 `managedSettingReason` 保持英文输出，新增 `managedSettingOrganization` 供已翻译的屏幕使用。上游重写的 PR 状态按钮和麦克风设置页，在新逻辑上重新套了 `t()`；上游删掉的文案（"Auto-merge is enabled"）同步从 catalog 删掉。
- mobile 的 AppBar 重构（每个页面自己画一个 `AppBar` 或 `SheetHeader`）删掉了 15 个 fork 改过 `t()`、品牌或"按项目"视图的文件（`HomeHeader.android`、`ThreadListToolbar`、`WorkspaceRootScreen` 等）。这些文件的 fork 改动没有搬到新位置原样保留，而是在新结构上重做：对话列表的视图开关进了 `buildHomeListFilterMenuItems(props, t)`（`HomeRouteScreen`、`ThreadNavigationSidebar` 传 `viewMode`）；品牌名在 `WorkspaceListHeader.android`、`PullRequestToolbar.android`、`HomeRouteScreen`、`WorkspaceRootScreen` 里用 `FORK.appBaseName`；`AppBar`/`AppBar.android` 在入口经 `fork/appBarI18n.ts` 翻译操作、菜单、搜索和确认按钮的文字，所以新页面不用逐个给这些文案包 `t()`；路由标题当时经 `fork/localizedTitle.ts` 做成 getter；改用上游 GT 后路由标题由上游翻译，这个文件已删除。`Stack.tsx` 取上游，只保留设备页路由和 `connections/new` 的 `pair` 别名。
- 解决 i18n 冲突的做法：fork 只包了 `t()` 的冲突取上游，再用 `vp run i18n:report` 的 hard-coded 清单重新包（可以写脚本按清单里的行号和文本包）；fork 在 `t` 参数、`translate:`、`translator` 之类的传参上有真实改动的冲突手工合。取上游后新文案会在报告里列为 hard-coded，再补 catalog；上游改了英文的旧 key 会列为 stale，删掉。 取上游的冲突文件里，同一个 key 在多处调用时可能只包了一部分，报告看不出来；合并后拿合并前的 main 比一遍：基点里在 `t("…")` 里、现在成了模板字符串、JSX 文本或裸字面量的句子，都要包回去（这次靠这个又找回了几十处，包括 `Working {duration}`、`Show {count} more`、语音设置里的 aria-label）。删 stale key 前先确认不是自己刚把调用点改成了模板。
- 对话状态 "preparing" 是上游新加的（侧边栏的"准备中"）。fork 把状态函数搬到了 `packages/client-runtime/src/state/threadGrouping.ts`，上游对 `Sidebar.logic.ts` 里这几个函数的改动要手工搬过去，测试也在 `threadGrouping.test.ts`。
- 上游把 Effect 的诊断升成了 error（`extendsNativeError`、`preferSchemaTaggedError`、`instanceOfSchema`、`processEnvInEffect`、`effectTryWithoutCatch` 等），fork 自己的类要么改成 `Schema.TaggedError`（`SharedWorktreeRefused`），要么在类上一行 `@effect-diagnostics-next-line extendsNativeError:off - <原因>`（`ProofError`、`FrpFetchError`、`RpcFailure`、`E2eFailure`、`RegistryError`、桌面网关的两个错误类）。这些原因都是"在 Effect 之外的纯 throw 里用"，以后新增 fork 错误类先看能不能直接用 Schema。
- 上游把 `useEnvironmentConnectionSummaries()` 从 `apps/web/src/state/environments.ts` 删掉了（还原了一个功能），fork 的底栏芯片（`fork/useFooterScope.ts`）要用，所以在那个文件末尾带 `// fork:` 加回。
- `pullRequestDescriptionContent(document, media, t)` 的 `t` 放最后并默认英文：上游的新测试用 `(root, media)` 的签名，fork 的传参顺序要迁就它。
- 上游的 GT i18n（#37893）在 2026-11-21 的同步中采用，见"多语言"一节；之前那几次同步曾把 gt 基础设施删掉，现在反过来：gt 的文件、依赖、`i18n-check` 一律保留。
- 自动解决 i18n 冲突不要用"fork 与基点的差别只在含 `useT`/`translate` 的行就取上游"这类启发式：它会丢掉逻辑文件里的 `t: Translator` 形参、fork 导出的函数和被一并删掉的 import，类型检查会炸出上百个错误。要对每个冲突文件做真正的三方合并（`git merge-file -p --diff3`，ours 是 fork 一侧，base 是上次同步的上游，theirs 是新上游），再逐个冲突块手工合；已经合坏的文件按这个办法重做。合并后跑一遍全量 lint：`ListRow` 的 `joinLabelParts` 就是在之前某次同步里被悄悄丢掉、这次才补回来的。
- 上游删掉了 `legacySidebarEnabled` 和 `useBoringSidebarEnabled`，Boring 侧栏就是 `settings.boringSidebarEnabled`；`T3CodeImport` 遇到旧的 `legacySidebarEnabled` 只记一条 attention，不再迁移。侧栏状态函数（`resolveSidebarRowStatus`、`resolveWindowTitleThreadStatus`）也在 `threadGrouping.ts` 里补上。
- `"widget"` 指令的文件（`apps/mobile/src/widgets/`）在没有模块作用域的环境里执行，不能引用 `FORK` 或任何 import，只能写字面量并注明原因（`AgentActivityWidget.tsx` 的品牌名和 URL scheme）；对应的 `fork:guard` 白名单有三条。
- 新的 MCP OAuth 路由需要 `CloudLink` 和 `ServerEnvironmentIdentity`：隧道的测试夹具和 server 的 harness 都要提供。`DesktopIpc.make` 多了第二个参数（发送方守卫），`PreparedConnection` 多了 `descriptor`，`RemoteEnvironmentAuthorization` 多了 `rememberCheckedDescriptor`。
- 上游把 `clearChunkReloadGuard` 换成了按构建版本记录的守卫，`main.tsx` 取上游，只保留 `uiLanguage.firstPaint`；设置搜索里的 `privacy-policy` 在 fork 里叫 `usage-data`（fork 没有隐私政策链接，那一行写的是遥测默认关闭）；`useComposerSend.ts` 不能把 `recordPromptSent` 的 import 带回来（fork 不弹 GitHub star 提示）。
- `@noble/curves` 是 `apps/mobile/src/fork/deviceKeys/deviceKey.ts` 在用的，上游从 mobile 的 `package.json` 里去掉了它，合并时保留；去掉 gt 后再跑一次 `vp i -- --registry=https://registry.npmjs.org/` 才能让 lockfile 和链接对齐。
- `T3CodeImport` 按列名通用地复制所有带 `thread_id` 的表；上游新增由 trigger 维护的派生表（`orchestration_v2_projection_turn_item_counts`）必须加进 `EXCLUDED_TABLES`，否则旧源库里没有这张表会生成空列的 `INSERT`，新源库里会重复计数。以后上游新加带 `thread_id` 的派生表照此处理。
- Windows 计划任务的文件夹和任务名（`serviceLauncher.ts`、`bootService.ts`）用 `FORK.bootServiceName`，不要和官方的 `t3code` 撞车；上游新增的 bootService 测试要把 `t3code.service`、`t3code-task.xml`、`/TN t3code-…` 换成 `FORK.bootServiceName`。
- 上游的 `/oauth/token` 现在只检查 DPoP proof、不再记录 jti（未认证请求不写磁盘），所以重放同一个 jti 不再是它的失败。fork 的 `/oauth/t3x-device` 在设备 pass 验证通过之后才检查 DPoP，仍然记录 jti 并拒绝重放；`DeviceAssertionAuth.test.ts` 的 T4 不再拿 `/oauth/token` 的重放结果做对照。
- 上游测试里写死 `~/.t3` 默认目录（如 `cli/theme.test.ts` 的 dev server 用例）、`t3/` 分支前缀、`T3 Code`（`DeviceToolchain` 的提示在 contracts 里是 `T3 Extend`）、`# Added by T3 Code`、`t3` 命令名、Tailscale 的 443 端口时，换成 `WORKTREE_BRANCH_PREFIX`、`FORK.appBaseName`、`FORK.cliCommand`、`FORK.tailscaleServePort`。
- 11-17 同步（`55c134a346`）按规则 1 删掉了两处 fork 补丁，换成上游实现：Antigravity 从 PATH 找 `agy`（上游 `0058a4abb3`，`AntigravityInstallation.ts` 和测试与上游逐字相同，fork 的 `isAcpCli` 探测——`--version` ≥ 1.5.0 加 `acp --help`——没有了，代价是 PATH 上叫 `agy` 的其他程序不再被拒），和连接目录的 `decryptDocument`（上游自己加了逐字相同的一份，`DesktopConnectionCatalogStore.ts` 里 fork 的那份和它的 `// fork:` 标记已删）。以后上游改这两处，不要再补回来。
- 手机语言入口用上游的：设置 → 通用里那一行（上游 `16695c812f`），`SettingsLanguageRouteScreen.tsx`、语言搜索词都取上游。fork 以前的「外观 → 语言」从 GT 同步起不再保留。
- `messageTimestamp.ts`：上游把格式化器改成跟随系统时区的缓存；fork 的缓存按界面语言分（中文 24 小时制），`createMessageTimeFormatter(is24Hour, locale, uiLocale)` 多一个参数，`useMessageTimeFormatter` 传 `useUiLocale()`。`hasUnseenCompletion` 在 `threadGrouping.ts`，上游 `40dcbc5f6a`（已停止的运行不算未读完成）要搬到那里，不是 `Sidebar.logic.ts`。
- `ComposerAttachmentStrip` 的上传失败原因是英文原文存进状态、显示处才 `t(upload.reason)`，新增失败原因要同步 `clientErrors.ts` 目录。`RunFold` 多了 `labelTemplate`（`"Working"` 等），翻译在显示处按模板做。
- 共享的纯函数加翻译时，`t` 放最后且默认英文（`t: Translator = translatorFor("en")`），上游测试用更少的参数调用时不用改。
- 新增的 fork 测试夹具别写死 `.t3`：`cli/config.test.ts` 的默认 home 用 `FORK.homeDirName`；`T3CodeImport.test.ts` 里“持锁命令”改的是 branch，不是 title——上游现在改 title 会同时排一个 `provider-session.apply-thread-title` 效果，导入把它当成“忙”。`DesktopApp.test.ts` 的桌面夹具要给 `resourcesPath`（launcher shim 会写 bundled frpc 路径）。
- 手机 `thread-task-permissions.test.ts` 的 mock 要带圆环用的 `historyAtom`（返回 `{ hasMoreHistory: false }`）、`useEnvironmentScope`，provider 夹具要有 `slashCommands`；这些在 main 上本来就缺。
- `scripts/fork-identity-guard.ts` 白名单加了两处：`cli/config.ts` 注释里“Bare `t3 pair` prefers a linked worktree's `.t3`”，和 `themeCss.ts` 里“the stock T3 Code theme”（上游内置主题 id `t3-code`）。PR 页的“没有项目”文案现在说 T3 Extend。
- `vp run check:changed 6417151c09` 的测试一步（1564 个文件）在这台 Mac 上会超过它自带的 900 秒上限被杀，不算失败；合并后按包分别跑 `vp test run`（`contracts`、`shared`、`client-runtime`、`tailscale`、`desktop`、`mobile`、`server`、`web`），lint、format、knip、typecheck 和 react compiler 几步在 `check:changed` 里是整仓库跑的。
- 11-24 同步（`a7a6126a7d`）的取舍：
  - 翻译 JSON 取上游后，fork 在 `zh.json` 里手加过、没进 `gt-zh-overrides.json` 的中文句子会丢（书签、账号用量、定时任务等 34 句）。同步后拿合并前的 `zh.json` 对一遍：`fork:i18n-sync` 列出的「没有中文」的 key，在旧 `zh.json` 里有中文的，补进 `messages`（键是英文原句）。以后 fork 自己新增的 GT 句子一开始就写进 `messages`，不要手改 `zh.json`。
  - 上游的浮动主题编辑器改动按删除处理，要紧的搬进工作室：`ThemeColorPicker.tsx`、`ThemeCssEditor.tsx` 是共用的，上游修补自动合进；拾取颜色前让输入框失焦提交的那一行补在 `useColorInspector.ts`，hex 输入框的测试搬成 `ThemeColorField.browser.test.tsx`。
  - Android 导航栏的 fork `labels` 属性删了，用上游的 `tabTitles` / `expandedTabTitles` / `newThreadTitle`；三条读屏用的 contentDescription（展开、收起、关闭导航栏）现在是英文。手机端 Markdown 选区菜单整文件取上游。键盘快捷键里「新增快捷键」的命令选择改成上游的 Combobox，fork 给 Select 补 `items` 的补丁和测试删了。
  - 上游删了助手回复下方的「改动文件」卡片（`1c6d41a9ba`），侧栏头部的「添加项目」按钮合进项目筛选按钮（`dbb5bdb582`）：都跟上游；「产出」条（`AssistantOutputsStrip`）留在回复正文后面，侧栏视图切换（`SidebarViewToggle`）留在头部。
  - `AntigravityTurnOutcome.ts`：`API_ERROR` 和 `STATUS_ERROR` 是上游的，fork 的 `QUOTA_EXHAUSTED`（兼容 agy 1.5.15 的 JSON 写法）和 `JSON_API_ERROR`（头一行缺失时的兜底）保留，顺序 `API_ERROR` → `STATUS_ERROR` → `JSON_API_ERROR`。`packages/provider-acp/src/server/adapter.ts` 里 fork 的切号重发（`recoverFromUsageLimit`）和上游的 `resumeWith` 重发并存，条件互斥；上游给 `watchPromptInactivity` 加了 `checkPromptOutcome` 参数，切号重发的那次调用要传。
  - `storageCleanup.ts`：共享 worktree 的闸门（`sharedWorktrees.refusal`）放在上游的任务文件夹判断（`taskFolders.find`）之前；`git clean` 和移除仍在同一个 `exclusive` 区段里，上游的 `worktreeAdminDir` 和 `noteLeftover` 也在区段里。
  - `http.ts` 取上游的签名 URL 脱敏写法：`SIGNED_URL_ROUTE_OPTIONS` 加了 `export`（带 `// fork:`），主题背景上传路由（`fork/themeBackground/route.ts`）也用它；上游删掉了 `isSignedUrlRequest`，不要再往里加路由前缀。
  - `migrate-dev-db.ts`：上游新加的「目标库不能是活库」检查（`dropResumableFamilies`）只认 `~/.t3`，fork 改成和 `runMigrateDevDb` 一样，同时保护 `~/.t3extend` 和 `~/.t3`（`devSeedHomeCandidates`）。
  - `LINK_CLIENT_NAME_PREFIX`（peer link 的会话名前缀）在 fork 里是 `${FORK.appBaseName} · `。
  - `apps/mobile/app.config.ts`：`version:` 一行保持上游原样（`.github/scripts/set-mobile-version.cjs` 按这行的形状改写，它的测试读 fork 的 app.config），fork 的发布号后缀在 `config` 之后追加。
  - `packaging/fork-macos/entitlements.plist` 同步了上游新加的 `com.apple.security.automation.apple-events`；Info.plist 多了 `NSAppleEventsUsageDescription` 和 `NSSpeechRecognitionUsageDescription`（用 `FORK.appBaseName`）。上游新加 macOS Apple Speech 原生助手（`native/apple-speech`，打包时由 `build-apple-speech.mjs` 用 swiftc 编进 `Resources/apple-speech`）：下一次出 DMG 要启动 app 实测，并确认助手二进制被 `fork-dist-mac.ts` 签上。
  - `fork:guard` 新增白名单：`RemoteRequestHeaders.ts` 的注释、移动端新场景 `terminal-latched-modifier-reads-selected.e2e.ts`、Labs 与 mobile 里「agent 反馈」的三句 T3 Code 文案（报告发给 T3 团队，见下）。工作流页的文档链接改成 `FORK.releaseRepository`。
  - 上游新增 Labs「Agent feedback」（`fe9c98c98f`）：报告经 `analytics.record("agent.feedback")` 发往上游的遥测地址，fork 遥测默认关，所以只有 `T3CODE_TELEMETRY_ENABLED=true` 才会发出；fork 里隐藏：`ServerEnvironment.ts` 的 `capabilities.agentFeedback` 是 false（web 和 mobile 都按它隐藏），server 的两处读取（`ProviderSessionManager` 的每轮指令、`McpHttpServer` 的工具注册）固定为 off，从官方版导入或手改 settings.json 的 mode 都不生效；导入也不复制 `agent_feedback` 和 `workflow_steps`。
  - 上游新增 `TRADEMARK.md`（商标政策）；README 许可段保留 fork 原文，加了一句指向它。
  - `T3CodeImport`：上游又新增一张由触发器维护、`WITHOUT ROWID` 的派生表 `orchestration_v2_projection_thread_item_counts`（迁移 102），已加进 `EXCLUDED_TABLES`，和 `turn_item_counts` 同理；通用复制按 rowid 翻页，碰到它会 `no such column: rowid`。以后上游新增这类表照此处理。
  - 书签表（`ThreadBookmarkStore.ensureThreadBookmarkTable`）在 `ProjectionStore.layer` 构建时建表，而导入会在官方版的只读连接上构建同一个层，原来会因 `attempt to write a readonly database` die，整个导入的测试（61 条里 56 条）各等满 120 秒。现在遇到只读库就跳过建表（官方库不会有书签），有回归测试。教训：fork 在上游层构建里加写操作时，要想到只读连接。
  - 合并后 `AgentContextBudget` 的 `mcpToolListJsonBytes` 是上游新值 + fork 自己的 685 字节（62740）；`T3_CLI_COMMANDS`（反馈主题清单）要含 fork 的 `t3 devices …` 九条；`ServerTunnel.live` 不能再断言 `server.probe` 返回空对象（上游加了 `serverTime`）；Codex 的 Stop 测试要用 `approval-required` 和 `untrusted` 回放，因为上游让 full access 自己放行命令审批（`bootService.test.ts` 同理要用 `FORK.bootServiceName`）。
  - 服务端新增的清理原因要同步 `apps/web/src/fork/storageCleanupReasons.ts` 的模板和 zh-Hans 目录（这次 5 条来自 `storageCleanup.ts`，2 条来自 `TaskFolders.remove`，后两条登记在测试的 `FROM_OTHER_FILES` 里）；新增的非字面量原因变量要在测试的 `CLASSIFIED` 里归类。`timelineLabels.test.ts` 之前一直跟着旧措辞（运行了），目录从 `46eec14b22` 起是“工作了”，已改测试。
  - 合并后在纯净 `upstream/main`（`a7a6126a7d`）上同样失败、与 fork 无关的：`environmentTheme.test.ts` 的两条 "linked theme directory's … grandparent"（各等满 120 秒）。
  - 走查（11-25）补的四处，都是同步前后留下的 fork 缺陷：`SETTINGS_SECTION_LABELS` 被写成了普通字符串（GT 提取不到，设置页标题在所有语言下都是英文），已改回 `msg()`，有测试读源码守着；以后改这张表不要去掉 `msg()`。重启后续跑的通知摘要（`RestartContinuation.ts`）改用 `packages/shared/src/forkNotices.ts` 里的常量（品牌来自 `FORK.appBaseName`，登记为客户端会翻译的系统通知），`fork:guard` 的品牌扫描也覆盖了这个文件；`ProviderRuntimeRecoveryService` 的 "Cancelled because the server …" 是上游的英文原句，没有品牌，保持英文。上下文圆环：`deriveLatestContextWindowSnapshot` 的实时用量分支在 turn 报告没有 `maxTokens` 时回退到 provider thread 的 `contextUsage.maxTokens`。主题工作室的 hex 输入框（`HexValueInput.tsx`）和上游 `ThemeColorField` 一样先存草稿、短 hex 在失焦时才提交。
  - 同步后 pnpm 锁文件自动合并是坏的（`ERR_PNPM_LOCKFILE_MISSING_DEPENDENCY`），要 `vp i -- --fix-lockfile --registry=https://registry.npmjs.org/`；整仓库并发 `vp run -r typecheck` 会被 OOM 杀掉几个包（退出码 137），用 `vp run -r --concurrency-limit 3 typecheck`，server 单独跑。`check:changed` 的基准用上一次同步到的上游提交（这次同步后是 `bc0f04da94`）。

- 11-27 同步（`v0.1.13`，`bc0f04da94`）的取舍：
  - Antigravity 读额度：上游 #43026 删了，fork 保留但每个实例默认关（`readUsageLimits`），做法、保留了哪些共享代码、关闭时界面怎么表现见“Antigravity 账号池、自动切换和网络代理”一节开头。关闭后有一个副作用：健康检查原来靠一次额度读成功把“有 token 的实例”升为已登录，现在没有这一步，有 token 的实例在第一次会话或模型刷新成功前显示“未检查”（和上游一样）；没有 token 仍是未登录。CLIProxyAPI hub 读 Antigravity 额度跟上游删掉，`antigravityUsageLimits.ts` 里只给 hub 用的三个导出（`antigravityUserAgent`、`antigravityAccountFingerprint`、`antigravitySummaryWindows`）取消导出，否则 knip 报未使用。
  - Antigravity 身份取上游 `5e37e6db56`：ACP `clientInfo` 始终是 `t3-code` / `T3 Code`（这是给 agy 看的协议身份，不算官方身份泄漏，`fork:guard` 没有报），拒绝 agy 1.5.0（`antigravityServesT3Code`、`OPEN_MODEL_ACCESS_RELEASE`），`makeAntigravityAcpRuntime` 的调用方不再传 `runtimeVersion`（fork 的 `antigravityBackgroundProbe.ts` 也去掉了）。
  - 翻译 JSON 整体取上游再跑 `fork:i18n-sync`：fork 在 `zh.json` 里手加过、没进 `messages` 的 37 句（提示词快捷方式、软链、书签等）按旧 `zh.json` 的原文补进 `gt-zh-overrides.json`；其余没中文的 29 个 key 是单位、占位符这类本来就是英文的。上游删掉代码后留在 fork `catalogs/zh-Hans/` 里的 5 条 stale 句子已删。
  - `docs/user` 以上游 `a03c43363b` 的新文本为底，fork 段落重新放进去：T3 Extend 命名、自建连接、UnifiedPush、桌面 Android 新建标签、Tailscale 8443、Antigravity 沿用 agy 登录、遥测默认关闭、omp 权限、Android APK 更新。`appearance.md` 的主题工作室整节保留 fork 版（它是上游内容的超集）。
  - 上游把 Tooltip 换成 `SharedTooltipTrigger`（`render` 加 `label`，一个共享的浮层）：fork 在文件面包屑里的软链提示用它的 `label`（可以放节点），不要再 import `Tooltip`。`SidebarThreadRow` 换成 `ThreadHoverCardTrigger`，fork 的 `nested`、书签条要放在它的新结构里；`Sidebar.tsx` 上游把 `DndContext` 提了一层，fork 的 worktree 分组和 `nested` 在新缩进上重做；`RightPanelTabs.tsx` 的新建快捷键块移位了，`inactiveCell` 两处守卫要跟着搬。
  - mobile `ThreadRouteScreen.tsx`：上游去掉了 `renderThreadRouteBody`，只剩一处 `ThreadScreenBinding`/`ThreadHeader`，fork 的 `outputs`、`bookmarks`、`onOpenNewBrowserTab`、`compactNowBlocker`、`onCompactNow` 加在这一处。
  - `apps/mobile/scripts/measure-renders.mts` 上游并进共享的 metrics 核心（`scripts/metrics/{server,web,mobile}`，`report:renders` 换成 `report:client`）；fork 在旧文件里只有应用 id 和 scheme 的品牌替换，新脚本里没有这两个字面量，所以直接按删除处理。
  - `bootService.ts`：上游让 launchd 也走 `readLaunchdProblems`；fork 的 `running`（launchd 是否在跑）和 `app-runtime-missing` 照留。`agentContextBudget.json`：`mcpToolListJsonBytes` 是上游新值 + fork 的 685 字节，`codexAdditionalContextBytes` 是上游值。
  - 上游 `release` 打的 tag 里 `apps/*/package.json` 的 version 字段是上一个版本号（v0.1.13 里是 0.1.12），随合并进来；发版由构建设置版本，不改这些字段。
  - `commandPaletteCommands.browser.test.tsx` 去掉了对 `themeEditorStore` 的引用：上游浮动主题编辑器在 fork 里是删除的，`themeEditor.toggle` 现在打开主题工作室（页面导航），held 重复键仍被忽略。

11-27 同步后 native fingerprint 又变了（iOS 和 Android 都变），dev client 和 release APK 要重编：android `4f24b525f55da01cd3eb829e2f318d7d246fb01b`（上一次记录 `f6502672132fb222aa02826df88d4bae3b4b021e`），ios `2047bc58a6c295f16dcca48055c629e7061d4b34`（`d7fe36aece57c8820fee72da95f31bd9970f77cb`）。变化来自 `apps/mobile/modules` 里 t3-composer-editor（粘贴处理）和 t3-voice-transcription（Google 语音）的原生源码、`apps/mobile/package.json`、`app.config.ts`，和新增、改动的补丁（`@exodus/bytes`、`expo-modules-core`、`expo-widgets`、`react-native-keyboard-controller`）。上一次记录是 11-24 的值，见下。

11-24 同步后 native fingerprint 又变了（iOS 和 Android 都变），dev client 和 release APK 要重编：android `f6502672132fb222aa02826df88d4bae3b4b021e`，ios `d7fe36aece57c8820fee72da95f31bd9970f77cb`（在合并后的 worktree 里用 `mobile-native-client.ts` 同样的 `createFingerprintAsync` 调用算出）。变化来自 `apps/mobile/modules` 里 t3-composer-editor、t3-native-controls（Android 导航栏的 `tabTitles` 等、新的 `t3_workflows.xml`）、t3-review-diff、t3-voice-transcription（Apple Speech）的原生源码，`apps/mobile/package.json` 去掉 `@react-native-ai/apple`，补丁（`@legendapp/list`、`expo-audio`、`gt-react-native`）和 `app.config.ts`。上一次记录的是 11-17 的值，见下。

11-17 同步后 native fingerprint 又变了，dev client 和 release APK 要重编：android `293ff81c97f64e71109042178ca54501c0317e38`（上一次同步后 `e24f7b1f451ef44ceabc8fd84aa40b2d6a3415c7`），ios `b65012a323d050406ad4c40287851d00a501ab77`（`0219d8282ef977f5430aea3eba66f09959ec5dc5`）；这次变化来自 `apps/mobile/modules` 里 t3-composer-editor、t3-native-controls、t3-review-diff、t3-terminal 的原生源码、新增的 iOS 原生图片查看器（`T3NativeImageViewer.swift`），以及 `@ff-labs/fff-node`、`@legendapp/list`、`@pierre/diffs` 的补丁和 `apps/mobile/package.json`。上一次同步的情况：android `e24f7b1f…`（之前 `be22d2e60e70dedfaefe026e2e286ebd3fe638d3`），ios `0219d828…`（之前 `86a2097b879654d5c7217577884627a2ff37f161`）。变化来自：`apps/mobile/modules` 里 t3-agent-notifications、t3-composer-editor、t3-highlights（CMake 文件挪位置）、t3-native-controls、t3-review-diff、t3-terminal、t3-voice-transcription（新增实时录音）的原生源码；`expo-audio`、`expo-network`、`react-native-keyboard-controller`、`react-native-image-viewing` 的补丁哈希；本地补丁依赖 `react-native-enriched-markdown` 升到 `1.2.0-t3.16`；`app.config.ts`、`plugins/withAndroidTabletOrientation.cjs`，以及新增的 `nitrogen` devDependency。

11-17 同步后的实测（`55c134a346`）：已知清单之外，`packages/ssh` 的 `tunnel.test.ts` 有 5 条在纯净 `upstream/main` 上同样失败，不是合并引入的；`ThreadCommandExecutor` 多了 `withDeletionLock`，导入测试里自己拼的锁夹具要带上它。`vp run check:changed b9bbfda087` 除测试一步（1018 个文件，超 900 秒被杀）外全过；各包整包测试、`fork:selfhost:test`（208 条）、`fork:selfhost:e2e`（17 个场景）、`fork:loopback-gateway:electron-smoke`（29/29）都跑过。

上游已知问题的状态（这次同步后在这台 Mac 上实测）：这些失败在纯净的 `upstream/main`（`b9bbfda087`）上同样失败，不是合并引起的：`packages/shared` 的 `shell.test.ts`（"captures values when the profile replaces PATH…"）、`GitVcsDriver.test.ts`（4，checkpoint bulk staging ×3 和 hardlink 回退）、`pinnedRuntime`/`selfUpdate`（3，`/var` 符号链接）、`PeerLinks`（"nothing listening…"）、`ServerBrowser`（"title change without navigation"）、`Orchestrator.control-reads`、`ProjectionStore`（`statement.stat is not a function`）、`ManagedProjectFolders`（符号链接 Scratch）、`PortScanner`；`DesktopLinuxUrlHandler`（2）在合并前的 main 上也失败。之前就在清单上、这次的 server 全量里又见到但没有逐个重跑的：`AgentSessionScanner`、`ClaudeSkills`（2）、`UsageService`（3）、`externalLauncher`、`GitVcsDriverCore` 的短目录用例。浏览器测试 `ChatMarkdown.permissions`（2，`Shift+F10` 打开菜单）的测试和代码与上游一致，`app-toggle-diff-panel` 和 `warm up` 发的是 `Control+D` 而默认键是 `mod+d`（macOS 上是 Cmd），都是按代码推断的 macOS 环境问题，没在 main 上单独复跑；`renderScenarios` 要设 `T3CODE_RENDER_REPORT_DIR` 才能跑（设了之后 14 个通过）。`SidebarUpdatePill`、`TaskCancelNativeSubagent` 在整体负载下会超时，单独跑通过。`ChatView.browser.test.tsx` 的 “a shortcut conditioned on rightPanelOpen…” 整文件跑会超时、单独跑通过，原因在上游测试：文件里第一个测试加载的 server 配置留在共享的 atom registry 里，第二个测试装的自定义快捷键没有生效，生效的是默认的 `mod+t`（`rightPanel.new`），而测试按的是 Control+T；Linux 上 mod 就是 Ctrl，所以 CI 能过，macOS 上 mod 是 Cmd 过不了（已在 fork 里加日志确认两种情况下生效的快捷键不同，fork 对这块代码没有改动）。`SpawnWorker.test.ts`（`/private/var` 与 `/var` 符号链接）和 `ProjectSetupScriptRunner.test.ts`（退出码 1 而不是 2，`/bin/zsh` 的行为）同样失败，两个文件和它们的实现 fork 都没改过，与上游 `b9bbfda087` 逐字相同。`fork:selfhost:e2e` 17 个场景全部通过。**i18n：** 上游新增组件里的硬编码英文（158 处 JSX 文本、93 处对象属性，集中在 `UseInAnotherAppDialog`、`WelcomePage`、`VoiceSettingsPanel`、`TextGeneratorsSettings`、`DatabaseStorageNotice`）已整句翻译，夹着 `<code>` 的句子走 `interpolateNodes`，`vp run i18n:report` 的缺失、过期和两节 hard-coded 都是 0；报告扫不到的拼接文案（`Open from a computer to edit on…`、`resetCreditChoices` 的摘要）也已改。**仍欠：** ZIP 预览按文本读取、Android 没有命令面板快捷键、webhook 投递"in under a minute"的措辞没有重新核对。

要出包时，先看上游有没有改 `build-desktop-artifact.ts` 里的 `renderMacPasskeyEntitlements`（以及 electron-builder 的 mac 配置）。新增的不依赖 team 的 entitlements 要同步到 `packaging/fork-macos/`：hardened runtime 缺了 entitlements，app 往往一启动就崩，而 `codesign --verify` 检查不出来。`fork-dist-mac.ts` 还依赖 `--target dir` 的产物位置（`<output-dir>/mac-arm64/*.app`）。所以同步之后的第一次打包，要真正把 app 启动起来验证一遍。

`fork:guard`（`scripts/fork-identity-guard.ts`）除了身份字面量，还会拦住 Tailscale 默认端口写回 443、`refs/t3code/`、`refs/t3/review-guide`、`t3code/pr-`、`WORKTREE_BRANCH_PREFIX = "t3"` 和 `branchNamePrefix` 默认值写回 `t3`。它扫描 `apps/*/src`、`packages`、`scripts` 等代码路径，查找 `com.t3tools.t3code`、`t3code-v2`、`t3code-dev`、`t3code://`、`"\.t3"`、`pingdotgg/t3code`、官方 EAS 和 PostHog 地址。新出现的命中要么改成引用 `forkIdentity.ts`，要么在脚本的 `ALLOWED` 里加一条并写明理由。白名单条目不再命中时，守卫也会报错，提醒删掉它。

自建配对的 server 核心在 `apps/server/src/fork/deviceKeys/`（设备密钥、注册表客户端、清单同步与撤销、`POST /oauth/t3x-device`、`devices.*` RPC、frpc 用的专用回环监听口），协议库在 `packages/shared/src/forkDeviceKeys/`，本机管理入口是 `t3x devices`；设计与取舍见 `research/self-host-device-keys.md`。
上游改动都带 `// fork:` 标记，守住 `devices.*` 只给 `desktop-bootstrap` 主体的边界，不要为了方便放宽到有 `access:write` 的会话。

隧道的 frpc 由 server 托管（`DeviceTunnel.ts`）：加入之后写配置和 ticket（`<state>/fork-tunnel/frpc.toml`，目录 0700、文件 0600，ticket 不在命令行也不在环境里）、启动 frpc、读它的四句拒绝日志（整句匹配，含登录通过后 `NewProxy` 被拒的 `[t3x] start error:`）并只对精确的 `reason` 动作，写进状态和日志的文字先抹掉形如令牌的片段、1→60 秒退避、每 12 小时换 ticket、离开或被移除时停止；`device-public-url.json` 跟着成员身份写和删（`status.json` 与它都是临时文件加 rename 写入；server 每 60 秒重写 `status.json`，`tunnel status` 只信 3 分钟内的文件）。macOS / Linux 上 frpc 在自己的进程组里，由持有 fd 3 的看守兜底：server 被 `kill -9` 也会带走 frpc；Windows 没有这个保证（已知限制）。frpc 只在两处找：`T3X_FRPC_PATH`（桌面版的后端和 `t3x` 启动脚本都指向 app 资源里的 `bin/frpc`），然后 `<T3 home>/bin/frpc`；**不查 PATH**，找到的必须属于当前用户或 root、自己和所在目录 group/other 不可写（Windows 不查），并且 `frpc -v` 输出正好 `0.71.1`（版本表在 `packages/shared/src/forkFrp.ts`，同时是 compose 里 frps 镜像标签的来源，有测试守着）。无头机器用 `t3x devices tunnel install` 下载（`T3X_FRP_BASE_URL` 可换镜像，SHA-256 照样核对，只解出 `frpc` 这一个成员），`t3x devices tunnel status` 看状态。测试专用的环境变量：`T3X_TUNNEL_CA_FILE`（写进 `transport.tls.trustedCaFile`）和 `T3X_TEST_TICKET_LIFETIME_SECONDS`（缩短 ticket 寿命），生产不设。

## 主题工作室

设置里的 Theme studio 页（`/settings/theme`，命令面板的 "Open theme studio"，快捷键沿用 `themeEditor.toggle`）。上游的浮动主题编辑器已经删掉（`ThemeEditorHost`、`ThemeEditorPanel`、`ThemeEditorPanel.browser.test.tsx`、`themeEditorStore`；原来连同删掉的 `useViewportSize` 11-24 起又回到仓库，上游的 `HostedBrowserWebview` 在用）：主题库的 Edit、Duplicate、Create 按钮和快捷键都改成打开工作室，所以只剩一个编辑器。快捷键的命令 id 仍是 `themeEditor.toggle`，现有用户的绑定不会失效，只是显示名改成 "Open theme studio"。同步上游时，如果上游改了被删的这几个文件，冲突按删除处理，要紧的改动再手工搬进工作室。它的"拾取应用里的颜色"（inspector）搬进了 Colors 一节：`useColorInspector.ts` 复用 `themeInspector.ts`，取色时设置对话框临时隐藏（`apps/web/src/fork/appModalPeek.ts` 的 store；`AppRouteModal` 读它：`modal` 关掉让后面的页面不再 inert，再用 `visibility: hidden` 和 `pointer-events: none` 藏起来，不卸载，草稿和滚动位置都在），屏幕上由 `PickHint` 留一条提示；点中后先保持隐藏，把"用到这个颜色的地方"高亮画在露出来的应用界面上（`themeInspector.ts` 的候选元素排除了 `[data-app-modal]`，对话框自己的元素不画），提示条上有"回到设置"按钮；用户点击任意处、按 Esc 或点按钮才回来，不用定时器。回来时高亮已清掉，对话框是干净的，展开"全部颜色"并定位到角色。阶段在 `colorInspector.logic.ts` 的 reducer 里（idle、picking、showing）。`PickHint` 和 Colors 区块都带 `data-theme-editor-panel`，`themeInspector.ts` 靠这个标记跳过拾取工具自己的界面。应用自己在设置打开期间也把对话页设为 `inert`（`ThreadRouteView` 的 `background`），所以 `_chat.tsx` 和 `ThreadRouteView.tsx` 多读一个 `peeking`，取色期间不 inert。`AppRouteModal.tsx`、`routes/_chat.tsx`、`ThreadRouteView.tsx` 因此是又改过的上游文件（带 `// fork:`）。

**look**：主题文件、已保存的主题、环境主题都多一个可选的 `look`（UI 字体栈、代码字体栈、圆角、密度、阴影、聊天宽度、面板毛玻璃），再加一个可选的 `basedOn`（预设 id，供"恢复为预设"）。范围和字体名校验只写一份，在 `packages/contracts/src/forkThemeLook.ts`（`THEME_LOOK_LIMITS`、`ThemeLook` schema），服务端 schema、导入器（`parseThemeLook`，严格，错就报错）和已保存数据的读取（`sanitizeThemeLook`，宽松，夹到范围内）都用它。人或 agent 写的输入（server 读已发布的主题文件、`t3x theme set`、MCP `t3_theme_set`）走 `EnvironmentThemeFileInput`，它的 look 多一道检查：有不认识的键就报错并点名，不再悄悄丢掉；server 发给客户端的 `EnvironmentTheme` 仍用宽松的 `ThemeLook`，新 server 的 look 在旧客户端上照样读得出来；解析和 CSS 变量在 `packages/shared/src/forkThemeLook.ts`。旧客户端和手机端不认 `look` 就忽略，所以 contracts 加的是可选字段。手机端这一轮没做 look。

- 应用：`applyThemePalette` 和 `applyThemeColorPreview` 多调一次 `applyThemeLook`（`apps/web/src/fork/themeStudio/themeLook.ts`），写 `--radius`、`--spacing`、`--shadow-*`、`--theme-panel-*` 和 `data-theme-glass`。字体和聊天宽度不在这里写，它们有用户自己的设置：`appInit.tsx` 的 `startClientAppearance` 订阅 look 的变化，聊天宽度用 `look.chatWidth ?? settings.chatWidth`，字体经 `AppearanceFontPreferences.themeSans/themeCode` 优先于用户的字体。谁生效在工作室和 Appearance 里都写明（`ThemeLookNotice`）。终端面板的字体仍跟用户设置，不跟 look。
- 毛玻璃：`themeLook.css` 只在有背景图（`themeBackground.ts` 给 `<html>` 加 `data-theme-background`）且 `glass > 0` 时生效，静态，没有动画；图片同时画在 body 和对话区，都用 `background-attachment: fixed`，所以侧边栏后面和对话区的图是对齐的。
- 预设：`fork/themeStudio/presets.ts` 放列表，Terminal 在里面；另外 10 个各占 `presetStyles/` 下一个文件（颜色、look、CSS）：Broadsheet 报纸、Swiss grid 瑞士网格、Brutalist 野兽派、Blueprint 蓝图、Manuscript 手稿、Retro windows 90 年代窗口、Ink wash 水墨、Neon 霓虹、Docs 文档、Quiet page 留白，id 都是 `studio-*`，不复用退役的旧 id。Docs 和 Quiet page 带暗色 variant。11-24 又加了 6 个：Editor 编辑器（VS Code Dark/Light Modern 的配色）、One Dark（Atom One Dark/Light）、Solarized、GitHub、Nord、Mochi 麻薯，都带明暗两半；前五个是朴素的编辑器配色，没有 CSS，文件头一行写明配色来源和许可（都是 MIT）；Mochi 是我们自己做的“可爱”预设（奶油底、糖果粉、淡紫消息气泡、大圆角、圆头线条图标，字体用 Trebuchet MS 等系统字，借鉴的只是 raft.build 的气质，不用它的名字、标志、插图和素材）。Solarized、One Dark（浅）、Nord（浅）的个别文字色比原配色略深，为了过 4.5:1。`themePalette.ts` 的 `getPresetThemes` 用 `createVividThemeColors` 建出来，`colors` 里写明的角色盖掉推导值（浅色预设用强调色推导出来的表面会带色，所以每份都把 surface、secondary、muted、accentSurface 写成中性色）。它们像内置主题一样解析（`getThemeDefinition`、`isReservedThemeId`、`installCustomTheme` 的冲突检查），但不进 `shared` 的 `BUILT_IN_THEME_IDS`：那份也给手机端和服务端的保留 id 用，加进去会让手机端的主题列表变长，也会让用户已经发布的 `terminal` 这类 id 被拒。Terminal 的颜色逐项照搬用户的 `terminal.json`，字体、直角、去阴影改用 look，`user@t3 ~ $` 前缀、虚线、扫描线仍是 CSS。预设的个性主要靠 CSS，每份都守这几条，`presets.css.test.ts` 和 `presets.contrast.test.ts` 管着：选择器只从 `THEME_CSS_HOOKS`（`packages/shared/src/themeCss.ts`，也是给 agent 的主题指南）里挑，不写 `body`、`button` 这类标签选择器，不写 `>`、`:nth-child`，不依赖 DOM 层级；预设用到的钩子大多是上游组件本来就带的 `data-` 属性；`data-sidebar-topbar` 是 fork 在 `SidebarChrome` 的顶栏上加的（带 `// fork:`）。加进指南时同步了 `themeCssHooks.test.ts`；`:root` 上的自定义属性一律带 `--t3x-` 前缀，免得撞上 app 或用户自己的 CSS；字体只列系统和常见本机字体，Windows 上落到带中文的回退；不加动画（霓虹的发光是静态 box-shadow，蓝图和霓虹的网格是渐变）；声明值里不能有反斜杠（`applyThemeCss` 会丢掉整条声明），所以符号直接写字符，不写 `\2014`；CSS 加的文字（报纸的“读者来信”和日期线、文档的“你”、90 年代窗口的标题栏）没法过 `t()`，改成默认英文、`:lang(zh)` 下写中文（`<html lang>` 跟界面语言），每条都再写一遍 `content: "文字" / ""`（替代文本留空，读屏跳过；复制消息本来就不含伪元素文字，Chrome 里实测过）；正文对比度至少 4.5:1，颜色只写不透明的字面量（Terminal 除外）。90 年代窗口的侧栏标题栏（11-24 重做）：以前给侧栏加 24px 内边距和一条从 38px 起的蓝条，桌面版会盖住 macOS 的红黄绿按钮，字标那行被挤到下面。现在侧栏顶栏本身就是标题栏：`SidebarChrome` 的顶栏加了 `data-sidebar-topbar`（带 `// fork:`），悬浮的侧栏开关是 `[data-sidebar="trigger"]`，两个都登记进 `THEME_CSS_HOOKS`；顶栏刷成和聊天页眉一样的 52px 蓝色渐变，里面的图标和字用白色，侧栏和聊天页眉都去掉顶部的青色边框，两条标题栏对齐。沙箱没有屏幕录制权限，`screencapture` 抓不到原生红黄绿，所以证据截图是 CDP 抓的真实页面，红黄绿是按 `trafficLightPosition`（x=16、顶栏 52px）画上去的模拟圆点。其余预设在桌面版展开和折叠侧栏时都扫过一遍，没有东西压在红黄绿上。Swiss grid 的侧栏是黑底白页：侧栏行读的是页面的 `--contrast-*` 文字色，所以预设在 `[data-slot="sidebar-inner"]` 里重写了这些变量和状态色；`presets.contrast.test.ts` 现在也按侧栏底色检查这些颜色（图标 3:1，文字 4.5:1），同时把 Broadsheet、Brutalist、Manuscript 的 Approval 标签色调深了。90 年代窗口原来的整页桌面边框（`html::after`）放弃了：没有对应钩子，改成侧栏、页眉、聊天区各自的青色边框。报纸首段的首字下沉保留，选择器写成 `.chat-markdown p:first-of-type:not(:is(li, blockquote) p)::first-letter`，不用 `>`，列表和引用里的段落不受影响。报纸的两栏没做：一段很短的话也会被切成两栏，代码、表格、列表又得让出整行，整理不干净。蓝图的“零件号”小圆标没做：被消息容器裁掉。90 年代窗口的斜面是 inset box-shadow 和边框，弹窗类（dialog、popover、menu、select、toast、tooltip）一起做；它的亮蓝标题栏终点色取 #2a6ab8，白字对比度 5.4。这几个预设的代码块和用户气泡都改成浅底：shiki 在浅色主题下给的是深字，放黑底看不清。
- 退役的预设：OLED Black、Paper、Fjord、Tide、Clay、Graphite、Frosted、Compact layout 已删（id 是 `studio-oled`、`studio-paper`、`studio-fjord`、`studio-tide`、`studio-clay`、`studio-graphite`、`studio-frosted`、`studio-compact`）。已存的方案 `basedOn` 指向它们时照常工作，因为方案自己带着颜色、CSS 和 look；工作室用 `schemeBase`（`studio.logic.ts`）解析 `basedOn`：已保存的主题不算预设，所以导入的主题恰好用了旧 id（比如 `studio-paper`）时，方案也不会把它当成基础，不显示“基于…”，“恢复为预设”（`studio.preset` 为空）不出现，`restoreToPreset` 对空预设直接返回。偏好里选着旧预设时，`isKnownThemePreference` 为假，`parseThemeHalves` 会丢掉它，行为和选着一个已取消发布的主题一样，回到默认主题；`readThemePreference` 读到 `RETIRED_PRESET_IDS`（`presets.ts`）里的 id 时顺手删掉 `t3code:theme`，别的未知 id 不删，因为已取消发布的环境主题可能回来。旧 id 不再是保留 id，同 id 的主题现在可以导入。`studio.logic.test.ts` 的 “a preset that was retired” 守着这几条。`needsBackground` 的机制还在（卡片上的“需要背景图”提示），只是眼下没有预设用它。
- 微调：`studio.logic.ts` 是规则（纯函数，有单测）。改任何东西先 `beginScheme`：已保存的方案原地改，预设、内置主题、环境主题则分叉成新方案（id `<原id>-mine`，名字 `t("{name} (mine)")`，带 `basedOn`），内置的那份不变。保存（11-24）：分叉出来的草稿点 “Save as my scheme…”，问名字后用 `schemeCopyOf` 存成新方案（新 id、不重名、`basedOn` 不变，look/css/颜色整份复制），所以同一个预设可以存很多份、互不覆盖；已保存的方案改动后 “Save” 原地写回，“Save as new scheme…” 另存一份，原来的不动；“My schemes” 紧跟在预设下面，每行有复制，预设卡片显示“我的版本：N”（`schemesBasedOn`）；带未保存改动切换主题（点预设卡、My schemes 的使用）会弹窗问保存、放弃还是继续编辑（`useThemeStudio` 的 `choose`/`resolveSwitch`；导入后的切换、“恢复默认”仍直接切）。草稿存在页面里，实时预览，保存才写进自定义主题库（还是 `t3code:themes:v1`，没有另起存储）；"Revert unsaved changes" 丢掉草稿，"Reset theme to default" 切回标准主题但不删方案，"Restore to preset" 把草稿换成预设的颜色、CSS 和 look（名字和 id 不变，仍要保存）。预设名在界面里经 `t()` 翻译（"终端"），用户自己的方案名不翻译。
- 保存的细节（11-24 review 后）：`schemeCopyOf` 不带走 `collection`、`managed`、`sidebarArtwork`（和 `beginScheme`、`renameTheme` 一致）：带着 `collection` 的副本会在合集下次更新时被 `replaceCustomThemeCollection` 静默删掉，也不会出现在“我的方案”里。另存和重命名的查重都用 `uniqueSchemeLabel`，同时比较存下来的名字和当前语言下显示的名字（英文界面存的 “Terminal (mine)” 在中文界面显示为“终端（我的）”）；重命名撞名时自动加数字。命名弹窗显示存储失败的提示；“恢复默认”和预设卡一样先问；“保存并切换”对没保存过的方案在弹窗里问名字，保存失败时弹窗不关。切换弹窗按目标写法：回到正在编辑的主题或它的预设时说“回到”。Retro 的悬浮侧栏开关是灰色斜面按钮（黑图标），因为它会落在蓝色标题栏上，也会落在没有聊天页眉的页面（用量、问题等）的青色桌面上。侧栏对比度测试（`presets.contrast.test.ts`）现在还查：次要文字和时间对 hover、当前、选中行底色；搜索占位符；字标（强调色，3:1）；以及 app 压成 75%（侧栏标题）和 80%（详情面板）的正文色；`:root.dark` 或 `:root:not(.dark)` 加侧栏的 CSS 规则按明暗分开读。为此 Solarized、Quiet、Nord、Editor、One Dark、GitHub、Docs、Ink wash、Brutalist 的次要色或正文色略微加强，Nord、Editor、Quiet 暗色用了更平的行底色，Mochi 浅色的字标在侧栏里改用深一点的粉（`--primary`）。
- 圆角：`--radius` 之外的各档（`--radius-sm` 到 `--radius-3xl`）原来是在 `--radius` 上加减固定值，圆角 0 时 `sm/md` 为负、`xl` 以上仍有圆角。现在 `index.css` 里每档是 `max(0px, calc(var(--radius) ± 步长 × var(--radius-grow, 1)))`；look 写 `--radius-grow`（半径 ≥ 8 为 1，往下按比例缩到 0），所以半径 0 时每一档都是 0。不带 look 时 `--radius-grow` 不存在，取回退值 1，算出的值和没改之前一样。`--control-radius`（输入框、徽标、侧栏行用的常量）也由 look 的半径写入。
- 亮暗两套：主题可以给亮色和暗色各设一个（`theme-halves`）。工作室编辑或打开某个主题时用 `placeTheme`（`studio.logic.ts`）：已经分开设了就只改正在用的那一半（`setThemeHalf`），没分开才用 `setTheme`。只有人在预设网格、My schemes 的 Use 或 Reset 里明确选一整套主题时才替换两套，这几处上方有 `HalvesNotice` 说明。
- 页面：`fork/themeStudio/ThemeStudioPanel.tsx`、`SchemeDialogs.tsx`、`MySchemes.tsx`、`useThemeStudio.ts`、`themeStudioStore.ts`。"All colors" 用 `colorFamilies.ts` 的角色分组（从旧编辑器搬来）和 `ThemeColorPicker`，"Custom CSS" 复用 `ThemeCssEditor`，"My schemes" 的导入复用 `ThemeImportDialog`，导出复用 `serializeThemeFile`。字号和用户自己的字体仍是 `TypographySection`，折叠在 Fonts 下面。
- 外观和工作室的分工（11-21）：外观只选用哪个主题，工作室才新建、修改、导入。外观主题库的标题栏只剩一个 "Edit in Theme Studio" 按钮（原来的 Create theme、Add theme 去掉，导入只在"我的方案"里），卡片上的 Edit、Duplicate 本来就开工作室。两页各有一句说明和回到对方的入口；工作室的"字号"不再嵌一份 Appearance 的 `TypographySection`，改成链接到 `/settings/appearance#typography`。
- 字体行（11-21）：界面字体和代码字体用上游的 `FontFamilyPicker`（搜索、虚拟列表、每个字体用自己的字形显示），不再有"自定义"和文本框。第一项"跟随外观设置"对应 `look.fontUi` / `fontCode` 未设。装好的字体列不出来时（浏览器不支持或没授权），列表退回 `fontChoice.logic.ts` 里一份常见字体，只留本机有的；打开下拉框是用户手势，授权弹窗从这里触发。代码字体只列等宽的。存下来的仍是 `isThemeLookFontStack` 认的字体栈：`"Georgia", serif` 或 `"JetBrains Mono", monospace`；预设自带的多字体栈显示第一个字体，再选它不改栈。`FontFamilyPicker.tsx` 多了三个带 `// fork:` 的可选参数（`defaultLabel`、`fallbackFamilies`、`acceptFamily`）和打开时的 `discoverInstalledFonts()`。
- 背景图（11-21）：工作室的 Background 里有"选择图片…"和"移除"。图片存在服务器上，按内容的 SHA-256 命名：`<themes 目录>/backgrounds/<hash>.<jpg|png|webp>`，同一张图只存一份，类型只看魔数（不看扩展名和声明的类型），上限 16 MB，最多 64 张。方案的 `look.background` 记这个 hash（`ThemeLook` 新字段，`THEME_LOOK_KEYS` 里；同一份 schema 管服务器、导入和 `t3_theme_set`）。方案是浏览器本地的，所以别的设备要有这个方案（导出再导入）才有这条引用，图片本身在同一台服务器上谁都能取。上传走签名 URL，跟附件一样：RPC `themeBackgrounds.createUploadUrl`（要 `AuthSettingsWriteScope`，在 `FORK_THEME_BACKGROUND_GUARDED_RPC_SCOPES`）只发一个十分钟有效、绑定字节数的 URL，字节 POST 到 `/api/theme-backgrounds/upload/<token>`，路由读满 `sizeBytes`、嗅探、哈希、原子写入，回 `{ hash }`。取图是新的资源标签 `theme-background-image`（`AssetAccess.ts`），客户端在 `themeBackground.ts` 里和已发布主题的 `<id>.<ext>` 走同一套下载、重试和 blob URL，`look.background` 优先；最近一张图的 blob 留着，预览预设再移开不会重新下载。服务器不会删图：它看不到别的浏览器里哪些方案还在用，删了会让导出再导入的方案丢图；用数量上限兜底，满了上传会被拒并说明去哪里删。导出的方案只带 hash 不带图片，界面上有一行说明。手机忽略主题的 look，所以不显示背景。代码：`apps/server/src/fork/themeBackground/`、`packages/contracts/src/forkThemeBackground.ts`、`apps/web/src/fork/themeStudio/backgroundUpload*.ts`。
- `useThemeStudio` 的 `applied` 现在先从订阅的方案列表里找：React Compiler 看不出 `getThemeDefinition` 读的是同一份缓存，id 不变时会一直用旧定义，所以改完已保存的方案再点应用，行里还是旧值。
- 服务端：`t3_theme_set` 的描述、`THEME_GUIDE`、`t3x theme set` 的参数说明各加了一句 look。工具描述变了，`evals/mcp-tool-use/cases/themes.ndjson` 加了一个 look 的用例。
- 翻译：`catalogs/zh-Hans/themeStudio.ts`。颜色角色 "Input" 用 `"theme color|Input"` 区分，因为通用的 "Input" 是对话的"待输入"状态。

改了的上游文件（行都带 `// fork:`）：`apps/web/src/themePalette.ts`（look 与 basedOn 的类型、读取、解析、导出，预设的构建和查找，应用路径）、`appInit.tsx`、`appearanceFonts.ts`、`themeBackground.ts`、`main.tsx`（多引一个 css）、`routeTree.gen.ts`（新路由，由 router generator 生成）、`components/CommandPaletteThemeItems.tsx`（"Toggle theme editor" 换成打开工作室，Change theme 列表加预设）、`shortcuts/commandPaletteCommands.ts`、`components/settings/` 下的 `AppearanceSettingsPanel.tsx`、`ThemeSettings.tsx`（编辑按钮改为打开工作室，预设进列表，导出 `downloadThemeFile`）、`ThemeImportDialog.tsx`（冲突时的复制走上游的 `renameTheme`，fork 在里面保留 look 和 basedOn）、`ThemeColorPicker.tsx`（只导出 `ThemeColorPicker`）、`KeybindingsSettings.logic.ts`（`themeEditor.toggle` 的显示名）、`hooks/useTheme.ts`（`useThemeHalvesStored`，订阅 halves 的变化）、`components/AppRouteModal.tsx`（取色时让出对话框）、`SettingsScopeSentence.tsx`、`SettingsSidebarNav.tsx`、`settingsSearch.ts`；`routes/__root.tsx`（不再挂 `ThemeEditorHost`）、`index.css`（`--radius-*` 各档带 `--radius-grow`，见下）；`packages/contracts/src/server.ts` 和 `index.ts`；`packages/shared` 的 `themePalettes.ts`（`ThemeDefinition` 加字段）、`themeCss.ts`（THEME_GUIDE）、`package.json`（导出）；`apps/server` 的 `cli/theme.ts`、`mcp/toolkits/theme/tools.ts`；`scripts/i18n-report.ts`（一条白名单）。背景图（11-21）又动了：`apps/server` 的 `assets/AssetAccess.ts`（新取图标签）、`ws.ts`、`http.ts`、`server.ts`、`observability/RpcInstrumentation.ts`，`packages/contracts` 的 `assets.ts`、`rpc.ts`、`clientRpcPermissions.ts`，`components/settings/FontFamilyPicker.tsx`。同步上游时 `themePalette.ts` 最容易冲突：`parseStoredTheme`、`environmentThemeDefinition`、`parseThemeFile`、`serializeThemeFile`、`applyThemePalette` 里带 `// fork: theme look` 的行要确认还在。

## 右侧面板分屏（最多 2×2）

对话页的右侧面板可以拆成最多四格：标签右键菜单的 Split right / Split down、把标签拖到格子边缘、拖到另一格的标签栏或内容区都行。只有对话页的右侧面板能拆；PR 列表、Issues 页、窄屏的抽屉和手机端不拆。

- 数据：`rightPanelStore` 里每个线程多一个可选的 `layout`（存储版本 16→17）。`surfaces` 和 `activeSurfaceId` 保持扁平，`activeSurfaceId` 恒等于焦点格选中的标签，所以上游所有读它的代码照旧。没有 `layout` 就是一格；数据坏了退回一格。形状固定：一刀外切（行或列），每一半最多再垂直切一刀，不是通用的树；同方向的第三刀被拒绝。两列（或两行）的比例各自独立。
- 逻辑都在 `apps/web/src/fork/`：`rightPanelSplit.ts`（布局模型、`reconcileSplit`、`applySplitOperation`，有单测）、`rightPanelSplitGeometry.ts`（最小格尺寸、落点区域）、`rightPanelSplitMenu.ts`、`rightPanelCell.tsx`（格子的上下文和边框）、`RightPanelSplitDivider.tsx`、`RightPanelSplitHost.tsx`（宿主，含拖放）、`rightPanelSplitContents.ts`。中文在 `catalogs/zh-Hans/rightPanelSplit.ts`。
- `reconcileSplit` 挂在 `updateThreadStateMap` 上，带一个意图参数（`choose` 用户选了某个标签、`close` 关闭、`auto` 程序自己改）：所有改标签的老动作都先走原来的逻辑，再被它修成合法布局（删掉已不存在的标签；新标签一律放进焦点格；只有焦点格里的"原地替换"（文件夹导航、设备占位符换成设备）让新标签占旧标签的位置；空格子合并，折回一格就丢掉 layout）。删掉当前标签后上游代码回退选中的那个标签不算用户选择，焦点格不动。已关闭标签的原来格子记在 `homes` 里，但只有"重新打开关闭的视图"会用：`reopenClosedView` 重开前发 `focus-home`，把焦点切到记录的原格（浏览器用旧的 `browser:<tabId>` 查，原格不在就不动），重开的标签随后进入焦点格。普通地再打开同一个标签（同一个 Diff、同一个文件、复用的终端 id）一律进当前焦点格。
- 宿主只渲染一次 `PreviewPanelShell`，格子是同一层 `position:absolute` 的平铺列表（key 是格子 id），重排时内容不卸载。位置来自容器上的 CSS 变量，拖分隔条直接改变量，松手才写 store，没有逐帧写 store，也没有新的持续重绘动画。分隔条两侧各让出 4px：浏览器 webview 画在页面之上，不让出的话两格都是浏览器时分隔条被整条盖住，鼠标抓不到。
- 面板小到放不下当前布局时（每格最小 280×200）折叠成一条带全部标签的扁平标签栏，宽了再展开；窄面板不显示左右拆分的落点。
- 单个 `DndContext` 在宿主里（@dnd-kit，没有引入停靠库）；格子里的标签栏只渲染 `SortableContext`。拖动时 `[data-preview-viewport]` 暂时 `pointer-events:none`，否则 webview 会吃掉拖动。
- 新建标签、关闭标签、单键切标签的快捷键都作用于焦点格；"关闭其他/右侧/全部"限定在被点的那一格。最大化保留分屏。

上游文件里的接线（都带 `// fork:`）：`rightPanelStore.ts`、`components/RightPanelTabs.tsx`（11 行）、`components/ChatView.tsx`、`components/chat/ChatRightPanel.tsx`、`components/chat/RightPanelSurfaceContent.tsx`、`hooks/useRightPanelSurfaceClose.ts`（只多导出 `closeSurfaces`）、`lib/workspaceFocus.ts`（F6 进面板落到焦点格）、`reopenClosedView.ts`、`catalogs/zh-Hans/index.ts`。同步上游时 `RightPanelTabs.tsx` 最容易冲突：`SortableTabList` 的 `DndContext` 跳过、`Frame` 的选择、新建快捷键的 `inactiveCell` 判断、标签的 `data-surface-id` 和 `data-dragging`（拖动时的样式在宿主的 CSS 里）要确认还在。

- 存储版本：`rightPanelStore` 的版本号现在是 17；同步上游时如果上游也升了版本，取 max(上游, fork)+1，别两边撞在同一个数字上。
- 单格时标签的拖动不再限制为水平方向（为了能拖到别的格和边缘）。
- 新标签落点的规则：新开的标签进入焦点格；只有"原地替换"（文件夹导航、设备占位符换成设备）且发生在焦点格里，新标签才占旧标签的位置。其他情况（比如打开附件顺带删掉独立浏览器）一律进焦点格。

没做：手机端不拆（手机本来就是单格）；焦点切换的 workspace 方向键导航目前只认第一格；`vp run i18n:check` 在这个仓库里不是 task，用 `node scripts/i18n-check.ts`。
