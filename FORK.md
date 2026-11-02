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
  mobile 把 `pair` 当作 `connections/new` 的别名（`apps/mobile/src/Stack.tsx`），系统相机扫码直接进添加环境页。上游只在 `__DEV__` 下用链接里的 `pairingUrl` 预填表单，release 包会打开空表单。
  Android 冷启动时，启动画面会挡住窗口绘制，这期间弹出的 formSheet 会停在屏幕外。所以冷启动链接的初始 state 先不带弹层，等启动画面隐藏后再 navigate 过去（`apps/mobile/src/fork/initialLinkSheet.ts`）。

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

还是英文（需要时再排期）：

- 服务器或模型给出的文案：server 返回的错误和状态（如 "Codex provider status has not been checked in this session yet."）、ACP Registry 里各 Agent 的介绍、模型的推理强度名（Low / Medium / High 这类选项标签来自模型能力数据，输入框和设置里原样显示）、快捷键 when 条件、主题名。
- web 里客户端自己产生、会写日志的错误信息（`connection/`、`cloud/linkEnvironment.ts`、各处 `EnvironmentAuthorizationError` 的 `message`、预览 worker 的回复、`files/` 下各预览 worker 的内部错误）保持英文，显示处只有 `connection/errorMessages.ts` 和 `clientErrors.ts` 认识的几条会翻译；文档预览的兜底页名（"Page 1"）、设置搜索里带托管平台名的条目、更新对话框里带渠道名的跳过原因、自定义模型预设的档位值（存进设置，模型选择器原样显示）。
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

## 自建连接

用自己的 VPS（frps + Caddy）代替 T3 Connect。部署包和中文文档在 `infra/self-host/`，用户说明在 `docs/user/remote-access.md` 的 "Your own public address" 一节。设备把自建地址当作一条普通的 `Bearer` 路由，配对沿用 `https://host/pair#token=<一次性码>`。不自托管 `infra/relay`，不复用 `providerKind: "t3_relay"`。

- contracts：`ServerDirectEndpointKind` 加了 `"public"`，这是唯一的 contracts 改动。旧客户端通过 `ForwardCompatibleArray` 跳过这一项（`packages/contracts/src/server.test.ts` 有用例）。
- 公网地址的规范化、环境变量名、文件格式和桌面 bridge 类型放在 `packages/shared/src/selfHost.ts`。只接受不带路径的 `https://` origin。
- server：`environment/PublicUrls.ts` 合并 `T3CODE_PUBLIC_URLS` 和保存的文件（默认 `<stateDir>/public-urls.json`，可以用 `T3CODE_PUBLIC_URLS_FILE` 指定）。每次读取 server config 时重新读文件，所以增删地址不用重启。`DirectEndpoints` 把这些地址上报为 `"public"`。
- CLI：`cli/publicUrlFlags.ts` 定义 `--public-url`（可重复，替换保存的列表）和 `--clear-public-urls`，`serve`、`start`、默认命令和 `up` 都能用。`t3 pair --base-url` 复用 `cli/auth.ts` 的 flag，先用 descriptor 确认地址指向的是这台 server，再打印二维码。
- 认证限速：`auth/AuthAttemptLimiter.ts` 是一个全局 HttpRouter middleware，作用于会消耗配对码的三个端点：`POST /oauth/token`、`POST /api/auth/browser-session`（只统计 401，400 不算）和 `POST /oauth/mcp/decision`（MCP 批准页把错误配对码也报成 400，所以统计 400）。`/oauth/mcp/approval` 只读取请求详情，不消耗配对码。按客户端分桶：有 `X-Forwarded-For` 时取最右一项（反代追加的那一跳），否则用 socket 地址；来自 loopback 又没有转发头的请求（桌面 bootstrap、本机 CLI）不计数。每个客户端 1 分钟内失败 20 次只锁它自己 60 秒，期间返回 429 和 `retry-after`。最多跟踪 10,000 个客户端，超出时丢掉最久没失败的那个。配对码 60 位、一次性、5 分钟过期，所以限速只挡噪音，不是防暴力破解的手段。
- client-runtime：`mergeLearnedRoutes` 只接受 https 的 `"public"` 地址，排序沿用 `ROUTE_KIND_RANK`（局域网和 tailnet 优先，然后是 public，最后是 relay），supervisor 的预检和回切逻辑不变。mobile 用的是同一个 registry，不需要改。
- desktop：`selfHost/DesktopSelfHost.ts` 把地址存在 `<stateDir>/public-urls.json`，主后端通过 `T3CODE_PUBLIC_URLS_FILE` 读同一个文件。隧道命令存在 `self-host-tunnel.json`，由 `selfHost/ManagedTunnel.ts` 托管：用登录 shell 运行，退出后指数退避重启（1 秒起，最长 60 秒），关闭开关或退出应用时停止整个进程组。只有本机渲染进程的 `window.t3xSelfHostBridge` 能访问它，没有任何 RPC 入口。
- web：`components/settings/SelfHostSettings.tsx` 和 `fork/selfHostStore.ts`。中文译文在 `catalogs/zh-Hans/sharing.ts`。这一块只在桌面端渲染（没有 `t3xSelfHostBridge` 时返回 null），所以纯浏览器里的 Settings → Sharing & access 看不到它，要在 Electron 里验证。

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

