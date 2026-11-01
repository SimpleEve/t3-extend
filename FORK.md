# T3 Extend

T3 Extend 是 [T3 Code](https://github.com/pingdotgg/t3code) 的私有二开 fork（`SimpleEve/t3-extend`）。它的 macOS 桌面版（开发版和打包版）、server / CLI 和 Android 应用，都可以和本机安装的官方 T3 Code 同时运行，互不改写对方的数据、命令、服务和更新。Linux 打包还没有隔离，见下文"例外和限制"。

## 身份

所有 fork 身份集中在 `packages/shared/src/forkIdentity.ts`。上游文件里引用它的地方都只改一行，并带 `// fork:` 注释。不能 import 的地方（`apps/desktop/package.json` 的 `productName`、`apps/desktop/scripts/electron-launcher.mjs`、`apps/mobile/package.json` 的 `--scheme`、iOS 小组件、移动端测试脚本）直接写字面量。

| 项                                    | 官方 T3 Code                                    | T3 Extend                                                                   |
| ------------------------------------- | ----------------------------------------------- | --------------------------------------------------------------------------- |
| 应用名                                | T3 Code (Beta / Nightly / Dev)                  | T3 Extend (Beta / Nightly / Dev)                                            |
| appId / bundle id / Android 包名      | `com.t3tools.t3code`                            | `com.simpleeve.t3extend`，移动端变体加 `.dev` / `.preview`                  |
| Electron userData                     | `t3code-v2` / `t3code-dev`                      | `t3extend` / `t3extend-dev`                                                 |
| URL scheme                            | `t3code` / `t3code-dev` / `t3code-preview`      | `t3extend` / `t3extend-dev` / `t3extend-preview`                            |
| T3 home                               | `~/.t3`                                         | `~/.t3extend`                                                               |
| CLI shim 与 PATH 软链接               | `t3`                                            | `t3x`                                                                       |
| 开机服务                              | `com.t3tools.t3code.service` / `t3code.service` | `com.simpleeve.t3extend.service` / `t3extend.service`                       |
| 默认端口（桌面后端、headless server） | 3773                                            | 3873                                                                        |
| server 发布源                         | `pingdotgg/t3code`                              | `SimpleEve/t3-extend`（私有，没有发布归档）                                 |
| 桌面更新 feed                         | GitHub Releases                                 | 无，除非构建时设置 `T3CODE_DESKTOP_UPDATE_REPOSITORY`                       |
| 移动端 OTA                            | 官方 EAS 项目                                   | 无，除非设置 `T3EXTEND_EAS_PROJECT_ID` 和 `T3CODE_MOBILE_UPDATES_ENABLED=1` |
| telemetry                             | 默认开                                          | 默认关，`T3CODE_TELEMETRY_ENABLED=true` 才上报                              |

没有改的：server 的 npm 包名和 `bin`（`t3`，改了会破坏 `--filter=t3`）、`t3code:*` localStorage key（userData 和 origin 已经不同）、版本号、CLI 帮助文本里的命令名。

## 共存保证

- 两个应用各用各的 userData、single-instance lock、T3 home、数据库、`secrets/`、worktree 目录、launchd label 和 systemd unit，互不干扰。
- 桌面版写的是 `~/.t3extend/bin/t3x`，以及 PATH 上的 `t3x` 软链接，不会碰官方的 `~/.t3/bin/t3`、`/opt/homebrew/bin/t3`。
- fork 不会被官方更新覆盖：
  - 桌面构建只认显式设置的 `T3CODE_DESKTOP_UPDATE_REPOSITORY`，不会从 CI 的 `GITHUB_REPOSITORY` 推断 feed。没有 feed 时不生成 `app-update.yml`，菜单里也没有 "Check for Updates..."。
  - server 自更新（`t3x update`、客户端的 "Update everything"、`t3x service install`）从 `SimpleEve/t3-extend` 查询和下载。这个仓库是私有的，没有发布归档，匿名请求在查询 release 或下载 `SHA256SUMS` 时就会 404。已经装好的运行时（带 sentinel 的版本目录）不会被删除或替换，`apps/server/src/cloud/pinnedRuntime.test.ts` 有对应用例。唯一的例外是目标版本目录里上次没下载完的残留：上游逻辑会在下载前先清掉它。
  - 移动端默认关闭 OTA，也不带官方 EAS 的 `projectId` 和 `owner`。
- 配对链接两种都认：fork 客户端能扫官方 server 的二维码（`t3code://pair`），fork 生成的链接是 `t3extend://pair`。

例外和限制：

- SSH 远程主机默认装的是同版本的官方 server 归档（`OFFICIAL_CLI_RELEASE_DOWNLOAD_URL`），不影响本机的 fork。
- 没有官方 `.env`，所以 T3 Connect、guest link、移动推送、passkey 默认都不可用。Clerk 回跳绑定的是官方 scheme，即使自己提供 `.env`，Connect 登录也可能失败。
- `t3x service install` 同样需要下载 server 归档，在 fork 发布自己的归档之前会失败。可以用 `T3CODE_RELEASE_BASE_URL` 指向自己的发布镜像。
- Linux 打包身份（`executableName`、`StartupWMClass`、metainfo、`.desktop` 名称）还没有改，fork 的 deb / AppImage 会和官方包冲突。不要在同一台 Linux 机器上同时安装两者。
- `scripts/install.sh`、`scripts/install.ps1`、`scripts/npm-launcher/` 是官方的安装器，默认把官方 `t3` 装进 `~/.t3`。只有上游的 release workflow 会用到它们，而这个 workflow 限定在 `pingdotgg/t3code` 仓库运行。fork 不要用它们安装。
- 远程 model manifest 仍然读上游的 `raw.githubusercontent.com/pingdotgg/t3code`，它是只读数据。

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

`i18n:report`（`scripts/i18n-report.ts`）扫描 `apps/web/src`、`apps/desktop/src`、`packages/client-runtime/src` 里的 `t("...")` 一类调用，列出 catalog 里缺失的 key，以及 catalog 里有、代码里已经找不到的 key（通常是上游改了英文）。只报告，不阻断。同步上游后跑一次，把失效的 key 改成新英文。

已翻译：设置页导航和面包屑、外观页、侧边栏表头与分区、线程状态和行操作、线程右键菜单和多选菜单、撤销提示、自定义稍后处理弹窗、命令面板的分组和静态命令、通用确认框、相对时间、桌面菜单和原生对话框。mobile 还没有接入。

## 侧边栏视图

侧边栏有"按状态"（上游的 Inbox，默认）和"按项目"两种视图，后者在项目文件夹下再按 worktree 分子组。用户说明见 `docs/user/thread-sidebar.md` 的 "Choose a sidebar view"。

- 视图和折叠状态存在 fork 自己的 store（`apps/web/src/fork/sidebarViewStore.ts`，localStorage key `t3extend:sidebar-view:v1`），按设备保存，不进 `ClientSettings`，不改 contracts。折叠 key 带视图前缀（`sidebarGroupCollapseKey`），切换视图不会串组。
- 分组是纯函数，放在 `packages/client-runtime/src/state/threadGrouping.ts`（`@t3tools/client-runtime/state/thread-grouping`），web 和以后的 Android 共用。
- 按项目视图复用 boring 的所有分支：没有 Working shelf、不能拖拽、`chat.new` 在当前项目新建。Labs 里的 boring sidebar 只影响按状态视图。
- `Sidebar.tsx` 的接线（都带 `// fork:`）：
  1. 文件头的 import（`useSidebarViewMode`、`useProjectViewFolders`、`SidebarWorktreeGroupHeader`）。
  2. `useSidebarThreads` 里 `projectFolders` 先取 `useProjectViewFolders` 的结果，`orderedThreadKeys` 因此跟着屏幕顺序走。
  3. `useSidebarThreads` 返回的 `toggleProjectFolder`：按项目视图下写 fork store。
  4. `Sidebar` 组件里 `boringSidebarEnabled` 加上 `|| sidebarViewMode === "project"`。
  5. 列表渲染的文件夹循环：有 `folder.worktrees` 时先画 worktree 子组标题，再画行。
- 其他上游文件各一两行：`SidebarThreadHeader.tsx`（切换按钮）、`CommandPalette.tsx`（两条命令，定义在 `CommandPaletteSidebarViewItems.tsx`）、`chatRouteCommands.ts`（`chat.new`）、`lib/sidebarTree.ts`（`aria-level` 按祖先数计算，支持第三层）。
- 快捷键没有加，因为要改 `packages/contracts/src/keybindings.ts`。

## 自建连接

用自己的 VPS（frps + Caddy）代替 T3 Connect。部署包和中文文档在 `infra/self-host/`，用户说明在 `docs/user/remote-access.md` 的 "Your own public address" 一节。设备把自建地址当作一条普通的 `Bearer` 路由，配对沿用 `https://host/pair#token=<一次性码>`。不自托管 `infra/relay`，不复用 `providerKind: "t3_relay"`。

- contracts：`ServerDirectEndpointKind` 加了 `"public"`，这是唯一的 contracts 改动。旧客户端通过 `ForwardCompatibleArray` 跳过这一项（`packages/contracts/src/server.test.ts` 有用例）。
- 公网地址的规范化、环境变量名、文件格式和桌面 bridge 类型放在 `packages/shared/src/selfHost.ts`。只接受不带路径的 `https://` origin。
- server：`environment/PublicUrls.ts` 合并 `T3CODE_PUBLIC_URLS` 和保存的文件（默认 `<stateDir>/public-urls.json`，可以用 `T3CODE_PUBLIC_URLS_FILE` 指定）。每次读取 server config 时重新读文件，所以增删地址不用重启。`DirectEndpoints` 把这些地址上报为 `"public"`。
- CLI：`cli/publicUrlFlags.ts` 定义 `--public-url`（可重复，替换保存的列表）和 `--clear-public-urls`，`serve`、`start`、默认命令和 `up` 都能用。`t3 pair --base-url` 复用 `cli/auth.ts` 的 flag，先用 descriptor 确认地址指向的是这台 server，再打印二维码。
- 认证限速：`auth/AuthAttemptLimiter.ts` 是一个全局 HttpRouter middleware，作用于会消耗配对码的三个端点：`POST /oauth/token`、`POST /api/auth/browser-session`（只统计 401，400 不算）和 `POST /oauth/mcp/decision`（MCP 批准页把错误配对码也报成 400，所以统计 400）。`/oauth/mcp/approval` 只读取请求详情，不消耗配对码。按客户端分桶：有 `X-Forwarded-For` 时取最右一项（反代追加的那一跳），否则用 socket 地址；来自 loopback 又没有转发头的请求（桌面 bootstrap、本机 CLI）不计数。每个客户端 1 分钟内失败 20 次只锁它自己 60 秒，期间返回 429 和 `retry-after`。最多跟踪 10,000 个客户端，超出时丢掉最久没失败的那个。配对码 60 位、一次性、5 分钟过期，所以限速只挡噪音，不是防暴力破解的手段。
- client-runtime：`mergeLearnedRoutes` 只接受 https 的 `"public"` 地址，排序沿用 `ROUTE_KIND_RANK`（局域网和 tailnet 优先，然后是 public，最后是 relay），supervisor 的预检和回切逻辑不变。mobile 用的是同一个 registry，不需要改。
- desktop：`selfHost/DesktopSelfHost.ts` 把地址存在 `<stateDir>/public-urls.json`，主后端通过 `T3CODE_PUBLIC_URLS_FILE` 读同一个文件。隧道命令存在 `self-host-tunnel.json`，由 `selfHost/ManagedTunnel.ts` 托管：用登录 shell 运行，退出后指数退避重启（1 秒起，最长 60 秒），关闭开关或退出应用时停止整个进程组。只有本机渲染进程的 `window.t3xSelfHostBridge` 能访问它，没有任何 RPC 入口。
- web：`components/settings/SelfHostSettings.tsx` 和 `fork/selfHostStore.ts`。中文译文在 `catalogs/zh-Hans/sharing.ts`。

上游文件里的接线（都带 `// fork:`）：

1. `packages/contracts/src/server.ts`：`ServerDirectEndpointKind`。
2. `packages/client-runtime/src/connection/routes.ts`：`mergeLearnedRoutes` 里的 https 检查。
3. `apps/server/src/environment/DirectEndpoints.ts`：取 `PublicUrls`，在返回前追加 `"public"` 地址。
4. `apps/server/src/server.ts`：两处 import；`DirectEndpoints.layer` 提供 `PublicUrls.layer`；`layerMakeRoutes` 提供限速 middleware。
5. `apps/server/src/cli/config.ts`：`sharedServerCommandFlags` 展开 `publicUrlFlags`。
6. `apps/server/src/cli/server.ts`：handler 的参数类型，以及 `resolveServerConfig` 之后调用 `applyPublicUrlFlags`。
7. `apps/server/src/cli/up.ts`：flag 和 handler。
8. `apps/server/src/cli/auth.ts`：`baseUrlFlag` 改为导出。
9. `apps/server/src/cli/pair.ts`：import、两个错误类和 `resolveBaseUrlPairingBase`、flag、handler 里的分支。
10. `apps/desktop/src/main.ts`：`layerDesktopFoundation` 加入 `DesktopSelfHost.layer`。
11. `apps/desktop/src/preload.ts`：暴露 `t3xSelfHostBridge`。沙箱 preload 的 `require` 解析不了 workspace 包，所以运行时值只能从相对模块导入，bridge 名在 `selfHost/selfHostChannels.ts` 里另存一份，`selfHost/preloadSandbox.test.ts` 检查导入并比对两边的值。
12. `apps/desktop/src/ipc/DesktopIpcHandlers.ts`：调用 `installSelfHostIpc()`。
13. `apps/desktop/src/ipc/methods/serverExposure.ts`：`getAdvertisedEndpoints` 追加自建地址，生成配对二维码时可以选到它们。
14. `apps/desktop/src/backend/DesktopBackendConfiguration.ts`：主后端的 env 加上 `T3CODE_PUBLIC_URLS_FILE` 和 `T3CODE_PUBLIC_URLS`（合并 `T3CODE_DESKTOP_HTTPS_ENDPOINTS`）。WSL 后端不加。
15. `apps/web/src/components/settings/ConnectionsSettings.tsx`：Network access 关闭时也显示自建地址；在 Tailscale 行之后渲染 `<SelfHostSettings />`。

## 同步上游

```bash
git fetch upstream
git merge upstream/main
# 解决冲突：fork 的改动都在带 `// fork:` 注释的行上，保留 fork 的值，接受上游其余改动。
vp i
vp run fork:guard        # 上游新增的官方身份字面量会在这里报出来
vp run i18n:report       # 上游改过的英文文案会列为 stale
vp run check:changed
```

`fork:guard`（`scripts/fork-identity-guard.ts`）扫描 `apps/*/src`、`packages`、`scripts` 等代码路径，查找 `com.t3tools.t3code`、`t3code-v2`、`t3code-dev`、`t3code://`、`"\.t3"`、`pingdotgg/t3code`、官方 EAS 和 PostHog 地址。新出现的命中要么改成引用 `forkIdentity.ts`，要么在脚本的 `ALLOWED` 里加一条并写明理由。白名单条目不再命中时，守卫也会报错，提醒删掉它。
