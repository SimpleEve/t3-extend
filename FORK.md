# T3 Extend

T3 Extend 是 [T3 Code](https://github.com/pingdotgg/t3code) 的私有二开 fork（`SimpleEve/t3-extend`）。它的 macOS 桌面版（开发版和打包版）、server / CLI 和 Android 应用，都可以和本机安装的官方 T3 Code 同时运行，互不改写对方的数据、命令、服务和更新。Linux 打包还没有隔离，见下文"例外和限制"。

## 身份

所有 fork 身份集中在 `packages/shared/src/forkIdentity.ts`。上游文件里引用它的地方都只改一行，并带 `// fork:` 注释。不能 import 的地方（`apps/desktop/package.json` 的 `productName`、`apps/desktop/scripts/electron-launcher.mjs`、`apps/mobile/package.json` 的 `--scheme`、iOS 小组件、移动端测试脚本）直接写字面量。

| 项                                           | 官方 T3 Code                                    | T3 Extend                                                                   |
| -------------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| 应用名                                       | T3 Code (Beta / Nightly / Dev)                  | T3 Extend (Beta / Nightly / Dev)                                            |
| appId / bundle id / Android 包名             | `com.t3tools.t3code`                            | `com.simpleeve.t3extend`，移动端变体加 `.dev` / `.preview`                  |
| Electron userData                            | `t3code-v2` / `t3code-dev`                      | `t3extend` / `t3extend-dev`                                                 |
| URL scheme                                   | `t3code` / `t3code-dev` / `t3code-preview`      | `t3extend` / `t3extend-dev` / `t3extend-preview`                            |
| T3 home                                      | `~/.t3`                                         | `~/.t3extend`                                                               |
| CLI shim 与 PATH 软链接                      | `t3`                                            | `t3x`                                                                       |
| 开机服务                                     | `com.t3tools.t3code.service` / `t3code.service` | `com.simpleeve.t3extend.service` / `t3extend.service`                       |
| 默认端口（桌面后端、headless server）        | 3773                                            | 3873                                                                        |
| Tailscale HTTPS 端口                         | 443                                             | 8443（`FORK.tailscaleServePort`）                                           |
| 新 worktree 的临时分支                       | `t3/<hex>`                                      | `t3x/<hex>`；官方的 `t3/<hex>`、`t3code/…` 只用于显示                       |
| 自动命名分支的默认前缀（`branchNamePrefix`） | `t3`                                            | `t3x`                                                                       |
| 跨仓库 PR 的本地分支                         | `t3code/pr-<n>/…`                               | `t3x/pr-<n>/…`                                                              |
| 拉取 PR 时备份被重置掉的提交的 ref           | `refs/t3code/pre-refresh`                       | `refs/t3x/pre-refresh`                                                      |
| review guide 的临时 base ref                 | `refs/t3/review-guide/<n>/base`                 | `refs/t3x/review-guide/<n>/base`                                            |
| server 发布源                                | `pingdotgg/t3code`                              | `SimpleEve/t3-extend`（私有，没有发布归档）                                 |
| 桌面更新 feed                                | GitHub Releases                                 | 无，除非构建时设置 `T3CODE_DESKTOP_UPDATE_REPOSITORY`                       |
| 移动端 OTA                                   | 官方 EAS 项目                                   | 无，除非设置 `T3EXTEND_EAS_PROJECT_ID` 和 `T3CODE_MOBILE_UPDATES_ENABLED=1` |
| telemetry                                    | 默认开                                          | 默认关，`T3CODE_TELEMETRY_ENABLED=true` 才上报                              |

git 命名空间（`FORK.gitNamespace` = `t3x`）管的是 fork 往用户仓库里新写的分支和 ref。上游把这些名字写死在 `packages/shared/src/git.ts` 的 `WORKTREE_BRANCH_PREFIX` 和 `PULL_REQUEST_BRANCH_PREFIX`、`GitVcsDriverCore.ts`、`PullRequestReviewGuideService.ts` 里，fork 的改动都带 `// fork:`。

分支谓词分成两个（`packages/shared/src/git.ts`）：`isTemporaryWorktreeBranch` 只认 fork 自己的 `t3x/<hex>` 和 `t3x-<hex>`，所有会改 git 的路径都用它；`looksLikeTemporaryWorktreeBranch` 另外认官方的 `t3/<hex>`、`t3-<hex>` 和旧的 `t3code/…`，只用于显示和元数据，不会触发任何 git 写入。调用方：`ThreadLaunchService.ts` 的 flatten 和首轮重命名、`ProviderEventIngestor.ts` 的子线程分支复查用前者（前两处会 `git branch -m` 或建分支；复查只对 fork 自己重命名过的分支有意义，不写 git）；`GitActionsControl.logic.ts` 的 `resolveLiveThreadBranchUpdate` 用后者（只决定 UI 是否同步线程分支名，不写 git）；`paletteSearch.ts` 的前缀剥离是显示用的正则，同时剥 `t3x`、`t3`、`t3code`；`threadOutboxDelivery.ts`（手机）只调用 `buildTemporaryWorktreeBranchName`，生成 `t3x/<hex>`。后果：导入的官方线程（`t3/<hex>`）不会被 fork 重命名；改动之前 fork 自己创建的 `t3/<hex>` 线程与它们无法区分，同样失去首轮重命名，宁可不动。`packages/contracts/src/settings.ts` 的 `branchNamePrefix` 默认值是同一个字符串（contracts 不能 import shared），`packages/shared/src/git.test.ts` 有用例让两者保持一致。

Tailscale 的默认端口走 `FORK.tailscaleServePort`：`packages/tailscale` 的 `DEFAULT_TAILSCALE_SERVE_PORT`、server 配置默认值、桌面设置默认值和设置页都引用它。发布的地址、配对链接、手机学到的路由都带 `:8443`（`buildTailscaleHttpsBaseUrl` 只在 443 时省略端口）。打开和关闭都只作用在这个端口。443 是官方的端口，fork 永远不对它发 `tailscale serve`：`forkTailscaleServePort`（`forkIdentity.ts`）把任何 443 换成 8443，生效点是桌面设置读取和写入（旧文件里的 443 读成 8443，`enabled` 保留）、`resolveServerConfig` 对 flag、环境变量和 bootstrap 的取值、`t3x pair --tailscale-serve-port` 和设置页的端口输入。桌面和 server 的关闭动作都用启动时配置的端口，所以不会有"关旧端口、开新端口"的步骤落到 443。设置页的端口输入直接拒绝 443（提示"443 已被官方 T3 Code 占用，T3 Extend 使用 8443"，官方应用名来自 `OFFICIAL_APP_NAME`），桌面 IPC 的 payload 也拒绝；只有没人可以问的地方才静默换成 8443 并记一条警告：读取已保存的设置，以及 CLI、环境变量和 bootstrap。

规则是绝对的：fork 只对自己配置的 serve 端口发 `tailscale serve`。上游的 managed policy 检查（`managedLimits.closeTailscaleServeTo`）原来会关掉所有转发到本服务本地端口的路由，现在多一个 `servePort` 参数，同时按端口和后端匹配，只关自己端口上的路由。别的端口上转发到本服务的路由（比如官方也配成了 3873，或旧 fork 在 443 留下的）一律不动，只记一条警告，写明端口和手动删除的命令，服务照常启动。含义：在禁止远程访问的 managed policy 下，旧 fork 在 443 留下的路由只会得到这条警告，不会被自动清掉，用户要按用户文档里的步骤自己删；主机名含糊（`localhost`、`[::]`）的路由仍然不会被自动关。

`vp run dev --share` 用 dev 的 web 端口（5733 加偏移，偏移从路径哈希起、上限约 3000）做 tailnet 端口，永远到不了 443，但范围里有 8443，会清掉并接管 fork 自己的 Tailscale HTTPS 路由，所以 `findFirstAvailableOffset` 跳过 `FORK.tailscaleServePort`。官方应用自己的 `--share` 可能占到 8443，那是官方的代码，改不了，列出。

没有改的：server 的 npm 包名和 `bin`（`t3`，改了会破坏 `--filter=t3`）、`t3code:*` localStorage key（userData 和 origin 已经不同）、版本号、CLI 帮助文本里的命令名。

## 共存保证

- 两个应用各用各的 userData、single-instance lock、T3 home、数据库、`secrets/`、worktree 目录、launchd label 和 systemd unit，互不干扰。
- 桌面版写的是 `~/.t3extend/bin/t3x`，以及 PATH 上的 `t3x` 软链接，不会碰官方的 `~/.t3/bin/t3`、`/opt/homebrew/bin/t3`。
- fork 不会被官方更新覆盖：
  - 桌面构建只认显式设置的 `T3CODE_DESKTOP_UPDATE_REPOSITORY`，不会从 CI 的 `GITHUB_REPOSITORY` 推断 feed。没有 feed 时不生成 `app-update.yml`，菜单里也没有 "Check for Updates..."。
  - server 自更新（`t3x update`、客户端的 "Update everything"、`t3x service install`）从 `SimpleEve/t3-extend` 查询和下载。这个仓库是私有的，没有发布归档，匿名请求在查询 release 或下载 `SHA256SUMS` 时就会 404。已经装好的运行时（带 sentinel 的版本目录）不会被删除或替换，`apps/server/src/cloud/pinnedRuntime.test.ts` 有对应用例。唯一的例外是目标版本目录里上次没下载完的残留：上游逻辑会在下载前先清掉它。
  - 移动端默认关闭 OTA，也不带官方 EAS 的 `projectId` 和 `owner`。
- 配对链接两种都认：fork 客户端能扫官方 server 的二维码（`t3code://pair`），fork 生成的链接是 `t3extend://pair`。
  mobile 把 `pair` 当作 `connections/new` 的别名（`apps/mobile/src/Stack.tsx`），系统相机扫码直接进添加环境页。上游只在 `__DEV__` 下用链接里的 `pairingUrl` 预填表单，release 包会打开空表单。
  Android 冷启动时，启动画面会挡住窗口绘制，这期间弹出的 formSheet 会停在屏幕外。所以冷启动链接的初始 state 先不带弹层，等启动画面隐藏后再 navigate 过去（`apps/mobile/src/fork/initialLinkSheet.ts`）。

例外和限制：

- SSH 远程主机默认装的是同版本的官方 server 归档（`OFFICIAL_CLI_RELEASE_DOWNLOAD_URL`），不影响本机的 fork。
- 没有官方 `.env`，所以 T3 Connect、guest link、passkey 默认都不可用；Android 的移动推送改走自建的 UnifiedPush，见下文。Clerk 回跳绑定的是官方 scheme，即使自己提供 `.env`，Connect 登录也可能失败。
- `t3x service install` 同样需要下载 server 归档，在 fork 发布自己的归档之前会失败。可以用 `T3CODE_RELEASE_BASE_URL` 指向自己的发布镜像。
- Linux 打包身份（`executableName`、`StartupWMClass`、metainfo、`.desktop` 名称）还没有改，fork 的 deb / AppImage 会和官方包冲突。不要在同一台 Linux 机器上同时安装两者。
- `scripts/install.sh`、`scripts/install.ps1`、`scripts/npm-launcher/` 是官方的安装器，默认把官方 `t3` 装进 `~/.t3`。只有上游的 release workflow 会用到它们，而这个 workflow 限定在 `pingdotgg/t3code` 仓库运行。fork 不要用它们安装。
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

- 只在 linked worktree 里开发和测试。主 checkout（`~/projects/t3-extend`）只用来合并和同步上游。
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

界面支持英文和简体中文，入口是 Settings → Appearance → Language（设置字段 `ClientSettings.uiLanguage`：`system` / `en` / `zh-Hans`，与上游开放的 PR #27965 同名）。只在客户端保存，不进 server settings。

方案是零依赖字典，英文原文作 key：`t("Archive thread")`。查不到译文就显示英文，所以上游改了文案只会让译文暂时变回英文；合并冲突时新旧文案都能直接看到。

- 模块：`packages/client-runtime/src/i18n/`。`translate()` 是纯函数，Electron 主进程也用它；`setUiLocale` 先用动态 `import()` 加载 catalog 再切换，英文模式不加载任何 catalog。web 的 hook 是 `apps/web/src/hooks/useT.ts`。
- 术语表和翻译规则：`packages/client-runtime/src/i18n/GLOSSARY.md`。不能在模块顶层调用 `t()`。
- 译文：`packages/client-runtime/src/i18n/catalogs/zh-Hans/<area>.ts`，按界面分文件。

给新界面加翻译：

1. 在上游文件里只把字符串字面量包进 `t()`（组件里 `const t = useT();`），不要顺手重构。非 React 代码用 `translate(getUiLocale(), "...")`，在显示时读取语言。模块级常量保留英文，在渲染处 `t(label)`。
2. 用户内容、面向模型的文案、server 错误、日志不翻译。
3. 跑 `vp run i18n:report`，按 "missing" 列表在对应 area 的 catalog 里补译文，按术语表翻译。
4. 跑 `vp test run packages/client-runtime/src/i18n/i18n.test.ts`：检查占位符一致、没有破折号、跨文件同 key 同译文。

`i18n:report`（`scripts/i18n-report.ts`）扫描 `apps/web/src`、`apps/desktop/src`、`apps/mobile/src`、`packages/client-runtime/src`、`packages/shared/src`、`packages/contracts/src`、`packages/provider-*` 和 `packages/source-control-*`（设置字段标注和安装提示），以及 `apps/server/src/sourceControl`，找出 `t("...")`、`t('...')`、不带插值的 ``t(`...`)`` 一类调用，以及 `translatorFor(locale)("...")` 和 `t(CONST[key])`、`t(CONST.prop)` 这类读模块级常量的调用，列出 catalog 里缺失的 key，以及 catalog 里有、代码里已经找不到的 key（通常是上游改了英文）。判断 stale 时，代码里的字符串字面量、`t()` 的 key、带 `${}` 的模板（插值部分当通配符），以及由 `packages/contracts/src/keybindings.ts` 的 command id 生成的快捷键名称，都算出现过。只报告，不阻断。同步上游后跑一次，把失效的 key 改成新英文。

故意不翻译、但会经过 `t()` 的来源（搜索引擎名、产品名、语言名）在 `INTENTIONALLY_UNTRANSLATED` 里，不算 missing。

"hard-coded" 一节列出没经过 `t()` 的英文 JSX，格式是 `文件:行 [类型] 文本`，按文件分组，末尾分别给出 web 和 mobile 的数量。它用 `vite-plus` 导出的 `parseAst` 解析 `apps/web/src` 和 `apps/mobile/src` 下的 `.tsx`（不含测试），报告三类：含英文单词的 JSX 文本；JSX 子节点里的字符串和模板（三元、`??`、`||` 的每个分支都算）；文本类属性的字面量或模板，包括 `title`、`label`、`placeholder`、`aria-label`、`alt`、`tooltip`、`description`、`detail`、`message`，以及名字以 `Label`、`Title`、`Text`、`Placeholder`、`Hint`、`Message`、`Description`、`Reason` 结尾的属性。`code`、`kbd`、`pre` 里的内容不报，`apps/mobile/src/features/development/` 不扫。同步上游后，web 部分应该是 0，新增的条目就是上游新加的硬编码英文。

"hard-coded (properties)" 一节扫描同样两个目录下的 `.ts` 和 `.tsx`，报告对象字面量里界面类属性（`label`、`title`、`description`、`message`、`detail`、`tooltip`、`text`、`placeholder` 等，以及以 `Label`、`Title`、`Text`、`Message` 结尾的属性）的像句子的字面量。catalog 里已有的纯字面量算作在显示处翻译；带插值的模板查不到 key，总是报告。`runAtomCommand`、`useAtomCommand` 一类调用的 `label` 只进日志，不报。这一节只看 catalog 有没有这句，不检查显示处是否真的调了 `t()`，所以菜单、状态行这类仍要在真实客户端里看一遍。

"compared" 一节报告拿像句子的英文字面量（或全大写常量）去比较（`===`、`switch`、`.includes`、`.startsWith`、`.has` 等），而同一句又在别处经过 `t()` 的代码：比较的那个值一旦被翻译，比较就悄悄失效。比较原始值、显示时才翻译的写法是对的，核实后放进白名单。

白名单都在 `scripts/i18n-report.ts` 里，每一条都写了理由：

- `ALWAYS_ENGLISH_TEXT` / `ALWAYS_ENGLISH_PATTERNS`：在任何语言下都保持英文的文本，比如产品名、格式名和单位、命令行、示例输入（URL、主机名、环境变量名）。
- `SELF_TRANSLATING_PROPS`：组件内部会调用 `t()` 的 `组件.属性`，比如 `SettingsSection.title`。同名的本地组件写成 `文件名#组件.属性`。只对 web 生效，因为 mobile 有同名的不同组件。传给这些属性的字面量仍会进 missing 检查；带插值的模板查不到 key，照样报告。加一条前先读组件源码。
- `PROPERTY_ALLOWLIST`：properties 一节的 `文件` 或 `文件#属性`，比如会写日志的错误对象、worker 的回复、存进设置的值、搜索用的文本、没有渲染的字段。
- `COMPARED_ALLOWLIST`：compared 一节的 `文件#文本`。

确认框：调用方把整句模板翻译好再交给 `ConfirmDialogHost`（`t('Archive thread "{title}"?', { title })`），host 按半角或全角问号拆出标题。

已翻译（约 9,100 条）：

- web 和桌面：全部设置页与用量页、连接与配对、onboarding、命令面板、侧边栏、对话页（标题栏、Git 操作、状态行、输入框、时间线和工具调用摘要、T3 MCP 工具摘要、后台任务标题、各类卡片和横幅、模型选择器）、右侧面板（diff、文件和各个预览器、终端、浏览器、设备）、PR 面板、导读和 PR 列表页、toast（含 PR 操作）、通用确认框、无项目首页、404 和出错页、提示词链接落地页、访客页、`ServerUpdateAction`、相对时间和稍后处理的星期、桌面菜单和原生对话框。hard-coded 一节里 web 部分为 0。
- mobile：首页与对话列表、对话页与 Git 面板（分支与 worktree、提交、默认分支确认）、输入框、新任务、连接与配对、设置各页（含页标题）、通知、浏览器页、PR（列表、筛选、详情、文件、讨论、审查、合并、导读）、终端、文件与 ZIP 浏览、代码审查、用量、归档、语音输入、设备预览、T3 Connect 资料页、诊断、命令面板、工具调用摘要和后台任务、各类提示框和无障碍标签。消息时间、自定义稍后处理、崩溃日志、用量重置、重连等时间跟随界面语言（`uiLocaleFormatTag`）。

新近补上的（不再是英文）：

- Android 底部导航和侧边栏的标签：原生 Compose 模块没有 catalog，由 JS 经 `labels` prop 传入译文（`AndroidWorkspaceNavigation.android.tsx` 里用 `t()` 生成，随语言切换更新；Kotlin 里的英文只是旧 bundle 的兜底）。iOS 的标签页和工具栏无障碍标签也走 `t()`。
- 桌面小组件（Android 和 iOS）：widget 运行时没有 module 作用域和 catalog，所以 `buildSubscriptionUsageSnapshot` 按界面语言生成译文放进 snapshot（`strings`、`checkedAtLabel`、窗口名、重置时间，中文 24 小时制），widget 只读取。`SubscriptionUsageCoordinator` 按语言各取一份 snapshot，切换语言后重新发布。
- 终端默认名 "Terminal N"：服务器生成的名字仍是数据（匹配用），显示处经 `localizeTerminalLabel`（`packages/shared/src/terminalLabels.ts`）译成"终端 N"，包括关闭确认和 mobile 的终端菜单。
- 用量页 12 小时制的 AM/PM：`formatHourShort` 等接受可选翻译函数，中文显示"上午 7 点"。
- 客户端自己抛出的固定英文错误（上传、附件、媒体、SSH 表单、T3 Connect 设置等）：译文在 `catalogs/zh-Hans/clientErrors.ts`；toast 在 `components/ui/toast.tsx` 的 manager 里按文案查表，`connectionErrorMessage` 对兜底的错误文本同样查表，查不到的原样显示。带参数的几条在抛出处用 `translate`。
- dnd-kit 的屏幕阅读器说明和拖拽播报：`apps/web/src/fork/TranslatedDndContext.tsx` 包装 `DndContext`，侧边栏对话列表的 `aria-label` 也翻译了。provider 设置表单的字段标题和说明早已翻译，补上了占位示例（`e.g. --chrome`）。

中文排版层（`apps/web/src/fork/zhTypography.css`，移动端对应 `apps/mobile/src/fork/zhTypography.ts`）的规则：`text-sm` 及更大的字号下调一档、字重变轻、取消负字距；12px 及以下的字号（`text-xs`、`text-2xs`、`text-3xs`、`text-[11px]` 等）保持上游原样，固定和截断的盒子因此不变形。例外只有按位置单独抬高的几处：诊断页里实际渲染汉字的元素（`data-t3x-han-text`，10px 抬到 11px；拉丁和数字单元格带 `data-t3x-latin` 或不带属性，保持 10px）、设置里带该属性的小号 Badge（源码管理状态、自建连接状态），以及供应商徽章里的汉字首字母（`fork/hanBadgeInitial.ts`：只显示第一个字素，10px，徽章尺寸不变）。英文不匹配 `:lang(zh)`，渲染与上游逐像素一致。`T3 Extend` 字标用 `data-t3-wordmark` 恢复英文的字号、字重和字距，这个属性只能放在只包着 T3 字形和后缀的节点上。

还是英文（需要时再排期）：

- 服务器或模型给出的文案：server 返回的错误和状态（如 "Codex provider status has not been checked in this session yet."）、ACP Registry 里各 Agent 的介绍、模型的推理强度名（Low / Medium / High 这类选项标签来自模型能力数据，输入框和设置里原样显示）、快捷键 when 条件、主题名。
- web 里客户端自己产生、会写日志的错误信息（`connection/`、`cloud/linkEnvironment.ts`、各处 `EnvironmentAuthorizationError` 的 `message`、预览 worker 的回复、`files/` 下各预览 worker 的内部错误）保持英文，显示处只有 `connection/errorMessages.ts` 和 `clientErrors.ts` 认识的几条会翻译；文档预览的兜底页名（"Page 1"）、设置搜索里带托管平台名的条目、更新对话框里带渠道名的跳过原因、自定义模型预设的档位值（存进设置，模型选择器原样显示）。
- 桌面预览的标注浮层（`apps/desktop/src/preview/PickPreload.ts`）：十来条固定文案（按钮、占位符、提示）是英文。它跑在被预览页面的进程里，样式来自单独生成的 Tailwind 主题，生成器会从 `PickPreload.ts` 全文抽取类名；要翻译得把界面语言经 IPC 传进 preload 并改动这个文件，所以没有顺手做。用户在里面输入的评论不受影响。中文排版层也不作用于它，见 `apps/web/src/fork/zhTypography.css` 头部。
- mobile：实时活动（iOS `AgentActivity`，widget 运行时里的固定文案）和连接与持久化层的内部错误（`connection/`、`persistence/`）。
- 还没有在真机或模拟器上核对：Android 底部导航译文和小组件。验证时 Agent device access 是关闭的，按 test-t3-mobile 的要求没有改用 adb 驱动，只在 `t3extend-test` 上装好了 dev client；web 已在中文下核对过。

client-runtime 和 shared 里 web 和 mobile 共用的拼接文案（工具摘要、T3 MCP 工具摘要、后台任务标题、稍后处理、Git 菜单、诊断、用量日期等）都用可选的翻译参数：不传时英文输出不变。

mobile：

- 入口是 Settings → Appearance → Language，字段是 mobile 偏好里的 `uiLanguage`（`apps/mobile/src/persistence/mobile-preferences.ts`），取值和 web 相同。旧数据没有这个字段，按 `system` 读（`uiLanguageSettingOf`）。
- 系统语言不加原生依赖：Android 读 `I18nManager.getConstants().localeIdentifier`，iOS 读 `Settings.get("AppleLanguages")`，都取不到时用 `Intl.DateTimeFormat().resolvedOptions().locale`。Android 的值是 Java `Locale.toString()` 格式（`zh_CN_#Hans`），`androidLocaleTag` 先转成 BCP 47 再交给 `resolveUiLanguage`。iOS 优先读用户的语言列表，因为 `Intl` 的默认 locale 可能受 app 声明的本地化限制（没有在真机上验证）。这些都是启动时读一次的常量，改系统语言后要重启 app 才生效。
- 启动：`apps/mobile/src/fork/uiLanguage.ts` 订阅偏好，启动画面要等偏好读出、语言生效后才隐藏。要加载中文 catalog 时最多等 `FIRST_FRAME_LANGUAGE_WAIT_MS`（1000ms），超时先显示英文，加载完再切换。英文不加载 catalog，不增加等待。加载失败保持当前语言，只记一条 warning。
- Android 上 Hermes 的 `Intl` 不管传什么 locale 都给英文星期名，中文也可能按 12 小时制输出。所以星期名走 catalog（稍后处理菜单的 `formatWeekday`、定时任务的下次运行），中文时间用 `lib/time.ts` 的 `uiFormatOptions` 强制 24 小时制。
- 译文在 `catalogs/zh-Hans/mobile.ts`（首页、对话列表、对话页、输入框、连接、通知）、`mobileSettings.ts`（设置各页）、`mobilePullRequests.ts`（PR）和 `mobileWorkspace.ts`（文件、终端、审查、用量、Git 子页面等）。Android 底部导航的标签由 JS 传给原生模块，见上文。

## 侧边栏视图

侧边栏有"按状态"（上游的 Inbox，默认）和"按项目"两种视图，后者在项目文件夹下再按 worktree 分子组。用户说明见 `docs/user/thread-sidebar.md` 的 "Choose a sidebar view"。

- 视图就是上游 Labs 里的 Boring sidebar 设置（`ClientSettings.boringSidebarEnabled`，经 `ensureLocalApi().persistence` 按设备保存，不跨设备同步）：开是"按项目"，关是"按状态"。顶部切换、命令面板两项和 Labs 开关读写同一个设置：`useSidebarViewMode()` 由 `useBoringSidebarEnabled()` 推出（旧的 `legacySidebarEnabled` 也算开），`setSidebarViewMode()` 和 Labs 一样写 `{ boringSidebarEnabled, legacySidebarEnabled: false }`。fork 自己的 store（`apps/web/src/fork/sidebarViewStore.ts`，localStorage key `t3extend:sidebar-view:v1`）只存折叠状态；旧数据里的 `mode` 字段直接忽略，不迁移（升级后最坏显示一次"按状态"，点一下就回来）。折叠 key 带视图前缀（`sidebarGroupCollapseKey`），不进 `ClientSettings`，不改 contracts。
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
- 启动：偏好没读出来之前，Home 和平板侧栏什么都不画，不会先闪一下按状态视图。冷启动时启动画面本来就等偏好，所以默认视图的用户看不到额外延迟。读取失败时立刻显示按状态视图并 `console.warn`；超过 `VIEW_PREFERENCE_GRACE_MS`（1 秒）还没读出来也先显示按状态视图，读出来后切到保存的视图。偏好读出之前用户做的选择（切视图、折叠）先记在内存里（所有列表和菜单共用），界面照常反映；偏好读出后叠加在保存值之上并保存一次，用户的选择优先于迟到的保存值（折叠按目标状态记，不会因为保存值里已有该 key 而翻转）。读出时超过上限的折叠列表只留最新的 200 个（`persistence/mobile-preferences.ts`）。逻辑在 `fork/threadListViewState.ts` 和 `threadListCollapse.ts`，测试在同目录。
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

| 位置                                                                                                                                              | 内容                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `infra/self-host/registry/`                                                                                                                       | registry（Node 24，只用内置模块）：邀请、加入、清单、签名请求、frps 插件（`:8081`）、Caddy `ask`（`:8082`）、`cli.mjs` |
| `infra/self-host/{setup.sh,t3x,docker-compose.yml,Caddyfile,caddy/,frps.toml}`                                                                    | 部署：一条命令装好 registry、frps、Caddy 和默认安装的 ntfy；`./t3x` 是运维 CLI                                         |
| `infra/self-host/{docker-compose.test.yml,Caddyfile.test,e2e/}`                                                                                   | 本机试用的覆盖文件（Caddy 自己的 CA，只发布在回环地址）和 8.1 的故障场景脚本                                           |
| `infra/self-host/advanced/`                                                                                                                       | 旧的共享 token 方案和它的文档                                                                                          |
| `packages/contracts/src/forkDeviceKeys.ts`                                                                                                        | `devices.*` RPC 和注册表的 JSON 形状                                                                                   |
| `packages/shared/src/forkDeviceKeys/`、`forkFrp.ts`、`forkFrpFetch.ts`、`selfHost.ts`                                                             | 协议库（JWS、请求签名、通行证、ticket、邀请、子域名、隧道状态文件）；frp 版本表和带 SHA-256 校验的下载；公网地址规范化 |
| `apps/server/src/fork/deviceKeys/`、`apps/server/src/cli/devices*.ts`                                                                             | 设备身份、清单同步与对账、通行证换会话、隧道监听口、frpc 托管；`t3x devices` CLI                                       |
| `packages/client-runtime/src/fork/deviceKeys/`                                                                                                    | 阻断式授权、发现、环境同步器、邀请解析                                                                                 |
| `apps/web/src/fork/`（`YourServerSettings.tsx`、`deviceKeys*.ts`、`DeviceKeysSync.tsx`）、`apps/web/src/components/settings/SelfHostSettings.tsx` | 桌面里的 "Your server" 设置；旧的公网地址和隧道命令                                                                    |
| `apps/mobile/src/fork/deviceKeys/`                                                                                                                | 手机：密钥、加入、设备页、前台刷新                                                                                     |
| `apps/desktop/src/selfHost/`                                                                                                                      | 保存公网地址、托管旧方案的隧道命令、把自建地址列为配对端点                                                             |
| `scripts/fork-fetch-frp.ts`、`scripts/lib/fork-frpc.ts`、`scripts/fork-selfhost-e2e.ts`、`scripts/fork-selfhost-e2e/`                             | 下载 frpc；打包和端到端共用的缓存；本机端到端                                                                          |

### 上游文件里的接线（都带 `// fork:`）

以 `git grep -n "// fork:"` 为准，同步上游时用它查全；下面是按功能分的清单。

- 公网地址（Advanced）：`packages/contracts/src/server.ts`（`ServerDirectEndpointKind` 加 `"public"`，旧客户端通过 `ForwardCompatibleArray` 跳过）、`packages/client-runtime/src/connection/routes.ts`（`mergeLearnedRoutes` 只接受 https 的 `"public"`）、`apps/server/src/environment/DirectEndpoints.ts`、`apps/server/src/environment/PublicUrls.ts`、`apps/server/src/cli/{config,server,up,auth,pair}.ts` 和 `publicUrlFlags.ts`（`--public-url`、`--clear-public-urls`、`t3 pair --base-url`）、`apps/desktop/src/{main.ts,preload.ts,ipc/DesktopIpcHandlers.ts}`（`DesktopSelfHost`、`t3xSelfHostBridge`；沙箱 preload 解析不了 workspace 包，bridge 名在 `selfHost/selfHostChannels.ts` 里另存一份，`preloadSandbox.test.ts` 比对两边）、`apps/web/src/components/settings/ConnectionsSettings.tsx`。
- 你的服务器，server：`packages/contracts/src/{index,rpc,clientRpcPermissions}.ts`（并入 `devices.*`）、`apps/server/src/auth/{RpcAuthorization,replayMarkers,AuthAttemptLimiter,http}.ts` 和 `observability/RpcInstrumentation.ts`（权限表、重放标记前缀、通行证端点计入限速、两个响应头助手加 `export`）、`apps/server/src/ws.ts`（RPC handler）、`apps/server/src/server.ts`（层、通行证路由、隧道监听口）、`apps/server/src/binCli.ts`（`devices` 子命令）、`apps/server/src/environment/PublicUrls.ts`（读 `device-public-url.json`）。
- 你的服务器，桌面：`apps/desktop/src/backend/DesktopBackendConfiguration.ts`（`T3X_FRPC_PATH`）、`apps/desktop/src/ipc/methods/serverExposure.ts`（把这台电脑自己的设备地址列为端点 `self-host:device:<url>`，隧道 connected 且状态文件够新时标 available）。
- 你的服务器，client-runtime：`connection/{catalog,model,resolver,driver,registry,routes}.ts`、`state/environmentHttpAuth.ts`、`authorization/service.ts`、`rpc/client.ts`；`apps/web/src/lib/runtime.ts` 和 `apps/mobile/src/lib/runtime.ts` 提供真实的 `DeviceKeyAuthorization`；`packages/{shared,client-runtime}/package.json` 加 exports。
- 你的服务器，界面：`apps/web/src/components/{AppSidebarLayout,CommandPalette}.tsx`、`apps/web/src/components/settings/{ConnectionsSettings,settingsSearch}.ts(x)`；`apps/mobile/src/{App,Stack}.tsx`、`features/settings/{SettingsRouteScreen,components/settings-page-targets}.ts(x)`、`apps/mobile/vite.config.ts`。

### 你的服务器怎么工作

- **服务器端**：`setup.sh` 装好整套，只有 Caddy 发布 80 和 443，frps 的控制连接走 Caddy 的 `/~!frp`（wss），7000 不对外。registry 同时是 frps 的插件和 Caddy 的 `ask`，只放行登记过的子域名。镜像全部钉了版本和摘要（frps v0.71.1、Caddy 2.11.7、ntfy v2.36.0、`node:24.18.1-alpine3.24`），`registry/deploy.test.mjs` 检查这一点和"只有 Caddy 发布端口"，升级时一起改。
- **VPS 上已有别的网站**：`docker-compose.host-network.yml` 让 Caddy 用宿主机网络接管 80/443，registry、frps、ntfy 的端口只发布到 `127.0.0.1`（默认 17080/17082/17000/17088/17090，frps 的插件口 8081 不发布）；Caddyfile 的所有上游地址都是带默认值的环境变量（`{$T3X_REGISTRY_API:registry:8080}` 这种），标准装法不设它们。别的网站的配置是 `T3X_SITES_DIR`（默认 `sites/`）里的 `*.caddy`（站点）和 `*.options`（全局选项，如 `default_sni`）。ACME 邮箱可选：`caddy/conf.sh` 有邮箱时写 `email <地址>`，没有时写一行注释（`email {$ACME_EMAIL}` 在变量为空时 Caddy 会拒绝，而且用环境变量就得重建 Caddy）。
  - **按需子域名的站点写成 `*.{$T3X_DOMAIN}`，不能是裸 `https://`**：裸的站点匹配所有名字，客户端不发 SNI（用 IP 访问）时 `default_sni` 指向的证书会被当作 on-demand 去问 `ask` 而失败（实测）。
  - **代价和 `caddy/ntfy.caddy` 的 `tls { on_demand }`**：通配覆盖 `ntfy.<域名>`。真实 `Caddyfile`（ACME 签发者，没有 `local_certs`）会给 ntfy 单列一个排在通配前面的普通托管策略 `[ntfy, 主域名]`：握手时它不会被问 `ask`，又因为在通配范围内启动时也不签，于是永远签不到。ntfy 站点自己写 `tls { on_demand }`，策略变成 `[ntfy, *.域名] on_demand`；registry 的 `ask` 在推送服务器装了（`T3X_NTFY_ENABLED=1`，`setup.sh` 写进 `.env`，compose 传给 registry）时对保留名 `ntfy` 回 200，第一次访问时才签。主域名不在通配范围内，启动时照常签发。
  - **测试用真实的 `Caddyfile`，不能用 `Caddyfile.test` 代替**：`local_certs` 让所有策略签发者相同，Caddy 把它们合并，ntfy 落进排在后面的兜底策略，碰巧走按需，这就是 `9267e46bbb` 的测试在坏配置上也通过的原因。`infra/self-host/registry/caddy-certs.test.mjs` 起真实的 `Caddyfile`（容器的 DNS 指向无处，ACME 联系不到任何 CA），看 Caddy 有没有把问题问给 `ask`：ntfy、电脑的名字问，主域名不问；去掉 `ntfy.caddy` 的 `tls { on_demand }` 就失败。`deploy-config.test.mjs` 另有静态一条：adapt 之后 ntfy 和电脑名字命中的第一条策略是按需的。e2e 的测试栈用 `ntfy-off.caddy`，不装 ntfy，也不测这条。
  - **`setup.sh` 重跑（升级）**：没有再给出的选择沿用已有的 `.env`——`T3X_COMPOSE_FILES`、`T3X_SITES_DIR`、`T3X_PROJECT`、`T3X_HOST_*`、邮箱、推送服务器（`--no-ntfy`/`--ntfy`、`--no-email`/`--email` 显式给出才改）；变量设为空值表示改回默认；显式值和 `.env` 不同时按新值并打印提示。旧 `.env` 只认 `setup.sh` 自己写的格式（`KEY=值`，值里没有空格、引号、`#`、`$`，不写 `export`，键不重复），其他写法直接拒绝，不猜。compose 文件名要过白名单、文件要存在，`T3X_SITES_DIR` 一律写成绝对路径并拒绝 compose 会解释的字符，这些检查都在建目录、写 `.env` 之前做完。
  - **Caddy 的配置是目录，开关是文件的内容**：compose 把 `T3X_CADDY_CONF_DIR`（`setup.sh` 写在数据目录的 `caddy-conf/`，不进仓库）整个挂到 `/etc/caddy/conf`，Caddy 的命令指向里面的 `Caddyfile`；`caddy/conf.sh` 写出这三个文件（`Caddyfile` 或 `--test` 的 `Caddyfile.test`、`ntfy.caddy`、`acme-email.caddy`），`setup.sh`、e2e 测试栈和静态检查都用它。单文件挂载在文件被换掉（`git pull`、`mv`）后容器里还是旧 inode，只改内容又不会让 `docker compose config --hash` 变；目录挂载没有这个问题。推送服务器开关和邮箱不再是 compose 的环境变量或挂载选择，翻转它们不改 Caddy 的定义哈希（`deploy-config.test.mjs` 检查），所以不用重建 Caddy。
  - **`setup.sh` 对 Caddy 的处理**：先 `up --no-deps registry frps [ntfy]`（关掉推送服务器时再 `--profile ntfy rm -sf ntfy`，数据卷保留），再单独 `up --no-recreate caddy`。Caddy 是新建的，就记下配置目录的摘要（`.caddy-conf.applied`，只在启动或重载成功后写）；已经在跑、定义没变而摘要变了，就 `caddy reload`，被拒绝时原样报错并以非零状态退出；定义变了（比较 `compose config --hash caddy` 和容器的 `com.docker.compose.config-hash`）就只提示，要应用加 `--recreate-caddy`，因为重建会让这台 VPS 上别的网站断几秒。线上有一次重跑把 Caddy 和 frps 也重建了：本地试用栈（compose 5.2.0）上只改 registry 的环境变量或镜像，只重建 registry，没复现；`docker compose config --hash` 显示那次升级里 Caddy 和 frps 的定义哈希没有变，compose 源码里也找不到依赖被重建就连带重建依赖它的服务的逻辑，原因没查到。再遇到时比较 `docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' t3x-caddy-1` 和 `docker compose config --hash caddy`。
  - 静态检查在 `infra/self-host/registry/deploy-config.test.mjs`（`docker compose config` 加 `caddy adapt`，需要 Docker，`CI` 有值而没有 Docker 时失败）。
- frp 版本和各平台归档的 SHA-256 在 `forkFrp.ts`，测试检查它和 compose 里的 frps 标签一致。
- **电脑端**：server 托管 frpc（`DeviceTunnel.ts`），frpc 的 `localPort` 指向只绑 `127.0.0.1` 的隧道监听口（系统分配端口），不是主端口。ticket 由电脑自己签，绑定设备 id、子域名和登记代次，24 小时有效、12 小时轮换。每 60 秒向 registry 同步一次设备清单，`GET /v1/devices` 每次都返回完整清单（`online` 和上次出现时间随时间变，`rev` 不变，所以没有条件请求），每次同步成功都推一次快照，界面直接用快照里的状态。同步失败只记 warn 并保留旧清单。
- **撤销**：`./t3x revoke` 或在桌面里移除后，registry 在 frpc 的下一次心跳（30 秒）拒绝它；电脑自己的 60 秒同步发现被移除时，会自清理（状态变成 `removed`，成员身份、密钥、地址清掉，隧道 `disabled`）。其他电脑和手机的会话在各自下一次同步时撤销，已经建立的连接约 20–30 秒内断开。电脑离线时错过的移除，要等它重新连上服务器才撤销。
- **清单的新鲜度**：3 分钟没同步，设置页提示"连不上服务器"；24 小时后警告；7 天后不再接受新的设备通行证，同步上以后恢复。已签发的会话最长再有效 1 小时。
- **子域名**：从名字派生，已移除电脑的子域名留墓碑，不再分配给别人，重新加入的同一台电脑拿到 `mac-2` 这样的新名字；`./t3x release <子域名>` 才能收回。
- **客户端**：设备管理的环境用 `"t3x-device"` profile。`packages/client-runtime/src/fork/deviceKeys/`：`DeviceKeyAuthorization`（`Context.Reference`，缺省实现永远阻断）、`discovery.ts`（先注册表、再 URL 检查、再 well-known 比对，最后才换通行证）、`liveAuthorization.ts`（`device_unknown` 说明对方还没同步，按 1、2、4、8、16、30 秒退避重试约 75 秒，界面显示"等待那台电脑确认…"，其他错误不重试）、`deviceEnvironmentSync.ts`（只动 `t3x-device:` 前缀的环境）、`inviteReading.ts`（粘贴或扫描的邀请，加入前只读不发请求，桌面和手机共用）。盖章只来自 resolver，`staticGuard.test.ts` 规定哪些文件可以调用 `.authorizeDpop(`、`.authorizeDpopHttp(`、`.renewDpopBeforeExpiry(`；`DeviceEnvironmentIndex` 是第二道防线，见 `docs/internals/self-hosted-devices.md`。
- **桌面界面**：设置 → Sharing & access（路由 `/settings/access`）里的 "Your server"（`apps/web/src/fork/YourServerSettings.tsx`，设置搜索条目 `your-server`），旧的公网地址和隧道命令收在 Advanced 里；命令面板的 "Invite a device" 只在桌面端出现。纯浏览器里没有这一块（没有 `t3xSelfHostBridge`，且 `devices.*` 只对桌面 app 自己的会话开放），要在 Electron 里验证。渲染进程没有设备密钥，通行证由本机 server 的 `devices.signAssertion` 签。主进程从 `<T3 home>/userdata/device-public-url.json` 读这台电脑的地址（服务器按 membership 写，离开时删）。
- **手机**：`apps/mobile/src/fork/deviceKeys/`。密钥在 SecureStore（静态加密，不是不可导出；iOS 用 `WHEN_UNLOCKED_THIS_DEVICE_ONLY`，不进备份也不换机；Android 靠 expo-secure-store 插件把 `SecureStore` 排除出备份）。注册表请求用 `expo/fetch`，因为 React Native 的全局 `fetch` 不管 `redirect: "manual"` 都会跟随重定向。`deviceSync.ts` 是不依赖 Expo 的规则层，所以能用 Node 单测；`installDeviceKeysSync.ts` 只在启动和回到前台时刷新（两次之间至少 30 秒），没有后台轮询。页面只读：手机不邀请也不移除。
- **界面规则**：邀请的有效期显示补零的 24 小时制绝对时间（"有效至 01:14"），不倒数。"连不上服务器"提示和"上次出现 X 前"用一个只触发一次的 `setTimeout` 走到下一个变化时刻（`fork/useClockWindow.ts`、上游的 `useRelativeTimeState`），没有 interval；不要在渲染里直接写 `Date.now()` 或 `formatRelativeTimeLabel(...)`，编译器会按入参把结果缓存住。
- **无头机器**：没有渲染进程，用 `t3x devices join / list / invite / remove / leave / tunnel`。`list` 只读本地保存的清单，不联网（同步由 server 做；CLI 另起一次同步会和 server 自己的同步并行，还可能删掉设备密钥）；`tunnel install` 下载钉住版本的 frpc 到 `<T3 home>/bin`，`tunnel status [--json]` 看 frpc 和隧道。数据目录参数是 `--base-dir`（等价 `T3CODE_HOME`）。

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
- `vp run fork:selfhost:e2e`：本机端到端，16 个场景（14 个设备配对的场景，15、16 是远程 localhost 转发的），约 3–4 分钟。需要 Docker Desktop；frpc 来自 `release/fork-cache/`（归档按固定摘要校验，没有就下载；离线时 `--frpc-path <文件>`，它不做摘要校验）。用法：`vp run fork:selfhost:e2e [--port 18443] [--project t3x-e2e] [--frpc-path <文件>] [--keep] [--only 1,2,4,15]`（参数直接跟在后面，不要加 `--`）。`--only` 只跑列出的场景，写某一个场景时用；有依赖的场景要把它依赖的也列上。场景 17 是模块图抓取时间的测量（见下面「远程环境的 localhost 转发」），只有 `--only` 点名时才跑，`vp run fork:selfhost:first-paint` 就是 `--only 1,2,4,17`。
  - 它起 `infra/self-host` 的测试栈（compose 项目 `t3x-e2e`，只发布在 `127.0.0.1:<port>` 和 `[::1]:<port>`），用这个 checkout 的 `apps/server/src/bin.ts` 起 A、B、C 三台"电脑"（各自一个临时 home、空闲端口、`NODE_EXTRA_CA_CERTS` 和 `T3X_TUNNEL_CA_FILE` 指向从 Caddy 容器取出的根证书），"本机 owner"会话用 `--bootstrap-fd` 传随机 token 再走真实的 `POST /oauth/token`，手机是一个 Node 脚本（shared 协议库，私钥只在内存里）。不写钥匙串、不碰 `~/.t3` 和 fork 的真实 home。
  - **场景 15（转发）：** 第三台电脑 D 扮演桌面：它在 B 上的设备会话，加上桌面自己的代理、隧道客户端和环境状态（`apps/desktop/src/fork/loopbackGateway/` 里的纯 Node 模块，不起 Electron；`scripts/tsconfig.json` 把用到的五个文件列进了 `include`；这是跨包源码耦合，先这样保留，长期应该把不依赖 Electron 的代理和隧道模块拆成共享包，由 desktop 和 e2e 一起依赖）。B 的终端经 RPC 打开并写入命令，起 `scripts/fork-selfhost-e2e/gateway-fixture.mjs`（页面、SSE、WebSocket）；D 经 Caddy 和 frps 的隧道把三样都当 `localhost` 读到。一个不是终端起的监听（故意脱离父进程，所以不论脚本由什么启动，结果都是 `not-owned` 而不是被 provider 进程树排除的 `reserved`）经 HTTP 和 `CONNECT` 都被拒。在 B 上移除 D 之后，打开的隧道两端都关闭，D 再请求得到 `unauthorized`。B 只在 macOS 上广告能力，其他平台这个场景只检查它没广告。
  - **场景 16（日志脱敏）：** 检查仓库里的 Caddy 和 frps 配置没有访问日志、没有 `log_credentials`；然后在运行中的 Caddy 里临时加载一份带访问日志的配置，用真票据和哨兵票据各发一次隧道升级，要求访问日志里 `Authorization` 是 `REDACTED`，而 Caddy、frps、registry 的全部输出里都找不到两个票据（哨兵票据每一段都是独立随机内容，整串的每个 12 字符窗口都查；真票据同样查每个 12 字符窗口，只排除同一会话、同一时刻再签的另一张票据里也出现的窗口：票据的固定前缀和键名、会话 id、密钥指纹、时间戳的前几位。这些是同一会话的所有票据共有的，访问日志里 `/ws?wsTicket=` 那张就带着它们，不是这张票据能被用的原因；含唯一数字或签名任何一部分的窗口一律检查。真票据只露出这些共有部分的泄漏查不出来）。加上 `log_credentials` 时 `REDACTED` 那一步会失败；往日志里伪造一行只含票据 claims 片段的内容，场景也会失败，场景分辨得出来。`/ws?wsTicket=…` 的一次性票据在地址里，访问日志打开后会被记下，这是上游的设计，不是网关票据。
  - 端口默认 18443，被占就换一个空闲的；`--port` 指定且被占则报错。`docker-compose.test.yml` 自己写死了 18443，换端口靠脚本写在临时目录里的覆盖文件，不要改仓库里的那个。
  - 只停自己启动的 PID，结束（含失败、Ctrl-C，和 `compose up` 进行中被中断）时 `compose down -v` 并删临时目录；清理在 `up` 之前就登记好，项目名被别人占着时则拒绝启动、不会去 `down` 它。`down -v` 失败时打印 stderr、项目名和手动清理的命令，保留工作目录，整个脚本以非零退出，即使场景全部通过。失败时保留日志目录并打印路径，`--keep` 通过时也保留。
  - 等待只靠事件（进程日志行、`devices.subscribe` 的快照），没有事件可等的才用有总时限的重试。场景执行顺序是 1,2,3,4,5,9,6,8,12,11,13,15,16,7,10,14：7（移除 B）必须在 10（重启 Caddy）之前，否则断言的 404 会变成握手失败，原因见设计文档 7.2；15、16 要用 B，所以在 7 之前。
- `vp run fork:loopback-gateway:linux-check [--image node:24-bookworm] [--registry <url>] [--drop-store]`：在 Docker 的 Linux 容器里跑网关的真实进程测试和排除测试（`ProcessInspector`、`PortAuthorizer`、`PortAuthorizerBatch`、`GatewayExclusions`、`ExclusionsInventory`、`RuntimeSignatures`、`TerminalShellRegistry`，91 条），以容器里的普通用户。这些真实进程测试在 macOS 和 Linux 上都跑（`processFixtures.testkit.ts` 的 `runsOnRealProcesses` 和 `realInspectorLayer`）。约 1.5–3 分钟，需要联网（容器里 `apt-get` 装 `lsof`、`npm` 装 pnpm、`pnpm install` 装依赖）。
  - 把 `git ls-files` 的文件（工作区内容，所以没提交的改动也算；不含 `.repos` 和 `apps/mobile`）用管道送进容器自己的 `/work`，不挂载也不碰这个 checkout 的 `node_modules`。依赖装进容器里，只装 `t3`（server）包及其依赖，`--ignore-scripts`。pnpm 的下载缓存在命名卷 `t3x-linux-check-store`，`--drop-store` 在结束时删掉它；容器不发布端口、不建 compose 项目，结束（含失败、Ctrl-C）时 `docker rm -f`。
  - Apple Silicon 上 `node:24-bookworm` 是 x86_64 镜像，模拟运行，所以不测耗时。结果只是 Linux 的真实进程核对在容器里通过；**Linux 的 B 是否广告能力由 `GatewayAvailability.ts` 决定，这个脚本没有改它**。
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

手机上可以自己新建 Browser 标签页，打开宿主机上的页面。页面在宿主机的 headless Chrome 里渲染，手机只收 JPEG 帧（server 已有的 `/api/preview-stream`），所以 `localhost` 指宿主机，也没有 Android cleartext 和 mixed content 的问题。不改 server 和 contracts；原生 WebView 直连 dev server 涉及同源安全，没有做。用户说明在 `docs/user/remote-access.md` 的 "Browser on a remote environment"。

- 面板：`apps/mobile/src/features/browser/NewBrowserTabPanel.tsx`，嵌在 `BrowserPreviewRouteScreen` 里（路由参数 `newTab`），不是单独的路由。地址规范化和本地服务列表是纯函数，在 `newBrowserTab.ts`：复用 shared 的 `resolveAddressBarInput`，但不回落到搜索；本地服务列表订阅 `previewEnvironment.discoveredServers`，带上项目脚本的 Preview URL。
- 选中哪个标签页、新建模式、等待刚打开的标签页：纯函数在 `browserTabSelection.ts`，计时器和关闭事件订阅在 `useBrowserTabSelection.ts`。`preview.open` 返回的标签页最多等 10 秒（`PENDING_BROWSER_TAB_TIMEOUT_MS`），超时或收到它的 `closed` 事件就停止等待并提示"标签页没有打开"，然后按常规处理：没有标签页就关闭浏览器，有就显示最新的。
- 入口：Android 对话页标题栏的地球按钮（`ThreadHeader.tsx` 的 `onOpenNewBrowserTab`，只在 `capabilities.serverBrowser` 时传）；浏览器标题栏的 "+"（两个平台都有）。iOS 对话页标题栏走原生 header item，没有加入口。
- 权限：`previewEnvironment.open.permissionAtom`（`preview:operate`）。没有权限时入口照常显示，面板里说明原因并禁用输入。
- 推流：手机请求 `quality=60`（server 默认 70）。帧尺寸本来就按视图像素（最多 2x）封顶，没有再改。`PreviewStreamTarget` 加了可选的 `quality`（`packages/client-runtime/src/preview/serverBrowserStream.ts`）。
- i18n：`apps/mobile/src/hooks/useT.ts` 写法同 web，语言设置见上文"多语言"。译文在 `catalogs/zh-Hans/mobileBrowser.ts`；`i18n:report` 也扫描 `apps/mobile/src` 了。

上游文件里的接线（都带 `// fork:`）：`ThreadHeader.tsx`（prop 和 Android 按钮）、`ThreadRouteScreen.tsx`（按 `serverBrowser` 传回调）、`PreviewStreamWebView.tsx`（`PHONE_STREAM_QUALITY`）、`serverBrowserStream.ts`（`quality`）。`BrowserPreviewRouteScreen.tsx`（`newTab` 参数、改用 `useBrowserTabSelection`、"+"、几处 `t()`）、`scripts/i18n-report.ts`（扫描 `apps/mobile/src`）。

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

## 远程环境的 localhost 转发（桌面版）

A 的桌面版打开远程环境 B 的对话时，B 的 T3 终端或 agent 起的、只监听回环地址的服务，可以在内置浏览器里用 `http://localhost:<端口>` 打开：页面在 A 上渲染，请求在后台转到 B 的回环地址。设计在 `research/remote-loopback-forwarding.md`；用户文档是 `docs/user/remote-access.md` 的 “Localhost on a remote environment”。

**怎么工作。** A 的桌面主进程为每个登记过的远程环境起一个只绑 `127.0.0.1` 的 HTTP 代理，该环境所有预览分区用 `session.setProxy` 把回环流量指过去。代理为每条 TCP 连接开一条 WebSocket 隧道（`/api/loopback-gateway/tunnel?port=`，票据放在 `Authorization: T3X-Gateway <票据>`），B 的网关对**每条新隧道**现场核对（进程身份 = pid + 启动时间、监听、归属、排除清单，没有缓存），通过才拨 B 的回环地址。只在加密或本机的连接上启用；B 只有 macOS 广告 `loopbackGateway` 能力（`apps/server/src/fork/loopbackGateway/GatewayAvailability.ts`）。

位置：桌面主进程 `apps/desktop/src/fork/loopbackGateway/`，server `apps/server/src/fork/loopbackGateway/`（监听点清单 `exclusions.json`、驱动特征表 `RuntimeSignatures.ts`），web `apps/web/src/fork/loopbackGateway/`，契约 `packages/contracts/src/forkLoopbackGateway.ts`，共享的回环判定、传输检查和桥的类型 `packages/shared/src/forkLoopbackGateway/`，中文 `catalogs/zh-Hans/loopbackGateway.ts` 加 `desktop.ts` 里的错误页文案。新增文件 97 个：产品代码约 6,100 行（含 `exclusions.json` 361 行和中文目录 67 行），测试和夹具约 10,800 行，Electron 冒烟、Linux 检查和端到端场景脚本约 2,300 行。

### 上游改动清单

相对阶段 9 开始前的 `12ece4aefa`，上游已有的产品文件改了 26 个，新增 132 行、删除 24 行。代码行带 `// fork:`（JSON 和翻译目录除外，多行的块在块尾标一次）。同步上游时最容易冲突的是 web 的 `PreviewView.tsx`、`PreviewUnreachable.tsx`、`browserTargetResolver.ts` 和契约的 `auth.ts`。

| 文件                                                                       | 行         | 改了什么                                                                                               |
| -------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------ |
| `packages/contracts/src/auth.ts`                                           | +5 −2      | 票据用途加 `"loopback-gateway"`；通用票据端点的 schema 加过滤，不签发网关票据（只有网关的 RPC 签）     |
| `packages/contracts/src/clientRpcPermissions.ts`                           | +8         | 受保护 RPC 的 scope 表和 `clientRpcRequiredScopes`（`preview:operate` 和 `terminal:operate` 两个都要） |
| `packages/contracts/src/environment.ts`、`index.ts`、`rpc.ts`              | +1、+1、+2 | 能力位 `loopbackGateway`，导出 fork 契约，并入 RPC 组                                                  |
| `packages/shared/package.json`                                             | +4         | exports                                                                                                |
| `apps/server/src/server.ts`、`ws.ts`                                       | +3、+3     | 网关的 layer 和 RPC handler                                                                            |
| `apps/server/src/environment/ServerEnvironment.ts`                         | +2         | 广告能力位                                                                                             |
| `apps/server/src/observability/RpcInstrumentation.ts`                      | +2         | RPC 指标表                                                                                             |
| `apps/desktop/src/preload.ts`、`ipc/DesktopIpcHandlers.ts`                 | +3、+2     | 桥和 IPC 安装                                                                                          |
| `apps/desktop/src/ipc/methods/preview.ts`                                  | +3 −1      | `getPreviewConfig` 里先装代理再返回 webview 配置                                                       |
| `apps/desktop/package.json`                                                | +3 −1      | `ws` 和 `@types/ws`                                                                                    |
| `apps/web/src/browser/browserTargetResolver.ts`                            | +10 −2     | 转发 `active` 时回环 URL 原样放行；`systemBrowser` 选项                                                |
| `apps/web/src/browser/ElectronBrowserHost.tsx`                             | +2         | webview 等“网关已登记”的门                                                                             |
| `apps/web/src/components/preview/PreviewView.tsx`                          | +13 −1     | 取 fork 的标签页钩子，摆放标识和卡片；转发中的标签页不显示“在系统浏览器中打开”                         |
| `apps/web/src/components/preview/PreviewUnreachable.tsx`                   | +23 −15    | 可选的 `gateway` 卡片文案和按钮                                                                        |
| `apps/web/src/components/preview/PreviewChromeRow.tsx`                     | +3         | 转发标识的插槽                                                                                         |
| `apps/web/src/components/preview/PreviewPanel.tsx`                         | +4 −1      | 离线的远程环境显示“连不上”，不是“请重新配对”                                                           |
| `apps/web/src/components/AppSidebarLayout.tsx`                             | +2         | 挂载取票据和续期的管理组件                                                                             |
| `apps/web/src/components/chat/ThreadServersPanel.tsx`                      | +3 −1      | 系统浏览器打开时不走转发（`{ systemBrowser: true }`）                                                  |
| `packages/client-runtime/src/i18n/catalogs/zh-Hans/index.ts`、`desktop.ts` | +2、+21    | 注册 catalog；桌面主进程错误页的 13 条中文                                                             |
| `package.json`、`knip.jsonc`                                               | +3、+4     | 三个脚本（Electron 冒烟、Linux 检查、模块图抓取时间）；knip 的入口                                     |

另有：fork 自己的 `apps/web/src/fork/FooterPorts.tsx` +3 −1；上游的 5 个测试文件加了用例（`preloadSandbox.test.ts`、`McpHttpServer.test.ts`、`browserTargetResolver.test.ts`、`PreviewView.browser.test.tsx`、`commandPermissions.test.ts`，共 +121 −1）；`pnpm-lock.yaml` +12（`ws`）。合计 132 行里，中文翻译占 23，依赖和脚本清单占 14（`apps/desktop` 和 `packages/shared` 的 `package.json`、根 `package.json`、`knip.jsonc`），其余代码行 95。

### 维护者约束

- **fork 占用了预览 session 的 `webRequest.onHeadersReceived`。** Electron 对每个 session 的每种 `webRequest` 事件只保留一个监听器，后注册的覆盖先注册的。网关用它把代理的错误页变成渲染进程的事件，停止转发时又把它清成 `null`。上游以后要在这些 session 上用 `webRequest`，必须和网关的处理合并，不能直接再注册一个。`apps/desktop/src/fork/loopbackGateway/singleWebRequestListener.test.ts` 在 `apps/desktop/src/fork/` 以外的产品代码里看到 `webRequest.on…(` 就失败。这个扫描只是守护：抓不到别名（`const w = session.webRequest; w.onX(…)`）和经封装函数的间接注册，上游开始共用这个 API 时必须人工审查，不能把它当作完备证明。
- **转发开着时，该环境所有分区里的非回环流量绕过系统代理。** 规则是 `fixed_servers` 加 `proxyBypassRules: "*;<-loopback>"`，这是让非回环地址直连的唯一写法（`<-loopback>` 单独用会把所有地址拖进代理，PAC 抓不到回环地址，设计 §1.1）。用 Clash、公司代理的用户，在转发开着的环境的标签页里，外部网站会直连；标识菜单里有一行说明。停止转发（`disabled-by-user`）后分区恢复为 `{ mode: "system" }`，系统代理重新生效。用 `system` 是因为 app 从没给这些分区设过别的代理模式；上游以后开始管理 session 代理时，要改成保存并恢复真实配置。
- **上游新增 provider 驱动时 `RuntimeSignatures.test.ts` 会失败。** 它要求 `BUILT_IN_DRIVERS` 里每个驱动要么在 `DRIVER_SIGNATURES` 里，要么在 `NO_SIGNATURE` 里写明理由；归属判断只看现读的进程祖先链，认不出的驱动整棵子树都不转发。新增监听点同理：`ExclusionsInventory.test.ts` 把源码里的监听点与 `exclusions.json` 逐项比较，新增的会让它失败，直到有人写上处理方式。这个扫描有盲区（动态拼出的参数、别名导入、`dgram` 和 `http2` 等其他监听 API），是回归护栏，不是证明。
- **安全相关的守卫测试不要绕开：** 票据永远包成 `Redacted`，每个日志和 trace 的出口有测试（`TunnelRedaction.test.ts`），`Caddyfile` 里不能加 `log_credentials`（`fork:selfhost:e2e` 场景 16 会失败）；主进程的 `ws` 不设 `rejectUnauthorized: false`、不跟随重定向、不读系统信任库（`noInsecureTls.test.ts`）；能力位只在 macOS 广告，改 `VERIFIED_PLATFORMS` 之前要先有那个平台的真实进程测试。
- **模块图抓取时间**（设计 §11.1，`vp run fork:selfhost:first-paint`，无浏览器，**不是浏览器首屏**）：抓取 300 个模块的模块图，同机网关约 0.41 秒，经本机的自建隧道约 0.45 秒；注入 50 ms 往返时 3.5 秒（没有网关、直连同样往返的服务 2.7 秒），100 ms 往返时 6.2 秒（5.3 秒）。判据是“同样往返下比直连服务多出多少”：50 ms 往返多出约 0.77 秒，100 ms 约 0.90 秒。隧道建立约 200 毫秒，几乎全是 B 的现场核对。阶段 9 不做预开隧道，用户觉得慢再看。

验证入口：`vp run fork:loopback-gateway:electron-smoke`（真实 Electron，29 个场景，不进 CI）、`vp run fork:loopback-gateway:linux-check`（需要 Docker，在 `node:24-bookworm` 容器里跑 server 的真实进程测试）、`vp run fork:selfhost:e2e`（需要 Docker，场景 15 是转发，16 是日志脱敏，17 的测量只在 `fork:selfhost:first-paint` 里跑）。

### 已知限制

- **连接方式验证了三种：** 同一台电脑上的连接（真实 Electron 走查和冒烟）、Tailscale 直连（两台真实 Mac，用 tailnet 的 IPv6 地址）、自建隧道（真实 VPS，Let's Encrypt 证书）。局域网 https、Tailscale 的 MagicDNS 名字和 Serve 没测；SSH 环境在打包版里跑的是官方 server，不提供转发。重载 Caddy 或重启 frps 会让所有隧道断开几秒，因为 frpc 的控制连接也经过 Caddy。逐行状态在设计 §3.5，用户文档只写已验证的。
- **平台：** 只支持桌面版（网页版见设计附录 C）；B 只有 macOS 广告能力。Linux 的真实进程测试已在容器里全过（91 条，连跑两遍），但广告函数没有改，要不要放开由主控定；Windows 没有读 argv 和环境的路径，不广告。
- **私有 CA 的 `https://` 不支持：** 主进程不并入系统根证书（设计 §3.6，N7），TLS 校验失败就是失败，错误卡片说“证书不受信任”。
- **provider：** 只有 Claude 和 Codex 设置 `T3CODE_THREAD_ID`，所以只有它们的 agent 起的服务算“agent 有主”；其余 provider 的 agent 起的服务只有在 T3 终端里起才转发，Cursor、Antigravity 和 ACP 注册表的 agent 认不出特征，整棵子树都不转发。脱离父进程的后台作业（被 launchd 收养，如 `nohup`）对所有 provider 都转发不了。这些结论来自读启动代码和假运行时的真实进程测试，**没有起真实的 provider CLI 验证**；各家 CLI 的 shell 工具是不是一次性的 shell，因而后台作业会不会被收养，也没有验证。
- **已接受的残余风险**（设计 §5.6.5、§6、§4.2）：CLI 自己起的、带 agent 标记的 MCP 进程如果在回环上监听，会按 agent 作业放行；页面对有主服务有完整的网络接口（Vite 的 `/@fs/`、source map 等），暴露程度等同本机 dev server 对本机浏览器，用户文档要求不在转发的标签页里打开不信任的网站；偷来的票据最多能开隧道到这台设备的会话链结束或被撤销；端口有没有程序在监听能被页面探测到。真实 dev server（当前 Vite 的默认 `server.fs`、`allowedHosts`、CORS）对外部来源页面的实际行为，冒烟里只有模拟的夹具，没有人工走查。
- **小的已知现象：** 同一环境同一端口两个标签页同时加载失败时，没有 `webContentsId` 的 `CONNECT` 拒绝原因可能被两个标签页一起拿来解释（设计 §7.2）；全新分区上的第一个 `session.fetch` 得到代理的 407 且不泄露（Electron 不为它发 `login` 事件，导航之后恢复，实际影响只有 favicon 抓取，设计 §12 的 9.2 第 12 条）；B 重启后右侧面板变成“线程详情”、标签页不回来，是上游预览会话表在内存里的行为。

### 以后再做

- 多路复用或预开空闲隧道：Electron 真实网络走查时用户觉得慢再看（设计 §11.1）。
- 为每次升级签一个 DPoP 证明，让明文局域网也能用（设计 §12 以后再做）。
- 按线程精确归属（要改 contracts）；网页版。
- 验证局域网 https 和 Tailscale 的 MagicDNS 名字、Serve，再把设计 §3.5 的“待验证”改掉，用户文档同步。
- 并入系统根证书以支持私有 CA（要读系统信任库，需要主控同意）；放开 Linux 的广告。
- 做不到也不做：只对某一个标签页关闭转发。代理是 session 级的，一个环境的所有标签页共用。

## 打包与签名

两条命令，都可以直接重跑：

```bash
vp run fork:dist:mac       # → release/fork-mac/T3-Extend-<版本>-arm64.dmg（附 .sha256）
vp run fork:dist:android   # → release/fork-android/T3-Extend-<版本>-arm64-v8a.apk（附 .sha256）
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

entitlements 在 `packaging/fork-macos/`。主程序用 `entitlements.plist`，内容是 `renderMacPasskeyEntitlements` 去掉 team id、associated-domains、keychain-access-groups 和 passkey 后剩下的项：JIT、unsigned executable memory、disable-library-validation、camera、audio-input。helper 和其他嵌套程序用 `entitlements.inherit.plist`，内容就是 electron-builder 默认的前三项，和上游签名构建一致。

Android 流水线（`scripts/fork-build-android-release.ts`）：`APP_VARIANT=production` 跑 `expo prebuild --clean`，并检查 applicationId 是 `com.simpleeve.t3extend`；从 Keychain 读出密码；运行 `gradlew --no-daemon app:assembleRelease`，签名配置用 `android.injected.signing.*` 注入。store file 和 alias 走 `-P`，两个密码走 `ORG_GRADLE_PROJECT_*` 环境变量，所以不会出现在进程参数和日志里，代价是构建期间同一用户的进程能读到这些环境变量；换成临时文件同样防不住同一用户的进程，所以没换。`--no-daemon` 是为了不留一个持有密码的常驻 daemon。build.gradle、`app.config.ts` 和 plugins 都不改，native fingerprint 不变。最后用 apksigner 确认 APK 证书就是 keystore 里的证书。默认只打 `arm64-v8a`，`--abi` 可改。versionCode 固定为 1，不影响 sideload 覆盖安装：Android 只拒绝降级，相同的 versionCode 可以覆盖。以后要上架商店，就要每个版本递增。在 `app.config.ts` 里设置 versionCode 会改变 native fingerprint，所以现在不改。`apps/mobile/android` 是生成出来的目录，之后跑 `mobile:install` 会重新 prebuild 成 development。

安装：

- macOS：打开 DMG，把 `T3 Extend (Beta).app` 拖进 `/Applications`。第一次打开如果被 Gatekeeper 拦下，在 Finder 里右键选"打开"，或者执行 `xattr -d com.apple.quarantine "/Applications/T3 Extend (Beta).app"`。
- 第一次启动时，macOS 会询问是否允许 `T3 Extend (Beta)` 访问钥匙串项 `t3extend Safe Storage`。把弹窗切到前台，选"始终允许"。签名身份不变时，重新打包以后 designated requirement（`identifier "com.simpleeve.t3extend" and certificate root = H"491ecedb…8978"`，即证书的 SHA-1；新证书未设信任，codesign 把这张自签名证书算作 root，T3 Extend Code Signing 时是 leaf）也不变，按理不会再问。这一点没有实测。**从 T3 Extend Code Signing 换到 `T3 Extend Code Signing` 是一次例外**：designated requirement 里的证书 hash 变成新证书的 SHA-1，所以换证书后的新包第一次启动时，会再问一次能否访问 `t3extend Safe Storage`，选"始终允许"即可；以前给 T3 Extend 授过的 macOS 隐私权限（屏幕录制、辅助功能等）也要重新授一次。之后再更新就不会再问。
- 如果点了拒绝，或者想让签名版重新创建这一项，执行 `security delete-generic-password -s "t3extend Safe Storage"`，然后重启 app。旧项里加密保存的本地凭据会随之失效，需要重新登录或重新配对。
- 弹窗没处理时，主线程会一直阻塞在读取 Keychain 上，app 不响应退出，第一次 SIGTERM 也不生效。这时用"强制退出"或 `kill -9 <PID>`。
- Android：`adb install -r <apk>`，或者把 APK 传到手机上安装。它和 dev client（`.dev`）是两个应用，可以并存。

**备份**：把 `android-release.jks` 拷到离线的地方，密码存进离线密码库。读密码要在受控的终端里执行 `security find-generic-password -a t3extend-android-release -s t3extend-android-release -w`，它会把密码打印出来，存好后立即清屏。两者丢了任何一个，以后的 APK 都不能覆盖安装已装的版本，只能先卸载，应用数据会一起清掉。

签名的限制：

- 自签名证书不能公证。拷到别的 Mac 上会被 Gatekeeper 拦下，要用上面的右键打开或 `xattr`。本机关闭了 Gatekeeper 评估（`spctl --status` 显示 `assessments disabled`），所以本机上 `spctl -a -t exec -vv` 显示的是 `accepted` / `override=security disabled`，看不到拒绝。
- passkey 和 Associated Domains 需要 Apple 签发的 provisioning profile，不可用。
- 只打 arm64，没有 universal 版本，也没有 Linux 和 Windows 的 fork 打包。

## 从 T3 Code 导入

设置 → 维护 → "Import from T3 Code"。读取本机官方 T3 Code 的 `~/.t3/userdata`（只读，开发时可用 `T3CODE_IMPORT_SOURCE_HOME` 指向副本），把选中的项目、对话、定时任务和设置带进正在运行的 T3 Extend。服务在 `apps/server/src/fork/T3CodeImport.ts`，只有 host 上的 server 能读 `~/.t3`，所以入口放在设置页，靠 `capabilities.t3CodeImport` 判断，手机端不提供。

- **不碰官方数据**：源库只读打开，整个导入在一个读事务里完成，所有行来自同一时刻。版本比 T3 Extend 新就拒绝（"先更新 T3 Extend"）；更旧就在 `userdata/t3-import-*` 里建一个只含所选行的暂存库、迁移后再读，用完删除（见"升级路径"）。预览和预检（`preview` / `check`）只读，不写记账表、不碰 git，测试里有断言。
- **对话换新 id**：源 id → 目标 id 由 sha256 派生，同一个源永远得到同一个目标，重跑和续跑都幂等。行里所有出现旧 id 的文本（scope id、run id、检查点 ref 等派生名）一并替换，所以两个应用继续同一个对话时互不覆盖检查点。检查点 ref 用 `git update-ref --stdin` 的 `create` 按新名字复制到同一个仓库，旧 ref 不动，已存在的 ref 永远不会被移动：同名且指向同一个提交算成功（续跑），指向别的提交就跳过这个检查点（显示为缺失）并列入"需要注意"。删除 ref 的只有回滚（`CheckpointRollbackService`），没有定期清理。
- **id 的每一种写法都要换**：分配器（`packages/provider-core/src/server/IdAllocator.ts` 的 `joinId`）把每一段 `encodeURIComponent` 后用冒号连接，而 id 又会成为下一个 id 的一段，所以含冒号的对话 id（`thread:delegated-task:…`）在 scope id、checkpoint id、run id、node id 里以 0 到 3 层编码出现。重写器对每个映射的 id 生成 0–4 层 `encodeURIComponent` 的全部写法（源和目标同步编码），ref 名是 scope id 的 sha256，换完 scope id 后重算，不会留下和官方同名的 ref。测试用带冒号的对话 id 覆盖，并扫描所有表确认没有残留。
- **检查点 ref 只创建不移动**：目标 ref 已存在且指向别的提交时视为冲突，不覆盖。预览和导入共用同一份只读计划（每个仓库一次 `git cat-file --batch-check`），所以冲突在确认前的复核步骤就能看到。冲突和源 ref 缺失的检查点不进重写映射，投影行和 `checkpoint.captured` 事件都标成 `missing` 且保留源 ref 名，两边一致；只有 `ready` 的检查点会被复制，因为上游只在 `ready` 时清理旧 ref、只允许从 `ready` 恢复。
- **不导入的子 Agent**：不勾"子 Agent 对话"时，父对话里指向它们的卡片保留，但 `child_thread_id` 和载荷里的 `childThreadId` 置空（打不开）；对它们的其余引用（事件、消息文本）换成它们将来导入时会得到的新 id，源 id 不会残留；父到子的 hand-off 记录丢弃。
- **到达时是停止状态**：正在跑、排队、有待处理请求、有恢复任务的对话整家跳过；其余的不带运行中的会话、绑定、outbox、命令回执，`limitRecovery` 清空，provider thread 只保留原生会话句柄。auth、配对链接、peer 链接、环境 id、签名密钥、`connection-catalog.json`（用官方 Electron safeStorage 加密）都不带。
- **定时任务逐个选**：保留启用状态，对话框里可逐个改。导入走和编辑器相同的 `ScheduledTaskService.upsert`，首次运行是它的下一个计划时间，导入和首次启动都不会立刻触发（`ScheduledTaskService.interval.test.ts` 在调度层验证）。webhook 任务在导入后换新地址和新签名密钥（不带官方的 `webhook_secret`；带签名校验的任务生成新密钥，只在完成页显示一次，不写进运行记录），投递和重放记录不带。一次性任务（`once`）的时间已过时一律关闭导入，并列在"需要注意"里，否则保存瞬间就会触发。官方那边的同一个任务仍在跑，直到用户在那边暂停，预检里逐个提醒。
- **受管策略**：`settings.json` 里被 `managedPolicy.lockedSettings` 锁住的键（含嵌套的父子路径）不写，列入"未导入"并写明管理方；`allowedDrivers` 之外的 provider 实例同样跳过。`client-settings.json` 不在服务端策略范围内，没有可锁的键。
- **升级路径**：源库比 T3 Extend 旧时，不复制整个库（真实的有几个 GB）。在 `userdata/t3-import-*` 里新建一个库，用 T3 Extend 自己的 migrator 迁到源库的版本，只把所选项目、对话、事件和定时任务行转进去，再把这个库迁到当前版本，最后从它走和等版本一样的复制。所以后续上游迁移（例如 077 修复布尔 `settledOverride`）自动作用在导入的行上，不需要给每个迁移手写转换；`T3CodeImport.test.ts` 的旧版本夹具用 076 的库验证这一点。暂存阶段磁盘写满时，写入报错使这次导入以"Importing from T3 Code failed."结束，作用域结束时暂存目录被删除，释放空间；暂存发生在复制到正在运行的库之前，所以那时 T3 Extend 的库里只多一条没有 `finished_at` 的运行记录，什么数据都没写，腾出空间后直接重新导入。进程在暂存中被杀会留下 `t3-import-*` 目录，下一次导入开始时（导入串行，剩下的必是遗留）先删掉它们。
- **官方名字只走一个常量**：用户可见文案里的 "T3 Code" 来自 `OFFICIAL_APP_NAME`（`packages/contracts/src/t3CodeImport.ts`），在 `t()` 里作为 `{app}` 参数传入，品牌守卫只需要为这一处写白名单。带数量的文案用显式的单数和复数两个 key（`t()` 没有复数规则），中文条目一一对应。
- **worktree 共用**：对话仍指向 `~/.t3/worktrees` 下原来的目录，不移动文件。这些路径记在导入表里（`kind='worktree'`），并且在对话行写入之前先记，所以清理任务不会看到没有标记的导入对话。拒绝删除的规则只在最底层一处：`removeLinkedWorktree`（`apps/server/src/vcs/worktreeRemoval.ts`）整个包在 `whileRemovable` 里，向 `SharedWorktreePolicy`（`apps/server/src/fork/SharedWorktrees.ts`）的 `exclusive` 段里执行。`SharedWorktreePolicy` 是带默认值的 `Context.Reference`，所以约 20 处 `GitVcsDriver.layer` 的调用方和它们的测试都不用改：默认实现只做路径规则（官方 home 的 `worktrees` 目录之下一律拒绝）；服务器在 `server.ts` 里于所有会建 Git 驱动或删 worktree 的层之下提供一次 `SharedWorktrees.layer`，它在构造时建表、把标记一次性读进内存，删除时不再访问数据库，导入在复制阶段开始、任何对话行提交之前，对所选对话引用的全部 worktree 先调 `markShared` 更新内存，再在一个事务里写库（多标记无害：这些 worktree 本来就归 T3 Code，T3 Extend 绝不该删；重复运行幂等），不用重启。读不到标记时失败即关闭：拒绝 T3 Extend 自己 worktree 目录（`config.worktreesDir`）之外的所有删除，并记错误日志；导入的 worktree 不会在自己的目录里，所以自己的清理照常工作。标记未知的状态在下一次导入开始时（`markShared` 内）重试加载，成功后切回已知集合并并入这次的标记。驱动和存储清理在构造时取这个 Reference，调用时用 `provideService` 带进去，不依赖调用方的 fiber 上下文。`T3CodeImport` 构造时 `requireLivePolicy()`，漏掉 `SharedWorktrees.layer` 服务器就起不来（`T3CodeImport.test.ts` 覆盖）。所有删除都经过它：`GitWorkflowService.removeWorktree`（`ws.ts` RPC、`ThreadLaunchService` 取消清理、`WorktreeMcpService` 回退清理）、`PullRequestReviewGuideService`（只删自己在 `config.worktreesDir` 里建的检出）、存储清理。策略有一个单许可的 Semaphore：`exclusive(路径, 破坏性操作)` 持有许可时重新检查内存里的拒绝规则，仍允许才执行；`markShared` 更新内存时拿同一个许可，所以导入不可能在“检查”和“删除”之间抢占路径。许可只包住检查和破坏性操作（`git clean`、`git worktree remove`、Windows 上的 fs 删除），数据库读写（含标记的重试加载）在外面；`removeLinkedWorktree` 整体走它，所以每个调用方都有，存储清理把 `git clean` 和移除放进同一个段（段内为此包含对子模块的有界 Git 只读检查）；Semaphore 不可重入，所以段内不能再开段：段把一个只能在段内拿到的 `SharedWorktreeSection` 凭证交给回调，存储清理用它调不带守卫的 `removeLinkedWorktreeInSection(凭证, …)`，没有环境标记，也不会被泄漏到别的 fiber。默认策略只有路径规则，没有可变状态，不需要锁。存储清理对每个 worktree 的第一步就查一次策略，早于任何对它的 Git 命令或文件操作（`git clean -ffdx` 在 `removeLinkedWorktree` 之前执行，所以只靠最底层不够）；被拒绝的整个跳过。`removeLinkedWorktree` 里那一次留给其他调用方。路径规则：含符号链接解析后在官方目录之下就拒绝（不管有没有标记）；本环境自己的 worktree 目录恰好在官方目录里时（从官方 worktree 里跑 dev server）自己建的仍可删；macOS 和 Windows 上按 NFC 加小写折叠后的路径比较，目标不存在时用最近的存在祖先做 realPath 再接上尾部。`git worktree prune` 不加守卫：它只清掉目录已不存在的 Git 记录，不删任何文件。设置里的 `previousWorktreesDirectories` 不导入，否则会让清理接管官方的目录。
- **状态记录不进编号迁移**：Effect 的 migrator 遇到重复 id 会失败，并且会跳过不大于已应用最大值的 id，fork 自己加一个 078 会让下一次同步上游出问题。**fork 不新增编号迁移**。导入的 id 映射和运行记录放在服务启动时（`SharedWorktrees.layer` 和导入服务启动时都会跑，可重复执行）`CREATE TABLE IF NOT EXISTS` 建的 `fork_t3code_import_map` / `fork_t3code_import_runs`。做法参照上游 `orchestration_v2_legacy_imports`：每个对话一行进度，`copying` 的下次从头重做该对话，`done` 的跳过。

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

GitHub Actions 在这个仓库里是关着的：2026-11-04 起，`SimpleEve/t3-extend` 在 Settings → Actions → General 里整体关闭了 Actions。从上游同步过来的 workflow 在这个私有 fork 里都用不上：`ci.yml` 指定的是上游的 `blacksmith-*` 付费 runner，每次推送都会排队、24 小时后才被自动取消；部署和发布类的 workflow 都带 `github.repository == 'pingdotgg/t3code'` 守卫，在这里只会被跳过；其余几个是管理上游公开仓库 issue 和 PR 的。fork 的安装包都在本机打（`fork:dist:mac`、`fork:dist:android`）。workflow 文件保持和上游一致，不删也不改，否则每次同步都会冲突；上游以后新增的 workflow 也会被这个开关一起挡住。私有仓库在免费套餐下用不了分支保护，所以关掉 CI 不影响合并。要重新打开：`gh api -X PUT repos/SimpleEve/t3-extend/actions/permissions -F enabled=true -f allowed_actions=all`，或者在网页设置里打开；打开后上游那批 workflow 会立刻恢复触发。要给 fork 加自己的 CI，先用 `gh workflow disable` 逐个关掉用不上的。

最近一次同步到上游 `322f6544df`（合并基点 `47f2c8d29e`，302 个 commit，41 个冲突文件）。这次同步里的取舍，下次遇到同类冲突照做：

- 受管策略（managed policy）：macOS 的 managed preferences 和描述文件模板按 `FORK.appId` / `FORK.appBaseName` 生成（`packages/shared/src/managedPolicyFile.ts`、`apps/server/src/policy/policyTemplates.ts`，后者有测试守着）。`/Library/Application Support/T3Code/policy.json` 和 Windows 的 `SOFTWARE\Policies\T3Tools\T3Code` 注册表路径仍是上游的，fork 和官方共用同一份策略；Windows 的 ADMX 模板同理。
- `DesktopUpdates.hasUpdateFeed` 把受管镜像（`policy.feedUrl`）也算作更新源，否则管理员配了镜像、构建里却没有 `app-update.yml` 时，入口会被隐藏。
- 侧栏"按项目"就是上游的 Boring 侧栏（视图由 `useBoringSidebarEnabled()` 推出，`Sidebar.tsx` 里那一行是上游原样）。上游把 `sidebarTree.ts` 的 `role=tree` / `aria-level` 去掉了，fork 在 `lib/sidebarTree.ts` 已经没有改动，`shortcuts/chatRouteCommands.ts` 里 `chat.new` 的项目视图分支也删了（`chat.new` 在项目视图里和 boring 一样走项目选择器）。
- 上游把 `app.t3.codes` 的链接声明加进了 `app.config.ts`。Android 的 intentFilter fork 不采用：没验证过的 http 链接过滤器会让 fork 出现在"用哪个应用打开"的选择框里，用户看得到。iOS 的 `applinks:app.t3.codes` 保留上游原样，不加 fork 改动：官方站点的 apple-app-site-association 不会列出 fork 的 bundle id，这条声明在 fork 里不起作用；fork 目前不发 iOS；iOS 的 native fingerprint 本来就会因为麦克风文案变化而变。原则是只在用户看得到影响时才偏离上游。
- Effect 升到 4.1.2 后 `effect/Crypto` 拆成 `effect/crypto/Digest` 和 `effect/crypto/SecureRandom`；fork 的 `T3CodeImport`、`DeviceAssertionAuth` 和测试夹具都改用新服务，测试要用 `NodeCrypto.layer`（`@effect/platform-node/NodeCrypto`）。同一版本不再读 `X-Forwarded-Proto`，上游加了 `apps/server/src/requestUrl.ts`；server 里取请求 URL 一律走它，不要直接调 `HttpServerRequest.toURL`（隧道监听口的夹具也一样）；端到端的场景 3、4、14（经隧道的 DPoP、限速桶、伪造的 `X-T3x-Client-IP`）验证的就是这一点。
- 上游新增的测试经常写死官方标识（`t3code://`、`t3code.service`、默认端口 3773、Tailscale Serve 的默认端口）；换成 `FORK.scheme`、`FORK.bootServiceName`、`FORK.defaultPort`、`FORK.tailscaleServePort`。服务端新增清理原因要同步 `apps/web/src/fork/storageCleanupReasons.ts` 的模板表和 zh-Hans 目录，否则 `storageCleanupReasons.test.ts` 会报。`T3CodeImport.test.ts` 把源库固定在迁移 76（077 之前），不要写成"当前 head 减一"，上游每加迁移就会失效。
- `vp i` 在 npmmirror 缺新包版本时会 404：用 `vp i -- --registry=https://registry.npmjs.org/`，只对这一条命令生效。`check:changed` 的默认基准是 `origin/main`，会把 `.repos` 上万个文件算进来、子进程报 `E2BIG`；同步后用上游那个 commit 当基准（`vp run check:changed 322f6544df`）。它的 "unused patches" 一步也要联网解析依赖，同样受镜像影响。
- mobile 的 `managedSettingReason` 保持英文输出，新增 `managedSettingOrganization` 供已翻译的屏幕使用。上游重写的 PR 状态按钮和麦克风设置页，在新逻辑上重新套了 `t()`；上游删掉的文案（"Auto-merge is enabled"）同步从 catalog 删掉。

native fingerprint 这次变了，dev client 和 release APK 都要重编：android `be22d2e60e70dedfaefe026e2e286ebd3fe638d3`（之前 `0ec7d60fc8b0b0c683dbe55e439f3561026cd873`，新增了上游的 `t3-voice-transcription` 原生模块、`expo-audio` 的 `recordAudioAndroid` 和麦克风权限文案），ios `86a2097b879654d5c7217577884627a2ff37f161`（之前 `85eaa1057713de7068e301ada56f906331a49f0a`，来自 `applinks:app.t3.codes` 和麦克风文案）。上一次文档里记的 `97cb…` / `95cb…` 已经过时，fork 之后又加过原生模块。

上游已知问题的状态：这次只确认了 `GuestPage.browser.test.tsx` 的 "follows the end…" 用例仍然失败（在原始上游上同样失败）；ZIP 预览按文本读取、Android 没有命令面板快捷键、webhook 投递"in under a minute"的措辞没有重新核对。macOS 上因 `/private/var` 符号链接和大小写不敏感文件系统失败的测试（`DesktopLinuxUrlHandler`（2）、`ServerEnvironment`、`GitVcsDriverCore` 的短目录用例、`UsageService`（2）、`ClaudeSkills`、`AgentSessionScanner` 的符号链接用例、`cli/invocation`（2）、`cli/app`（4）、`AcpAdapterV2` 的 native session forks 用例）在合并之前就已知失败，不是这次同步引起的；这次 `check:changed` 只跑了受改动影响的测试，其中见到失败的是前五项。

要出包时，先看上游有没有改 `build-desktop-artifact.ts` 里的 `renderMacPasskeyEntitlements`（以及 electron-builder 的 mac 配置）。新增的不依赖 team 的 entitlements 要同步到 `packaging/fork-macos/`：hardened runtime 缺了 entitlements，app 往往一启动就崩，而 `codesign --verify` 检查不出来。`fork-dist-mac.ts` 还依赖 `--target dir` 的产物位置（`<output-dir>/mac-arm64/*.app`）。所以同步之后的第一次打包，要真正把 app 启动起来验证一遍。

`fork:guard`（`scripts/fork-identity-guard.ts`）除了身份字面量，还会拦住 Tailscale 默认端口写回 443、`refs/t3code/`、`refs/t3/review-guide`、`t3code/pr-`、`WORKTREE_BRANCH_PREFIX = "t3"` 和 `branchNamePrefix` 默认值写回 `t3`。它扫描 `apps/*/src`、`packages`、`scripts` 等代码路径，查找 `com.t3tools.t3code`、`t3code-v2`、`t3code-dev`、`t3code://`、`"\.t3"`、`pingdotgg/t3code`、官方 EAS 和 PostHog 地址。新出现的命中要么改成引用 `forkIdentity.ts`，要么在脚本的 `ALLOWED` 里加一条并写明理由。白名单条目不再命中时，守卫也会报错，提醒删掉它。

自建配对的 server 核心在 `apps/server/src/fork/deviceKeys/`（设备密钥、注册表客户端、清单同步与撤销、`POST /oauth/t3x-device`、`devices.*` RPC、frpc 用的专用回环监听口），协议库在 `packages/shared/src/forkDeviceKeys/`，本机管理入口是 `t3x devices`；设计与取舍见 `research/self-host-device-keys.md`。
上游改动都带 `// fork:` 标记，守住 `devices.*` 只给 `desktop-bootstrap` 主体的边界，不要为了方便放宽到有 `access:write` 的会话。

隧道的 frpc 由 server 托管（`DeviceTunnel.ts`）：加入之后写配置和 ticket（`<state>/fork-tunnel/frpc.toml`，目录 0700、文件 0600，ticket 不在命令行也不在环境里）、启动 frpc、读它的四句拒绝日志（整句匹配，含登录通过后 `NewProxy` 被拒的 `[t3x] start error:`）并只对精确的 `reason` 动作，写进状态和日志的文字先抹掉形如令牌的片段、1→60 秒退避、每 12 小时换 ticket、离开或被移除时停止；`device-public-url.json` 跟着成员身份写和删（`status.json` 与它都是临时文件加 rename 写入；server 每 60 秒重写 `status.json`，`tunnel status` 只信 3 分钟内的文件）。macOS / Linux 上 frpc 在自己的进程组里，由持有 fd 3 的看守兜底：server 被 `kill -9` 也会带走 frpc；Windows 没有这个保证（已知限制）。frpc 只在两处找：`T3X_FRPC_PATH`（桌面版的后端和 `t3x` 启动脚本都指向 app 资源里的 `bin/frpc`），然后 `<T3 home>/bin/frpc`；**不查 PATH**，找到的必须属于当前用户或 root、自己和所在目录 group/other 不可写（Windows 不查），并且 `frpc -v` 输出正好 `0.71.1`（版本表在 `packages/shared/src/forkFrp.ts`，同时是 compose 里 frps 镜像标签的来源，有测试守着）。无头机器用 `t3x devices tunnel install` 下载（`T3X_FRP_BASE_URL` 可换镜像，SHA-256 照样核对，只解出 `frpc` 这一个成员），`t3x devices tunnel status` 看状态。测试专用的环境变量：`T3X_TUNNEL_CA_FILE`（写进 `transport.tls.trustedCaFile`）和 `T3X_TEST_TICKET_LIFETIME_SECONDS`（缩短 ticket 寿命），生产不设。