## 手机新建浏览器标签页

手机上可以自己新建 Browser 标签页，打开宿主机上的页面。页面在宿主机的 headless Chrome 里渲染，手机只收 JPEG 帧（server 已有的 `/api/preview-stream`），所以 `localhost` 指宿主机，也没有 Android cleartext 和 mixed content 的问题。不改 server 和 contracts；原生 WebView 直连 dev server 涉及同源安全，没有做。用户说明在 `docs/user/remote-access.md` 的 "Browser on a remote environment"。

- 面板：`apps/mobile/src/features/browser/NewBrowserTabPanel.tsx`，嵌在 `BrowserPreviewRouteScreen` 里（路由参数 `newTab`），不是单独的路由。地址规范化和本地服务列表是纯函数，在 `newBrowserTab.ts`：复用 shared 的 `resolveAddressBarInput`，但不回落到搜索；本地服务列表订阅 `previewEnvironment.discoveredServers`，带上项目脚本的 Preview URL。
- 选中哪个标签页、新建模式、等待刚打开的标签页：纯函数在 `browserTabSelection.ts`，计时器和关闭事件订阅在 `useBrowserTabSelection.ts`。`preview.open` 返回的标签页最多等 10 秒（`PENDING_BROWSER_TAB_TIMEOUT_MS`），超时或收到它的 `closed` 事件就停止等待并提示"标签页没有打开"，然后按常规处理：没有标签页就关闭浏览器，有就显示最新的。
- 入口：Android 对话页标题栏的地球按钮（`ThreadHeader.tsx` 的 `onOpenNewBrowserTab`，只在 `capabilities.serverBrowser` 时传）；浏览器标题栏的 "+"（两个平台都有）。iOS 对话页标题栏走原生 header item，没有加入口。
- 权限：`previewEnvironment.open.permissionAtom`（`preview:operate`）。没有权限时入口照常显示，面板里说明原因并禁用输入。
- 推流：手机请求 `quality=60`（server 默认 70）。帧尺寸本来就按视图像素（最多 2x）封顶，没有再改。`PreviewStreamTarget` 加了可选的 `quality`（`packages/client-runtime/src/preview/serverBrowserStream.ts`）。
- i18n：`apps/mobile/src/hooks/useT.ts` 写法同 web，语言设置见上文"多语言"。译文在 `catalogs/zh-Hans/mobileBrowser.ts`；`i18n:report` 也扫描 `apps/mobile/src` 了。

上游文件里的接线（都带 `// fork:`）：`ThreadHeader.tsx`（prop 和 Android 按钮）、`ThreadRouteScreen.tsx`（按 `serverBrowser` 传回调）、`PreviewStreamWebView.tsx`（`PHONE_STREAM_QUALITY`）、`serverBrowserStream.ts`（`quality`）。`BrowserPreviewRouteScreen.tsx`（`newTab` 参数、改用 `useBrowserTabSelection`、"+"、几处 `t()`）、`scripts/i18n-report.ts`（扫描 `apps/mobile/src`）。

## 打包与签名

两条命令，都可以直接重跑：

```bash
vp run fork:dist:mac       # → release/fork-mac/T3-Extend-<版本>-arm64.dmg（附 .sha256）
vp run fork:dist:android   # → release/fork-android/T3-Extend-<版本>-arm64-v8a.apk（附 .sha256）
```

`release/` 已在 gitignore 里。Android 命令要先设好上文"Android 开发环境"里的环境变量。

前置条件：

- macOS 签名身份：登录钥匙串里的自签名证书 `T3 Extend Code Signing`（`security find-identity -v -p codesigning` 能看到）。换身份用 `--identity` 或 `T3EXTEND_MAC_SIGN_IDENTITY`。
- Rust：`native/resource-monitor` 依赖的 `sysinfo` 要求 rustc 1.95，默认 stable 是 1.89。只加装、不改默认工具链：`RUSTUP_DIST_SERVER=https://rsproxy.cn RUSTUP_UPDATE_ROOT=https://rsproxy.cn/rustup rustup toolchain install 1.95.0 --profile minimal`。脚本用 `RUSTUP_TOOLCHAIN=1.95.0` 从源码编译 resource-monitor（`--rust-toolchain` 可改），并清掉 `T3CODE_DESKTOP_REUSE_RESOURCE_MONITOR`。
- Node：系统的 26.5.1 能打出来。如果打包报 Node 版本不对，改用 `vp env exec --node 26.12.1 node scripts/fork-dist-mac.ts`。
- Android keystore：`~/.config/t3extend/android-release.jks`（目录 0700、文件 0600），PKCS12，alias `t3extend`，RSA 4096，有效期 10000 天，store 和 key 是同一个密码。密码只存在 macOS Keychain 的 generic password 条目里，account 和 service 都是 `t3extend-android-release`。新机器上用 `node scripts/fork-build-android-release.ts --create-keystore` 生成一次。已有 keystore 或 Keychain 条目时它会拒绝执行。它先把 keystore 生成到同目录的临时文件，Keychain 写入成功并且读回的密码一致后，才链接到正式路径；中途任何一步失败，都会删掉临时文件和这次写入的 Keychain 条目，可以直接重试。这一步只需要 `JAVA_HOME`（keytool 在 JDK 里），不需要 Android SDK。测试时用 `--keystore` 和 `--keychain-service` 指向临时路径和临时条目，不要碰正式的。

macOS 流水线（`scripts/fork-dist-mac.ts`）：

1. `build-desktop-artifact.ts --target dir` 打出未签名（ad-hoc）的 `.app`。
2. `@electron/osx-sign` 由内向外签名：嵌套的二进制和原生模块、frameworks、helpers、主程序。开启 hardened runtime，不打时间戳（Apple 的时间戳服务只给 Apple 签发的证书加签）。osx-sign 自己查找身份时不带 `-p codesigning`，所以看不到自签名证书。脚本先自己解析出 SHA-1 再传给它，并关掉它的身份校验。
3. 用 `hdiutil` 打出带 `/Applications` 链接的 UDZO DMG，再对 DMG 签名，然后挂载 DMG，校验里面的 app。签名后和挂载后各校验一次：用 `file` 找出 `.app` 里所有 Mach-O，逐个跑 `codesign --verify --strict`，并检查 Authority 是签名身份、带 runtime flag，有任何一个不满足就失败并列出文件。每次开始前会删掉上一次的 `mac-arm64/`、DMG 和 `.sha256`（`--skip-build` 时保留 `mac-arm64/`）。没有上游 DMG 的背景图和窗口布局。

entitlements 在 `packaging/fork-macos/`。主程序用 `entitlements.plist`，内容是 `renderMacPasskeyEntitlements` 去掉 team id、associated-domains、keychain-access-groups 和 passkey 后剩下的项：JIT、unsigned executable memory、disable-library-validation、camera、audio-input。helper 和其他嵌套程序用 `entitlements.inherit.plist`，内容就是 electron-builder 默认的前三项，和上游签名构建一致。

Android 流水线（`scripts/fork-build-android-release.ts`）：`APP_VARIANT=production` 跑 `expo prebuild --clean`，并检查 applicationId 是 `com.simpleeve.t3extend`；从 Keychain 读出密码；运行 `gradlew --no-daemon app:assembleRelease`，签名配置用 `android.injected.signing.*` 注入。store file 和 alias 走 `-P`，两个密码走 `ORG_GRADLE_PROJECT_*` 环境变量，所以不会出现在进程参数和日志里，代价是构建期间同一用户的进程能读到这些环境变量；换成临时文件同样防不住同一用户的进程，所以没换。`--no-daemon` 是为了不留一个持有密码的常驻 daemon。build.gradle、`app.config.ts` 和 plugins 都不改，native fingerprint 不变。最后用 apksigner 确认 APK 证书就是 keystore 里的证书。默认只打 `arm64-v8a`，`--abi` 可改。versionCode 固定为 1，不影响 sideload 覆盖安装：Android 只拒绝降级，相同的 versionCode 可以覆盖。以后要上架商店，就要每个版本递增。在 `app.config.ts` 里设置 versionCode 会改变 native fingerprint，所以现在不改。`apps/mobile/android` 是生成出来的目录，之后跑 `mobile:install` 会重新 prebuild 成 development。

安装：

- macOS：打开 DMG，把 `T3 Extend (Beta).app` 拖进 `/Applications`。第一次打开如果被 Gatekeeper 拦下，在 Finder 里右键选"打开"，或者执行 `xattr -d com.apple.quarantine "/Applications/T3 Extend (Beta).app"`。
- 第一次启动时，macOS 会询问是否允许 `T3 Extend (Beta)` 访问钥匙串项 `t3extend Safe Storage`。把弹窗切到前台，选"始终允许"。签名身份不变，所以重新打包以后 designated requirement（`identifier "com.simpleeve.t3extend" and certificate leaf = H"4c50…5d"`）也不变，按理不会再问。这一点没有实测。
- 如果点了拒绝，或者想让签名版重新创建这一项，执行 `security delete-generic-password -s "t3extend Safe Storage"`，然后重启 app。旧项里加密保存的本地凭据会随之失效，需要重新登录或重新配对。
- 弹窗没处理时，主线程会一直阻塞在读取 Keychain 上，app 不响应退出，第一次 SIGTERM 也不生效。这时用"强制退出"或 `kill -9 <PID>`。
- Android：`adb install -r <apk>`，或者把 APK 传到手机上安装。它和 dev client（`.dev`）是两个应用，可以并存。

**备份**：把 `android-release.jks` 拷到离线的地方，密码存进离线密码库。读密码要在受控的终端里执行 `security find-generic-password -a t3extend-android-release -s t3extend-android-release -w`，它会把密码打印出来，存好后立即清屏。两者丢了任何一个，以后的 APK 都不能覆盖安装已装的版本，只能先卸载，应用数据会一起清掉。

签名的限制：

- 自签名证书不能公证。拷到别的 Mac 上会被 Gatekeeper 拦下，要用上面的右键打开或 `xattr`。本机关闭了 Gatekeeper 评估（`spctl --status` 显示 `assessments disabled`），所以本机上 `spctl -a -t exec -vv` 显示的是 `accepted` / `override=security disabled`，看不到拒绝。
- passkey 和 Associated Domains 需要 Apple 签发的 provisioning profile，不可用。
- 只打 arm64，没有 universal 版本，也没有 Linux 和 Windows 的 fork 打包。

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

最近一次同步到上游 `47f2c8d29e`（合并基点 `955e2bfbb5`，193 个 commit，55 个冲突文件）。这次同步里的取舍，下次遇到同类冲突照做：

- 上游新增的受管策略（managed policy）按 `FORK.appId` 读 macOS 的 managed preferences（`packages/shared/src/managedPolicyFile.ts`），`/Library/Application Support/T3Code/policy.json` 等系统路径仍是上游的，fork 和官方共用同一份策略文件。
- `DesktopUpdates.hasUpdateFeed` 把受管镜像（`policy.feedUrl`）也算作更新源，否则管理员配了镜像、构建里却没有 `app-update.yml` 时，入口会被隐藏。
- 上游测试里写死的 `t3code://` 改成 `FORK.scheme`；`threadExecution` 的单项后台任务标题跟随上游改成 `Running · {label}`，中文 key 同步改过。
- mobile 的 `managedSettingReason` 保持英文输出，新增 `managedSettingOrganization` 供已翻译的屏幕使用。

native fingerprint 这次没有变（android `97cb060cd3…`、ios `95cb50c6af…`，和同步前的 main 逐位相同），不需要重编 dev client 或 release APK。

上游已知问题的状态（同步后复核）：ZIP 预览按文本读取、Android 没有命令面板快捷键、webhook 投递"in under a minute"的措辞、`GuestPage.browser.test.tsx` 的 "follows the end…" 用例，四项都还在。后两项实际跑过或读过代码确认（措辞还在 `ScheduledTasksSettings.tsx`，GuestPage 用例在合并后仍失败，且它在原始上游上就失败）；前两项只核对了代码，上游对 ZIP 预览和 Android 命令面板没有相关改动，没有在设备上复测。另有七个测试在 macOS 上因 `/private/var` 符号链接和大小写不敏感的文件系统失败，在未合并的 `upstream/main` 上同样失败，不是 fork 引起的：`DesktopLinuxUrlHandler`（2）、`ServerEnvironment`、`GitVcsDriverCore`、`UsageService`（2）、`ClaudeSkills`。

要出包时，先看上游有没有改 `build-desktop-artifact.ts` 里的 `renderMacPasskeyEntitlements`（以及 electron-builder 的 mac 配置）。新增的不依赖 team 的 entitlements 要同步到 `packaging/fork-macos/`：hardened runtime 缺了 entitlements，app 往往一启动就崩，而 `codesign --verify` 检查不出来。`fork-dist-mac.ts` 还依赖 `--target dir` 的产物位置（`<output-dir>/mac-arm64/*.app`）。所以同步之后的第一次打包，要真正把 app 启动起来验证一遍。

`fork:guard`（`scripts/fork-identity-guard.ts`）扫描 `apps/*/src`、`packages`、`scripts` 等代码路径，查找 `com.t3tools.t3code`、`t3code-v2`、`t3code-dev`、`t3code://`、`"\.t3"`、`pingdotgg/t3code`、官方 EAS 和 PostHog 地址。新出现的命中要么改成引用 `forkIdentity.ts`，要么在脚本的 `ALLOWED` 里加一条并写明理由。白名单条目不再命中时，守卫也会报错，提醒删掉它。
