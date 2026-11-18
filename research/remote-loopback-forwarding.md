# 远程环境的本机服务转发（桌面版）设计

2026-11-04。基线：fork `8328902b94`，上游同步点 `322f6544df`，上游 main `8b44f42b14`。只做设计，没有实现代码。

场景：A 的 T3 Extend 桌面版打开 B 上的对话，B 的 T3 终端或 agent 起了只监听回环地址的服务（例如 `127.0.0.1:5173` 的 Vite）。用户在内置浏览器输入 `http://localhost:5173`，地址栏不变，页面在 A 本地渲染，请求在后台经 A 到 B 的现有连接转到 B 的回环地址。

## 0. 结论与推荐方案

第三轮修订（2026-11-04，最后一轮）：按 GPT 对第二版（`be58a0f5ba`）的定向复核（`/tmp/t3x-gateway-design-review/recheck.md`，结论「改完再实现」）和主控的决定修改。第二轮的发现对应表在附录 D.1–D.3，复核对应表在附录 D.4。

**一句话：** 在 A 的桌面主进程里为每个远程环境起一个只绑 `127.0.0.1` 的 HTTP 代理，用 `session.setProxy` 把该环境所有分区的回环流量导给它；代理为每条 TCP 连接开一个到 B 的 WebSocket 隧道；B 的网关只在目标端口属于"T3 终端或 agent 起的服务"、**每条新隧道都经过一次现场核对（进程身份 = pid + 启动时间，不缓存）**、且不在排除清单里时，才拨 B 的回环地址。**只在加密或本机的连接上启用**；明文局域网和明文 `100.x` 地址不启用。

```
A 渲染进程                         A 主进程                            B (server)
 <webview partition=env B>  ──►  127.0.0.1:随机口 (代理, Proxy-Authorization)
   localhost:5173                  │ HTTP: 每个请求按目标端口选隧道 (keep-alive 池)
   ws://localhost:5173 (CONNECT)   │ CONNECT: 一条隧道 = 一条 Chromium 连接
   https://localhost:5173 (CONNECT)│ 先过传输检查：https / 回环 / *.ts.net 与 fd7a:115c:a1e0::/48 才继续
                                   └─ wss://<B 的地址>/api/loopback-gateway/tunnel?port=5173
                                        Authorization: T3X-Gateway <票据>  ──►  同一 router，
                                                                          主监听口和隧道监听口都有
                                                                          ① 严格 audience 的票据 → 会话 → 两个 scope
                                                                          ② 端口许可（端口发现快照只做提名）
                                                                          ③ 现场核对：身份 + 监听 + 归属，无缓存
                                                                          ④ 排除清单（登记的运行时、端口、调试进程）
                                                                          ⑤ 拨核对得到的那个回环地址
```

关键决定（每条的理由在对应章节）：

| 问题             | 决定                                                                                                                                                                                                                           | 依据        |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------- |
| A 端怎样改走转发 | `setProxy({ mode: "fixed_servers", proxyRules: "http://127.0.0.1:<端口>", proxyBypassRules: "*;<-loopback>" })`                                                                                                                | §1、附录 A  |
| 分区             | **上游已经按环境分区**；代理装在 `getPreviewConfig` 的处理里，保证任何分区（含新建的 profile、无痕）在首次导航前就有代理                                                                                                       | §2          |
| 传输             | 每条 TCP 连接一个 WebSocket，不多路复用；B 端是纯 TCP 通道，不解析 HTTP                                                                                                                                                        | §3          |
| 启用条件         | 只在 `https:`、回环（含 SSH 转发口和本机）、Tailscale 上启用。Tailscale 只认上游 `isTailnetHost`：`*.ts.net` 和 `fd7a:115c:a1e0::/48`；**明文 `100.64.0.0/10` 不认**，是 `insecure-transport`，提示改用 MagicDNS 名字或 HTTPS  | §3.5、§4.6  |
| TLS              | 第一版主进程**不并入系统根证书**；TLS 校验失败就是失败，不因为 scheme 是 `https:` 放行；私有 CA 是已知限制                                                                                                                     | §3.6        |
| 认证             | RPC 取会话级 WS 票据（新 audience，5 分钟，可复用），经 IPC 交给主进程；主进程用 `ws`（不跟随重定向）带 `Authorization: T3X-Gateway <票据>` 头；网关路由用 fork 自己的认证函数，**严格**要求 `audience === "loopback-gateway"` | §4.2–§4.4   |
| 票据不进日志     | 不再依赖"默认遮蔽"：入口读到票据立刻包成 `Redacted`，错误、诊断、span 属性不带请求头；每个 sink 都有测试，加守卫测试；Caddy 与 frps 在 9.4 实测                                                                                | §4.3        |
| 权限             | 要求 `preview:operate` **和** `terminal:operate`                                                                                                                                                                               | §4.5        |
| 续期链           | 票据带会话的 `jkt` 仅作续期链的键。**明确接受**：偷来的票据开出的隧道最多活到这台设备的会话链结束或被撤销                                                                                                                      | §4.2、§4.8  |
| 端口许可         | 快照只提名；**每条新隧道**现场核对 pid + 启动时间、监听、归属（终端 shell 祖先或 agent 环境标记），任何不一致都拒绝；**没有缓存**                                                                                              | §5.3        |
| 排除             | 登记运行时（pid + 启动时间）、server 直接子进程默认拒绝、运行时特征（防孤儿）、调试进程整进程排除、屏蔽表 8 个端口（含 5005、5678）                                                                                            | §5.6、§5.7  |
| 开工关口         | 9.1 的第一道关：监听点清单和 provider 运行时进程树逐项落实，拿不准的一律排除；网关路由要等它过了才开始写                                                                                                                       | §5.6.0、§12 |
| 平台             | macOS 的 B 广告能力；**Windows 的 B 不广告**；Linux 的 B 在真实进程测试通过前不广告                                                                                                                                            | §5.3、§8    |
| 退路             | B 不支持、端口不允许、明文链路、中继、证书不受信任、用户关闭：保持现有行为，错误卡片给「在 B 的浏览器中打开」                                                                                                                  | §7、§8      |
| 支持矩阵         | 没验证过的连接方式一律标"待验证"，9.4 逐种测 WS、长连接、重连、证书；用户文档只列已验证的                                                                                                                                      | §3.5        |
| 阶段             | 没有独立的 9.0；9.1 先过监听点与运行时的关口，再做 B 端技术前提；A 端的前提是 9.2 第一步；失败就停下回报                                                                                                                       | §12         |
| 网页版           | 这次不做                                                                                                                                                                                                                       | 附录 C      |

规模：新代码在 `apps/*/src/fork/`、`packages/*/src/fork*` 约 3,100 行（含测试约 5,300），上游文件约 +91 行、30 个文件（§13），低于 130 行停止线。比第二版多出来的主要是各 adapter 启动点的运行时登记（约 +22 行，是上游冲突风险最高的部分，§13 给了削减方案）。审查要求的安全基础设施（严格认证、显式脱敏、`login` 条件、现场核对、排除登记）本身全部在 fork 文件里。

N1–N7 已全部由主控定下，见 §14.1；§14.2 只留实现阶段才能回答的问题。

## 1. A 端怎样改走转发

### 1.1 比较

| 方案                                                      | 能否保持 origin                                                                   | HTTP + 流式                  | WebSocket                                     | `https://localhost`         | 其他地址直连                                                | 结论                                                                                                                    |
| --------------------------------------------------------- | --------------------------------------------------------------------------------- | ---------------------------- | --------------------------------------------- | --------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| **`setProxy` fixed_servers + `*;<-loopback>` + 本地代理** | 是（实测）                                                                        | 是（SSE 实测）               | 是，Chromium 对 `ws://` 用 CONNECT（实测）    | 是，CONNECT 隧道（实测）    | 是（实测）                                                  | **选这个**                                                                                                              |
| `setProxy` PAC                                            | 是                                                                                | —                            | —                                             | —                           | 能按主机分流                                                | **否决**：PAC 模式下 Chromium 仍然隐式放行回环地址，`proxyBypassRules` 不起作用，回环请求根本到不了代理（实测，附录 A） |
| `protocol.handle("http")`                                 | 是                                                                                | 要自己实现 fetch，流式要手写 | **不行**：`ws:`/`wss:` 不经 `protocol.handle` | **不行**：TLS 不可见        | 要自己对非回环地址再 fetch 一遍（等于重写一个浏览器网络栈） | 否决（依据文档，未实测）                                                                                                |
| `webRequest.onBeforeRequest` 重定向                       | **否**：重定向会换 URL，页面看到的 `response.url` 和 origin 都变，cookie 随之换站 | 可                           | 只能改 URL，不能转发                          | 不行                        | 可                                                          | 否决（依据文档，未实测）                                                                                                |
| PR #8841 的做法                                           | 是                                                                                | 是                           | 是                                            | **否**（`https=direct://`） | 是                                                          | 机制和我们的第一行一样，但网关层不同，见附录 B                                                                          |

`setProxy` 的规则串：

```
mode:              "fixed_servers"
proxyRules:        "http://127.0.0.1:<该环境代理的端口>"      // 单个规则，http/https/ws/wss 都用它
proxyBypassRules:  "*;<-loopback>"
```

实测的三种规则串：

| `proxyBypassRules` | 回环地址                                                  | 非回环名（`direct.test` 解析到 127.0.0.1） |
| ------------------ | --------------------------------------------------------- | ------------------------------------------ |
| 不设               | **直连**（页面加载 `ERR_CONNECTION_REFUSED`），代理收不到 | —                                          |
| `<-loopback>`      | 走代理                                                    | **也走代理**（外部网站会被拖进去，不行）   |
| `*;<-loopback>`    | 走代理                                                    | 直连 ✓                                     |

所以只有第三种满足"其他地址照常直连"。

### 1.2 必须覆盖的情形（全部实测，Electron 44.10.1 / Chromium 152）

| 情形                                                                           | 结果                            | 代理看到的                                                         |
| ------------------------------------------------------------------------------ | ------------------------------- | ------------------------------------------------------------------ |
| `http://127.0.0.1:P`                                                           | ✓                               | `HTTP http://127.0.0.1:P/x`                                        |
| `http://localhost:P`                                                           | ✓                               | `HTTP http://localhost:P/x`                                        |
| `http://[::1]:P`                                                               | ✓                               | `HTTP http://[::1]:P/x`                                            |
| `http://127.0.0.2:P`、`127.255.255.254`                                        | ✓（整个 127/8）                 | 同上                                                               |
| `http://localhost.:P`（尾点）、`http://app.localhost:P`                        | ✓                               | 同上                                                               |
| `http://LOCALHOST:P`、`127.1`、`2130706433`、`0x7f.0.0.1`、`[0:0:0:0:0:0:0:1]` | ✓（URL 解析器先规范化）         | 规范化后的名字                                                     |
| `http://[::ffff:127.0.0.1]:P`                                                  | ✓                               | `HTTP http://[::ffff:7f00:1]:P/x`（**注意写法变了**）              |
| `http://0.0.0.0:P`、`http://[::]:P`                                            | **不过代理**，直连 A            | —                                                                  |
| `http://localhost.localdomain:P`                                               | 不过代理                        | —                                                                  |
| SSE（`EventSource`）                                                           | ✓ 三个事件按序到达              | `HTTP http://localhost:P/sse`                                      |
| `ws://localhost:P`、`ws://127.0.0.1:P`、`ws://[::1]:P`                         | ✓ 回显正常                      | `CONNECT localhost:P`、`CONNECT 127.0.0.1:P`、`CONNECT [::1]:P`    |
| `https://localhost:P`（自签名）                                                | ✓                               | `CONNECT localhost:P`（TLS 在页面和 B 的服务之间，代理看不到明文） |
| 未许可端口，主框架导航                                                         | 代理回的 403 页面直接显示       | —                                                                  |
| 未许可端口，子资源 `fetch`                                                     | `Failed to fetch`（不透明响应） | —                                                                  |

后果与对策：

- A 端代理的主机判定（`packages/shared` 里的同一个函数）要和 Chromium 的回环集合一致：`localhost`（含尾点）、`*.localhost`、`127.0.0.0/8`、`::1`、`::ffff:127.x.x.x`（写成 `::ffff:7f00:1`）。**其余一律 403**，即使 Chromium 不会发来。
- `0.0.0.0` 和 `[::]` 不会被转发。dev server 的启动日志有时会打印 `http://0.0.0.0:5173`。对策：地址规范化把这两个 host 换成 `localhost`，但**只用于显示和已知的 Preview URL**（`packages/shared/src/preview.ts` 的 `LOOPBACK_HOSTS` 已经把 `0.0.0.0` 当回环名，实现时核对 `normalizePreviewUrl` 是否已换）；规范化**不参与任何安全判断**：代理和 B 端只接受 Chromium 的回环集合，不接受"规范化之后才算回环"；页面自己写死的 `0.0.0.0` 不管，写进已知限制。判定和规范化放在 `packages/shared/src/forkLoopbackGateway/`，界面和主进程共用一个函数。
- 同一个分区里 **所有** 回环流量都去 B，A 自己的本机服务在这个分区里不可达（见 §2 的语义）。这正是要求，不是副作用。

### 1.3 其他实测结果

- `setProxy` 运行时可逆：改成 `{ mode: "direct" }` 再 `closeAllConnections()` 后，同一个页面对 `localhost:P` 的 `fetch` 立刻失败、代理日志为空；再设回代理并 `closeAllConnections()` 后恢复，无需重载页面。
- 连接复用：同一页面 30 个顺序请求 **0** 条新代理连接；40 个并发请求 5 条；10 个 WebSocket 10 条（每个 CONNECT 一条）。
- 代理认证：代理对没有 `Proxy-Authorization` 的请求回 `407`，Chromium 触发 `app.on("login")`（`authInfo.isProxy === true`，`webContentsType` 为 `webview`），应答后同一代理的 HTTP、CONNECT（https 和 ws）都带凭据，每个代理只收到 1 次 407。两个分区各用各的代理和各自的口令互不影响；不带口令的外部客户端直接连代理得到 `407`。
- `<webview>` 与 `WebContentsView` 在同一个 session 下行为一致。桌面预览实际用 `<webview>`（`DesktopWindow.ts:408` `webviewTag: true`，`:515` `will-attach-webview` 校验分区），`apps/desktop/src` 里没有 `WebContentsView`；画中画窗口是 `BrowserWindow` 加载一个 data URL，不加载页面本身。
- Electron 44.10.1 的 Node 是 24.22.1，`tls.getCACertificates` 和 `tls.setDefaultCACertificates` 存在（只确认了函数存在，没有调用，因为读系统信任库会碰钥匙串相关接口）。见 §3 的 TLS 信任。

## 2. 存储分区

### 2.1 现状（上游已经满足要求 4）

分区在 `apps/web/src/browser/HostedBrowserWebview.tsx` 里由 `usePreviewWebviewConfig(threadRef.environmentId, profileId)` 取得（`previewWebviewConfigState.ts`），桌面端 `getPreviewConfig` 的处理在 `apps/desktop/src/ipc/methods/preview.ts`：

```ts
// preview.ts:263  resolvePartitionScope
default 配置          → scope = environmentId,                 persistent = true
其他命名 profile      → scope = JSON.stringify([environmentId, profileId]), namespace "profile", persistent = true
内置 incognito        → 同上，persistent = false（分区名没有 persist: 前缀）
```

`BrowserSession.getPartition` 把 scope 做 SHA-256 取前 20 位拼进 `persist:t3code-preview-…`。`threadRef.environmentId` 是对话所在的环境，所以：

- 本机环境的标签页、环境 B 的标签页、环境 C 的标签页各有各的分区，B 的 `localhost:5173` 和 A 的 `localhost:5173` 是两个站。
- 每个环境内部，每个浏览器 profile 又是各自的分区。

**因此分区这一项零上游改动。** 唯一要做的是把"代理设置"挂在"环境的所有分区"上，见 §2.3。

### 2.2 各子系统

| 子系统                | 怎么选 session/分区                                                                                      | 与转发的关系                                                               |
| --------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 浏览器 profile / 无痕 | 如上；`will-attach-webview` 用 `isBrowserPartition` 校验前缀                                             | 同一环境的每个 profile、包括无痕，都要设同一个代理（它们是不同 session）   |
| passkey               | `PreviewPasskeys.installSessionHandlers(session)` 在 `getBrowserSession` 里按 session 安装；凭据在系统层 | 与网络无关，不受影响                                                       |
| favicon               | `FaviconCapture.ts:118` 用 `webContents.session.fetch`                                                   | 走该 session 的代理，`localhost` 的 favicon 会经转发取到，正好是想要的     |
| 历史                  | 渲染进程 `browserHistoryStore`，按线程记录，记的是 `localhost:5173` 原始 URL（`recordVisitForThread`）   | 不受影响。地址栏、历史、重启恢复里保存的都是原 URL，所以转发状态不用持久化 |
| CDP relay             | `CdpRelay.ts` 在 webContents 上附加调试器                                                                | 与网络无关                                                                 |
| 清除 profile 数据     | `clearCookies/clearCache(partitions)` 清存储和缓存                                                       | **不会**重置代理（代理不是存储）。代理由我们的安装器管，不受影响           |
| 外部下载              | `placeServerDownloads(session)`                                                                          | 不变                                                                       |

### 2.3 把代理装到环境的所有分区（首次导航之前）

渲染进程在创建该环境的第一个 `<webview>` 之前，通过新的 fork 桥 `window.t3xLoopbackGatewayBridge`（模式同 `t3xSelfHostBridge` 和 `keepAwake`：独立的 channels 文件、preload 里一小段 `exposeInMainWorld`、只给主窗口，内置浏览器页面拿不到）调用 `register(environmentId, { baseUrl, enabled })`。主进程：

1. 为该环境建一个代理（见 §3.2），状态为 `pending`（没有票据时对请求回 503，非回环请求不受影响）。主进程先做传输检查（§4.6），`httpBaseUrl` 不通过就当作 `enabled: false`。
2. **安装发生在 `getPreviewConfig` 的处理里。** 这个 IPC 方法（`apps/desktop/src/ipc/methods/preview.ts`）对每个（环境, profile）在返回分区名之前调用 `getBrowserSession`，此时 session 已创建但还没有任何 guest 附着。fork 的钩子在这里（上游 +3 行）对该环境装 `setProxy` 并登记 `partition → environmentId`。这样**任何** profile（默认、命名、无痕、**新建的 profile 的第一次导航**）都在首个请求之前就有代理，不依赖"事先知道有哪些 profile"。`getPreviewConfig` 的结果缓存 5 分钟（`PREVIEW_CONFIG_STALE_TIME_MS`），重取是幂等的。
3. `enabled: false`（B 不支持、用户关闭、明文、中继）→ 对该环境已登记的 session 改回 `{ mode: "direct" }` 并 `closeAllConnections()`，这就是反向状态（§10）。

渲染端在创建 webview 之前多等一道"网关已登记"的门。如果不等，应用刚启动恢复标签页时，第一个回环请求可能在 `register` 到达主进程之前就发出，直连 A 自己的 `localhost`，可能连到 A 上同端口的无关服务。

**9.3 的实现与上面的写法有两处不同。** ① 门放在 `ElectronBrowserHost.tsx` 的 `AuthorizedBrowserWebview`（已经有"没有预览权限就不挂 webview"的一层），不放在 `HostedBrowserWebview` 里：webview 的注册副作用（`did-attach`、`dom-ready`）只在 `config` 变化时重新挂监听，门放在里面会让 webview 在门打开后永远没有登记到桌面桥；放在外面，门不开就不挂整个组件（上游 +2 行）。② **"不等网络"不成立**：登记要用的 `httpBaseUrl`（实际路由）、能力位和权限都来自与 B 的连接（准备好的连接、服务器配置、会话状态），没有离线副本。所以重启后一个会被转发的环境，它的标签页要等该环境连上、状态确定、`register` 返回才挂 webview（对话本身也要等同一个连接才有内容）。等待的边界（修复轮按 GPT 复审改过）：本机在 `localStorage`（与"用户关闭"同一个键，`disabledStore.ts`，不进 `ClientSettings`，旧格式读得进来）记下**上次处于 `active` 的环境**。

- 状态还没确定（`unknown`），环境**上次是 `active`**，而 A 手里已经有这个标签页：门一直关着，不管环境是在连接还是离线、出错。地址栏显示 `localhost:5173` 而内容是 A 本机同端口的服务是骗人的界面，所以环境连不上时标签页显示\"连不上 {environment}\"卡片（连接中不显示卡片，只等），说明\"连上后这个标签页会自动打开\"，卡片上有「停止转发，使用这台电脑的 localhost」：设成 `disabled-by-user`，门打开，回到上游原来的行为，所以这不是只进不出的门。这张卡只在 A 已经有标签页时出现：标签页列表存在 B 的 `preview/Manager.ts` 的内存里（B 进程不重启就一直在），A 打开对话时才从 B 取回来。**A 重启时 B 离线：** A 手里没有标签页，也就没有 webview 可挂，不存在误开 A 本机 `localhost` 的风险；预览面板（`PreviewPanel`，会话状态读不到，`useEnvironmentScope` 为 false）显示\"连不上 {environment}，连上后浏览器预览会恢复\"一句话，不显示等待卡，也不再把离线说成\"请重新配对\"（会话已读到、确实没有预览权限时，仍是\"请重新配对\"。连接是 `offline`、`available`、`connecting`、`reconnecting` 时才说\"连不上\"；认证失败、设备被吊销、配置错误会让连接进入 `blocked`，表现为 `error` 或 `unsupported`，不会自己恢复，仍显示\"请重新配对\"）。**B 重启后：** B 的标签页列表随进程清空，B 回来后 A 取到的是空列表，浏览器标签页被上游的 `reconcileBrowserSurfaces` 清掉，右侧面板收起，回到\"线程详情\"；这是上游行为（读代码得出，`Manager.ts` 的会话表和 `reconcileBrowserSurfaces` 都没有 fork 改动，与有没有转发无关），转发的标签页不会自己回来，要重新打开。
- 状态还没确定，环境本机**从没 `active` 过**：只在环境正在连接时等，离线或出错就放行（保持第一版的行为）。
- 状态确定后：`active` 先等 `register` 再开门，**只有 `registered` 才开**：`register` 失败（`failed`）时门保持关闭，因为主进程没有登记这个环境，`installSession` 会把 session 恢复成直连，放行就会加载 A 本机同端口的服务（第三轮 P0）。这时标签页显示「无法启动 localhost 转发」卡片（`start-failed`），按钮「重试」（让控制器对该环境重新 `register`，成功后照常取票、开门）和「停止转发，使用这台电脑的 localhost」（`disabled-by-user`，门打开）；不转发的状态（不支持、明文、没有权限、不适用）开门，并把该环境从记录里删掉；`disabled-by-user` 开门（记录保留，恢复转发后下次重启仍受保护）。
- 环境从应用里移除（保存的环境列表加载完之后不在其中）时，从记录里删掉。
- **锁存（第四轮改）：** 只有 webview 真的建出来才锁存（没有预览权限、`canOperatePreview` 为 false 时不挂 webview，也就不锁存）。锁存时记下这次是不是**在转发中**打开的（`active` 且 `registered`）。在转发中打开的页面，断线（`unknown`、重连、`failed`）时保持打开，由卡片盖住，不拆掉已经显示的页面；但一旦状态确定为不转发（用户「停止转发」，或不支持、明文、没有权限），它就降为非转发打开：页面不动（代理已拆，它此刻就是跑在这台电脑上），之后恢复到 `active` 而登记没完成时同样卸载，登记完成后重新挂上。在非转发状态下打开的页面（`disabled-by-user`、不支持转发的环境、重启时离线又从没转发过的环境）不能留着：一旦状态变成 `active` 而登记还没完成，门关上、webview 卸载，登记完成后重新挂上，新的 webview 从第一个请求起就走代理。为此 `register` 以 `enabled: false` 成功时发布 `stopped` 而不是 `registered`（「恢复转发」时，主进程还没有代理，旧的 `registered` 不能当作放行依据）。路由变化时控制器在排队 `register` 之前先发布 `pending`，新标签页在新路由登记完成前不创建 webview（代理本身一直留着，不先出错误页）。规则是纯函数 `nextGateLatch`，表格测试覆盖各种转换。

**主进程忘了环境时：** 取票时 `updateTicket` 返回 `null` 表示主进程不认识这个环境（登记竞态、主进程重启），再试一次 `updateTicket` 没用。控制器把它当作未登记：发布 `pending`（新标签页的门关上，已打开的页面不拆），清掉票据和续期定时器，重新 `register`，成功后照常取票。刚重新登记完又得到 `null` 就不再自己转圈，发布 `failed`，由用户重试或停止转发。

真实 Electron 冒烟（9.2）要覆盖 `setProxy` 之外的网络路径（GPT P2-1）：Service Worker 发起的请求、`<link rel=prefetch>`/`preconnect`、`navigator.sendBeacon`、WebSocket、无痕分区（非 `persist:`）、新 profile 第一次导航之前、`webContents.session.fetch`（favicon）、下载。每一项断言代理日志里看到了请求，或者明确记录它不经过代理。

### 2.4 分区之后会坏什么

- **没有新的破坏。** 分区本来就是这样分的，外部网站登录、passkey 都已经是"每个环境一份"。
- 语义变化：环境 B 的分区里，`localhost`、`127.x`、`[::1]` 永远指 B。想在 B 的对话里打开 A 自己的 `localhost:3000`，只能用系统浏览器，或者用本机环境对话里的标签页。要写进用户文档和徽标的提示里。
- OAuth 回调到 `http://localhost:<随机口>/callback` 的登录流程：回调的接收方如果是 A 上的 CLI，在 B 的分区里会连到 B。这是已知限制，写进文档。
- WSL 等 `isDesktopLocalConnectionTarget` 的环境，回环地址与 A 共享，**不装代理**（沿用 `reachesEnvironmentLoopback`）。
- **转发开着时，该环境所有分区里的非回环流量绕过系统代理**（9.2 审查 P2-2）。`fixed_servers` 加 `*;<-loopback>` 是让非回环地址直连的唯一写法，Chromium 没有"回环走我们、其余走系统代理"的按目标分流。用 Clash、公司代理的用户在这些标签页里访问外部网站会直连；停止转发后恢复 `system`。写进用户文档和转发标识的说明（9.3、9.4），FORK.md 也记了。

## 3. A 到 B 的传输

### 3.1 一连接一隧道，不多路复用

|               | 每条 TCP 连接一个 WebSocket（推荐）                                                        | 一条长连接多路复用                                        |
| ------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| 实现          | A 端代理把 Chromium 连接接到一条 WS；B 端是 `WS ↔ net.connect`                             | 要自定义帧、流 ID、每流流控、心跳                         |
| 背压          | 每条隧道一个节点流管线，天然                                                               | 要给每个流做窗口，否则一个暂停的 SSE 阻塞全部（队头阻塞） |
| 失败隔离      | 一条断不影响其他                                                                           | 底层断了全部断                                            |
| 经 VPS 的握手 | 每条新隧道 = TLS 复用不了的一次 WS 升级（Caddy → frps → frpc → 隧道监听口），多 1–2 个往返 | 首次之后零开销                                            |
| B 端攻击面    | 最小：不解析任何协议，只拨端口                                                             | 要解析自定义帧                                            |

连接数很小：Chromium 对代理的 HTTP 连接可复用（实测 30 个顺序请求 0 条新连接），冷启动一个 Vite 页面并发约 5–6 条，另外每个 HMR WebSocket 一条。所以推荐**每连接一隧道**，由代理保留 A→B 的 keep-alive 池（见 3.2）。多路复用只在 §11 的测量显示首屏明显偏慢时才做，先做的是更便宜的"为常用端口预开 1–2 条空闲隧道"。

### 3.2 A 端代理（桌面主进程）

按环境一个实例：`http.createServer` 只绑 `127.0.0.1:0`（不绑 `::1`，不绑通配），随机 256 位口令，要求 `Proxy-Authorization: Basic`。口令的规则和限制见 §4.7。

- 普通 HTTP 请求（绝对 URI）：校验主机是回环名（`packages/shared` 里的同一个判定函数，§12 的 9.2）、取出端口，用 `http.Agent`（`keepAlive`，每端口 `maxSockets` 16，空闲 30 秒）转成源站形式的请求，agent 的 `createConnection` 返回一条到 B 的隧道（`ws` 的 `createWebSocketStream`，自带背压）。`Host` 头原样保留（页面发 `Host: localhost:5173`，B 上的程序也看到这个）。剥掉 `Proxy-*` 和逐跳头。Chromium 对 HTTP 代理的连接池按代理分组而不是按目标（凭记忆，没有专门实测），同一条 Chromium 连接上可能先后出现不同端口的请求，所以设计上**不能**把一条 Chromium 连接固定绑给一条隧道；必须在请求层选隧道。
- `CONNECT host:port`：校验后回 `200`，把这条 Chromium 连接和一条新隧道对接（字节管道）。`ws://`、`wss://`、`https://` 都走这条。
- 不支持的：明文 HTTP 的 `Upgrade`（Chromium 对 `ws://` 用 CONNECT，实测，所以不会出现）→ 501。
- 开隧道之前，主进程自己再做一次传输检查（§4.6）：渲染进程说"启用"也不够，`httpBaseUrl` 不是加密或本机的，主进程直接拒绝，不发出任何连接。
- 错误响应是自带样式、已翻译的 HTML，带 `X-T3x-Gateway-Error: <code>` 响应头；主进程用该 session 的 `webRequest.onHeadersReceived` 看到主框架上的这个头，就给渲染进程发事件，由 `PreviewUnreachable` 画卡片（§7）。CONNECT 被拒时回 `403`，同时发同样的事件。

**A 端的第一步（9.2 开头）要验证的实现细节：** `http.Agent` 的 `createConnection` 返回自定义 `Duplex` 时缺少 `setKeepAlive/setNoDelay/setTimeout/ref/unref`，要补空实现；SSE、分块、`100-continue`、大上传、keep-alive 复用都要有测试；`ws` 的 `createWebSocketStream` 到 B 的通路；TLS 校验失败的错误码映射和 `ws` 不跟随重定向（§3.6，第一版不并入系统根证书）。任何一项做不成就停下回报。

**第一步结论（9.2 实测，`apps/desktop/src/fork/loopbackGateway/`，2026-11-04）：前提成立，没有停下。**

| 项                                                | 结果                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `http.Agent.createConnection` 返回自定义 `Duplex` | 可行，用回调形式（`createConnection(options, callback)`，隧道打开后才 `callback(null, socket)`，失败直接 `callback(error)`，请求得到同一个错误对象）。socket 上要有 `setKeepAlive`、`setNoDelay`、`setTimeout`（带"最近一次读写后"重置的空闲计时，`timeout` 属性与之一致）、`ref`、`unref`。SSE、分块响应、分块请求体、6 MiB 带 `Content-Length` 的上传、`Expect: 100-continue`、`Connection: close`（两个方向）、keep-alive 复用、同一条 Chromium 连接上交替请求两个端口（各用各的隧道）都在真实隧道上通过。 |
| 一个 Node 的坑                                    | 请求体在隧道接上之前就写进 `ClientRequest` 时，Node 把它存在请求自己的缓冲里，等 socket 到了刷出去，但**不再发 `drain`**（socket 的 `write` 一直返回 `true`），管道停在第一块。表现：超过 64 KiB 的上传永远不结束；普通 `net.Socket` 不会这样，因为它的 `write` 在连接期间会返回 `false`。对策：代理在 `upstream` 的 `socket` 事件之后才开始 `pipeline(req, upstream)`；`Expect: 100-continue` 的请求在 `continue` 事件里同样检查 `upstream.socket`。                                                         |
| `ws` 的 `createWebSocketStream`                   | **没有采用，改用 `ws` 之上的自有 `Duplex`（`TunnelSocket`）。** `createWebSocketStream` 没有上面的 socket 方法和空闲计时，也不拆分超过消息上限的单次写；自有版本的背压仍来自节点流（`push` 返回 `false` 时 `ws.pause()`，`_read` 时 `ws.resume()`，`_write` 等 `ws.send` 的回调；`highWaterMark` = 1 MiB），单次写超过 1 MiB 时按 1 MiB 拆帧，一端关闭另一端关闭，没有半关闭。                                                                                                                                |
| 过期的 keep-alive 隧道                            | B 把空闲隧道关了而代理还停着它：对**无请求体的 `GET`/`HEAD`/`OPTIONS`**自动用新隧道重试一次；其他方法不重试，页面得到 502。                                                                                                                                                                                                                                                                                                                                                                                   |
| 超大帧                                            | 对端发超过 1 MiB 的消息：`ws` 的 `maxPayload` 关闭连接，隧道关闭，不交付任何字节。                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 未经认证的连接                                    | 定义为"收到过一次 407 且尚未关闭"的连接（407 带 `Connection: close`，所以实际同时存在的很少）；每秒超过 20 次直接销毁、不回应是实际起作用的那一条。**没有**把"建立了但还没发请求"的连接算作未认证：Chromium 会预连接空闲的代理连接，算进去会拒绝正常流量。                                                                                                                                                                                                                                                    |
| 空闲                                              | 代理本身 `keepAliveTimeout` 30 秒，每端口 HTTP 连接 16、空闲 30 秒回收（`Agent` 的 `timeout` 配合 `TunnelSocket.setTimeout`）。                                                                                                                                                                                                                                                                                                                                                                               |

错误页和 `CONNECT` 失败：HTTP 请求得到带 `X-T3x-Gateway-Error: <code>` 的 HTML 页，状态码：`unauthorized` 和"还没有票据"是 **503**（不用 401 或 407，页面可能把它当成认证质询），`forbidden`/`not-owned`/`reserved`/`debug-process`/`discovery-disabled` 是 403，`owner-changed` 409，`rate-limited`/`limit-reached` 429，其余 502；`CONNECT` 失败用同一个状态和头，不带页面。代理会去掉服务端响应里自带的 `X-T3x-Gateway-*` 头。

**真实 Electron 冒烟（`vp run fork:loopback-gateway:electron-smoke`，Electron 44.10.1，20/20）：** 普通 HTTP（`location.origin` 不变，另一个没装代理的分区直连、没有隧道）、SSE、WebSocket（额外一条隧道）、`https://localhost`（自签名服务，TLS 端到端经隧道）、Service Worker 发起的请求、`<link rel=prefetch>`（走隧道）与 `preconnect`（只连代理，不直连）、`sendBeacon`、无痕分区、新 profile 首次导航之前 `resolveProxy` 已是代理、`session.fetch` 的 favicon、1 MiB 下载、`direct.test`（非回环名）直连、被拒端口的 403 页加主框架事件（带 `webContentsId` 和 URL）、被拒 https 端口的 `ERR_TUNNEL_CONNECTION_FAILED` 加无页面事件、无票据 503 加 `ticket-needed`、`<webview>` 来宾、停止转发再恢复、5 次代理质询全部被我们的监听器应答且没有遗漏。冒烟的脚本和第一轮输出在 `apps/desktop/scripts/loopback-gateway-smoke/` 和 `/tmp/t3x-p92/`。

### 3.3 B 端网关路由

`GET /api/loopback-gateway/tunnel?port=<n>`，WebSocket 升级，**票据在 `Authorization` 头里，不在 URL 里**。挂在 **共享的 `HttpRouter`** 上，所以 `TunnelListener.withTunnel` 的第二个监听口（frpc 的 `localPort`）自动也有这条路由：`TunnelListener.ts` 的注释写明它"serves the application a second time"，复用同一个 router。主监听口（局域网、Tailscale、SSH 转发）和自建隧道因此用同一份代码，不需要为隧道口写任何特别逻辑。

处理顺序（全部在升级之前，失败返回带 JSON 的 HTTP 状态，Node 的 `ws` 客户端能从 `unexpected-response` 读到）：

1. fork 自己的认证函数 `authenticateGatewayTicket`（§4.4）：query 里有 `wsTicket` → 400；带 `Origin` → 403；`Authorization` 方案不是 `T3X-Gateway` → 401；票据验证；**严格** audience；两个 scope。
2. 并发与速率上限（§3.7）。
3. 端口许可、现场核对、排除（§5.3）。
4. 在**开始等待会话失效之后**才拨号：先启动 `sessions.awaitInvalidation`，再拨 §5.3 复核得到的那个地址，超时 3 秒；拨号期间会话被撤销就放弃拨号。失败 → `502 { code: "upstream-refused" }`。
5. 接受升级，建立双向管道：二进制帧 = TCP 字节，不用文本帧；B 每 30 秒发 WS ping，90 秒收不到 pong 就关；有任一端关闭就关另一端（TCP 和 WS 两端都要销毁，§4.8 逐条测）。
6. 与会话的失效竞速：和 `ws.ts` 里 `/ws` 路由一样用 `raceFirst`。**不调用** `markConnected`（隧道不是"一个已连接的客户端"，不应出现在连接列表里；`revoke` 总会发布 `clientRemoved`，不依赖 `markConnected`，已核对 `SessionStore.ts:988-1006`）。

不设空闲超时。理由：Vite 的 HMR 客户端在 WebSocket 非正常关闭后会轮询并 `location.reload()`，空闲超时会让页面莫名重载；靠存活探测和两端关闭传播就够。

**B 端的技术前提：已验证（9.1 M2，测试都在 `apps/server/src/fork/loopbackGateway/TunnelRoute.test.ts`、`TunnelRevocation.test.ts`，原始输出在 `/tmp/t3x-p91/`）。** 做法没有退回到别的传输层：路由用自己的 `WebSocketServer({ noServer: true, maxPayload: 1 MiB, perMessageDeflate: false })` 处理 `request.upgrade` 的 Socket，用 `ws.createWebSocketStream` 与 `net.Socket` 互相 `pipe`，背压由 Node 流承担。

- **两个监听口：** 同一份用例在主监听口和 `TunnelListener` 口各跑一遍（同一个 router，真实的 `ws` 客户端和真实回环服务），字节双向一致。
- **背压：** 两个方向各灌 192 MiB，对端不读时，发送端的缓冲都停在 32 MiB 以下。变异检查：把 `tcp.pipe(stream)` 换成 `tcp.on("data", c => ws.send(c))`，测试失败（缓冲到 178,963,056 字节，门槛 33,554,432），所以测试能发现背压丢失；检查后文件已还原。
- **关闭传播：** 任一端关闭，另一端随之销毁；超过 1 MiB 的帧关闭两端。
- **`awaitInvalidation` 竞速：** 会话被撤销、自然过期（`TestClock`）、续期链上的续期行被撤销、续期链的原始行被撤销，四种情形都关闭 WS 和 TCP 两端，且之后不再转发字节；授权进行时被撤销，服务端收到 0 个连接；升级与撤销在 24 个不同延迟点上竞速，结果只有"被拒"或"随后关闭"两种，没有第三种。
- **没有验证的：** frp、Caddy、Tailscale 的行为（9.4）；Linux（§5.6.5）。

### 3.4 与 Caddy、frp 的关系

从仓库配置读到的，不是新测的：

- `infra/self-host/Caddyfile` 的 `reverse_proxy frps:8080` 有 `flush_interval -1`（流式响应立即发出）。原来还有 `stream_close_delay 5m`，9.4 在真实 VPS 上实测它不起作用：frpc 的控制连接（`/~!frp`）也经过 Caddy，重载时立刻断开，经它复用的已升级连接跟着一起断，所以删掉了。Caddy 对已升级的连接没有空闲超时。
- frpc 到 frps 的控制连接心跳 30 秒、超时 90 秒（`frpcConfig.ts`）；frps 的 vhost HTTP 代理按 Host 路由，WebSocket 升级是 HTTP 反向代理的标准能力。我没有测过 frp 对"几十条并发升级连接"和"长时间空闲连接"的行为，列在 §14 的未验证项里，9.4 在本地试用栈上测。
- B 每 30 秒的 WS ping 同时防住中间设备（NAT、移动网络）因空闲回收映射。
- Caddy 重载或 frps 重启时隧道会断。Chromium 对 HTTP 会重试新连接；Vite HMR 会自己恢复；其他 WebSocket 由页面自己负责，与直连时 dev server 重启一样。
- 票据在 `Authorization` 头里。**不把"Caddy 默认遮蔽"当安全前提**：当前 `Caddyfile` 没有 `log` 指令（没有访问日志），9.4 的基础设施测试断言没有未加过滤的 `log`，并在 `infra/self-host/README` 里写明；9.4 还要在本地试用栈里临时打开 Caddy 的访问日志，实测 `Authorization` 被遮蔽（Caddy 的日志编码器遮蔽 `Authorization`、`Cookie`、`Set-Cookie`、`Proxy-Authorization` 出自其文档，凭记忆，以实测为准）；frps 的日志是否打印请求头也在同一个栈上实测——用哨兵票据发一条隧道升级，grep frps 和 Caddy 的全部日志输出，打印就关掉或配置过滤。frp 与 Caddy 是否**原样保留** `Authorization` 头同样在 9.4 实测（§3.5）。这些都实测通过之前，复核的 P0-2 不能标为解决（§4.3）。

### 3.5 连接方式与支持矩阵

启用条件由 §4.6 的纯函数决定。"状态"列诚实标注：没有验证过的一律是**待验证**，不写"支持"。

**怎样避免这张表被当作"已支持"（复核 P1-7）：** 「待验证」的方式在 9.1–9.3 阶段对开发版开放，是为了让 9.4 能测它们；这不等于支持。用户文档（`docs/user/remote-access.md`）和 FORK.md 只列状态为「已验证」的方式，其余写成"尚未验证"。9.4 验证完才改状态。

| 连接方式                                                                             | 启用条件                                                                                                                                                                       | 状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 局域网 `http://`（明文）                                                             | **不启用**，`unsupported-route` / `insecure-transport`，走旧行为                                                                                                               | 决定（主控 Q1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 同一台电脑上的另一个环境（`http://127.0.0.1:<端口>`）                                | 启用（回环，不需要加密）                                                                                                                                                       | **已验证**（2026-11-07）：真实桌面版 Electron 里走查过页面、SSE、WebSocket、Vite 热更新、`https://localhost` 自签名、停止与恢复转发、B 掉线与重连、拒绝卡片，另有 `fork:loopback-gateway:electron-smoke` 的 29 个场景。**没有单独测：** 空闲 30 分钟以上后的热更新。同一台电脑上网络路径里没有任何中间设备，这一行证明不了别的连接方式                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 局域网 `https://`（公共 CA 的证书）                                                  | 启用                                                                                                                                                                           | 待验证。没有在真实局域网上测过；TLS 校验失败的几种情形只在 `TunnelClient.test.ts` 里用真实 TLS 服务端测过（§3.6）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Tailscale 直连 `http://`，**只认 MagicDNS 名字 `*.ts.net` 和 `fd7a:115c:a1e0::/48`** | 启用（WireGuard 加密）。判定是上游的 `isTailnetHost`（`packages/shared/src/hostClassification.ts:83`），不另写                                                                 | **已验证（IPv6 地址，2026-11-07）**：两台真实 Mac（A 和 B），A 经 `http://[fd7a:115c:a1e0::…]:<端口>` 连 B，往返约 6 ms，B 只监听这个地址。已验证：页面、SSE、WebSocket；Vite 热更新 0.37–0.68 秒；真实 Electron 里 300 个模块的图 1.14–1.27 秒；40 条 WS 同时升级全部回显（同时 41 条隧道）；366 次真实升级都带票据通过认证，Bearer 和伪造票据是 401，票据不进 B 的日志；空闲 31 分 39 秒后热更新仍可用；重启 B 后 3–4 秒重连。**没测：** MagicDNS 名字（A 上的开源版 tailscaled 解析不了 `*.ts.net`）；断网再通（不能停 Tailscale）。注意：系统代理如果没把 tailnet 列为例外，Chromium 到 tailnet 地址的 WebSocket 会被代理截断，主连接都建不起来，这是上游的连接，与转发无关                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Tailscale 的 **IPv4 地址**（`100.64.0.0/10`）明文 `http://`                          | **不启用**，`unsupported-route` / `insecure-transport`。上游刻意不单独把这个段当 Tailscale（运营商级 NAT 也用它），我们跟随（主控 N3）。错误卡片提示改用 MagicDNS 名字或 HTTPS | 决定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Tailscale Serve（`https://*.ts.net`）                                                | 启用（`https:`）                                                                                                                                                               | 待验证（Serve 对 WS 升级和自定义 `Authorization` 头的转发）。9.4 用的 tailnet 没开 HTTPS 证书，没测。2026-11-18 测了基本流程：两台真实 Mac，经 `https://<机器名>.<tailnet>.ts.net:<端口>` 打开 B 的回环页面、手动放行端口都正常；长连接、重连、并发没测                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| SSH 环境                                                                             | 启用（`httpBaseUrl` 是 A 上的转发端口 `http://127.0.0.1:<本地口>`，回环；SSH 本身是加密的）                                                                                    | **打包版不提供**（2026-11-07 读代码核对，没测）：桌面版给 SSH 远程主机装的是同版本的官方 server 归档（`apps/desktop/src/main.ts` 的 `resolveDesktopSshCliRunner`，`OFFICIAL_CLI_RELEASE_DOWNLOAD_URL`），它不广告 `loopbackGateway`，A 照旧行为。只有开发版用本仓库的 server 脚本，才会走到左边的启用条件。所以 #26890（`resolveEnvironmentPortTarget` 把 SSH 环境的 `localhost:5173` 原样指到 A 自己的 `localhost`）在打包版里仍然存在                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 自建隧道（`t3x-device`，`https://<名字>.<域名>`，Let's Encrypt 证书）                | 启用                                                                                                                                                                           | **已验证（真实 VPS，2026-11-08）**：公网 VPS（my-vps）上的 `t3.example.com`，Let's Encrypt 证书。测试部署和文档不同：VPS 上已有的 nginx 在 443 终止 TLS，再转给只监听回环的 Caddy。A 按用户文档加入服务器、用设备密钥连 B，B 只监听回环。已验证：页面、SSE、WebSocket；Vite 热更新；40 条 WS 同时升级（同时 45 条隧道）；102 次真实升级带票据通过认证，Bearer、伪造票据、不带头都是 401；B、三个容器、nginx 的日志里都没有票据；空闲 30 分 31 秒后热更新仍可用；frps 重启后 A 约 7 秒恢复；重启 B 后 18 秒恢复；公共 CA 证书链校验通过；系统代理开着也能连（这条主连接由后端的 Node 发起）。本地试用栈上另有 e2e 场景 15、16（移除设备后隧道两端关闭，Caddy 访问日志里 `Authorization` 是 `REDACTED`）。**Caddy 重载撑不过去：** frpc 的控制连接也经过 Caddy，重载时立刻断开，经它复用的隧道一起断；frpc 1.5–3 秒重连，A 5–7 秒恢复，Vite 自己刷新，其他实时页面要手动刷新，表现和 frps 重启一样（§3.4）。**延迟：** 两台 Mac 去这台 VPS 都绕 VPN（单程约 300 ms，绑物理网卡直连 40–55 ms），单个请求 632 ms，真实 Electron 里 300 个模块的图 37.6–38.6 秒，同一张图在 Tailscale 上是 1.2 秒，差别是网络路线的代价。**没测：** A 断网；证书过期、自签名、主机名不符（主连接自己会先失败，转发走不到，由 `TunnelClient.test.ts` 用真实 TLS 覆盖）。顺带修了阶段 8 的 `f76f308b0a`：刚加入服务器时 B 回 `device_unknown`，web 和桌面版跨源读不到 `t3x-reason`，直接失败而不是等待；修复后实测显示“等待那台电脑确认…”，约 16 秒后自动连上 |
| 私有 CA 的 `https://`                                                                | 传输检查通过，但**主进程不信任这张证书**（§3.6），TLS 校验失败，错误卡片说明"证书不受信任"                                                                                     | **第一版不支持**（已知限制）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| T3 Connect 中继                                                                      | 不启用，`unsupported-route` / `relay`                                                                                                                                          | 决定：fork 默认没有官方 `.env`，T3 Connect 默认不可用；中继链路对 WebSocket 升级和并发数的限制我们既不拥有也不测试。检测依据是连接目标 `RelayConnectionTarget`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| WSL / 桌面本地目标                                                                   | 不需要                                                                                                                                                                         | 回环共享，保持现状                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

9.4 的结果在上表：同一台电脑、Tailscale（IPv6 地址）、自建隧道（真实 VPS）已验证，用户文档只写这三种；局域网 https、Tailscale 的 MagicDNS 名字和 Serve 仍是待验证（后两种在 2026-11-18 只测了基本流程）；SSH 环境在打包版里不提供。要把剩下的某一行改成“已验证”，需要在那种真实连接上测：打开 WS 隧道、长连接（至少 30 分钟空闲后 HMR 仍能用）、重连（重启 B、断网再通）、证书（公共 CA 的有效证书通过；过期、自签名、主机名不符都失败并给出“证书不受信任”）、`Authorization` 头原样到达 B、并发（几十条隧道同时升级）。

### 3.6 TLS：校验失败就是失败，第一版不并入系统根证书

A 主进程用 Node 的 TLS 连 B。渲染进程（Chromium）信任系统根证书和用户装的私有 CA；Node 默认只信任自带的 Mozilla 根。

**决定（主控 N7）：第一版不把系统根证书并入主进程。** 不调用 `tls.setDefaultCACertificates` 或 `tls.getCACertificates("system")`（那会读系统信任库，碰钥匙串相关接口）。后果是已知限制：B 的 `https://` 地址如果用的是用户自己装的私有 CA（公司内网 CA、mkcert），渲染进程能连、主进程连不上，转发失败。自建隧道用 Let's Encrypt，Tailscale 的证书是公共 CA 签的，这两种没问题。限制写进用户文档，错误卡片提示改用公共 CA 的证书、Tailscale，或「在 {environment} 的浏览器中打开」。

规则：

- **传输检查只决定"要不要尝试"，不是安全结论。** `https:` 通过检查不等于连接安全；证书有没有通过校验才是。主进程的 `ws` 永远不设 `rejectUnauthorized: false`、不设自定义 `checkServerIdentity`，也没有任何开关绕过校验。
- TLS 校验失败（过期、自签名、链不完整、主机名不符）→ 隧道失败，事件 `tls-untrusted`，错误卡片「证书不受信任」。Node 的这类错误码（`UNABLE_TO_VERIFY_LEAF_SIGNATURE`、`SELF_SIGNED_CERT_IN_CHAIN`、`DEPTH_ZERO_SELF_SIGNED_CERT`、`CERT_HAS_EXPIRED`、`ERR_TLS_CERT_ALTNAME_INVALID`、`UNABLE_TO_GET_ISSUER_CERT_LOCALLY` 等）一律映射到这个事件，其他网络错误映射到 `offline`。具体错误码集合在 9.2 用真实 TLS 服务端（自签名、过期、错主机名）逐个测出，不凭记忆。
- 回环和 `ws:`（SSH 转发口、本机）没有证书问题。
- 主进程的 `ws` **不走系统代理**；A 必须经代理才能到达 B 的情形不支持，网关会报 `offline`。
- **`ws` 不跟随重定向**：显式设 `followRedirects: false`，对隧道升级请求的 3xx 当作失败（`unexpected-redirect`）。重定向会改变连接目标，使"按哪个地址做过传输检查"失去意义。
- **连接目标在安装票据时固定。** 渲染进程把 `{ baseUrl, ticket }` 作为一对交给主进程；主进程对这个 `baseUrl` 做传输检查，之后该环境所有隧道都只连这个 `baseUrl`，连接建立后不会切到另一个地址。路由变了（局域网 → 隧道，或相反）：渲染进程推新的一对，主进程重新判定加密与否，**并换用新票据**；新地址不通过检查就拆代理、关隧道（§10）。

**实测的错误码（9.2，真实 TLS 服务端，`TunnelClient.test.ts`；证书由测试里的 `openssl` 生成，测试 CA 通过 `tls.setDefaultCACertificates` 只在测试进程里受信任）：**

| 服务端证书                    | Node 的错误码                     | 事件            |
| ----------------------------- | --------------------------------- | --------------- |
| 自签名（没人签发）            | `DEPTH_ZERO_SELF_SIGNED_CERT`     | `tls-untrusted` |
| 过期（CA 签发，2020 年到期）  | `CERT_HAS_EXPIRED`                | `tls-untrusted` |
| 签发给另一个主机名（CA 签发） | `ERR_TLS_CERT_ALTNAME_INVALID`    | `tls-untrusted` |
| 链不完整（中间证书没有发送）  | `UNABLE_TO_VERIFY_LEAF_SIGNATURE` | `tls-untrusted` |
| 链完整、CA 受信任             | 通过                              | 隧道建立        |

映射用一个集合（上面四个加 `SELF_SIGNED_CERT_IN_CHAIN`、`UNABLE_TO_GET_ISSUER_CERT(_LOCALLY)`、`CERT_NOT_YET_VALID`、`CERT_UNTRUSTED`、`CERT_REVOKED`、`CERT_SIGNATURE_FAILURE`、`CERT_CHAIN_TOO_LONG`、`INVALID_CA`、`HOSTNAME_MISMATCH`），其余网络错误是 `offline`。四种失败时服务端都没有收到任何升级请求。

升级响应是 3xx：`ws` 在 `followRedirects: false` 时把它交给 `unexpected-response`，映射为 `unexpected-redirect`，**重定向目标没有被连接**（测试里目标服务器计数为 0）。升级失败而响应体不是网关的错误 JSON 时按状态映射：401 `unauthorized`，403 `forbidden`，429 `rate-limited`，200/404/405（旧版或上游服务端没有这条路由，或被兜底路由接住）`unsupported-server`，其余 `offline`。

静态扫描测试（`noInsecureTls.test.ts`）：`apps/*/src` 和 `packages/*/src` 里没有 `rejectUnauthorized: false`、`NODE_TLS_REJECT_UNAUTHORIZED`、`checkServerIdentity`；`apps/desktop/src` 的非测试代码里没有 `setDefaultCACertificates`、`getCACertificates`（N7：不读系统信任库）。

### 3.7 背压与上限

| 项                                          | 值                                                                 |
| ------------------------------------------- | ------------------------------------------------------------------ |
| 每会话并发隧道（B 端）                      | 64                                                                 |
| 每台 server 并发隧道（B 端）                | 256                                                                |
| 每会话新建隧道速率（B 端）                  | 令牌桶，突发 60，每秒补 30，超了回 `429 rate-limited`              |
| 每会话签发票据速率（B 端）                  | 每分钟 30 次                                                       |
| 每环境 Chromium 到代理的并发连接（A 端）    | 256                                                                |
| 每环境同时在途的"开隧道"（A 端）            | 32                                                                 |
| 未通过 `Proxy-Authorization` 的连接（A 端） | 最多同时 8 条，每条回一次 407 就关；每秒超过 20 次直接销毁，不回应 |
| A→B 每端口 HTTP 连接                        | 16，空闲 30 秒回收                                                 |
| 单条隧道发送缓冲                            | 超过 1 MiB 暂停读对端（节点流背压）                                |
| 读块大小                                    | 64 KiB                                                             |
| 单个 WS 消息最大                            | 1 MiB（超过关闭，防止对端灌大帧）                                  |

数值是起点，测试按这些数断言，调整时测试和文档一起改。**关闭传播、背压、帧和连接上限都在 socket 层测**（真实 TCP 套接字和真实 `ws`，或一对 `Duplex`），不靠页面级或截图级测试：写慢的一端停止读取对端；超大帧关闭；第 65 条隧道得到 429；两端任何一端关闭另一端也关闭，且不再转发字节。

## 4. 认证、权限、撤销

### 4.1 为什么是票据

渲染进程有 DPoP 私钥和到 B 的认证连接，主进程没有。把私钥交给主进程违背现有设计（`research/self-host-device-keys.md` Q3 对设备密钥的结论同理）；让主进程代渲染进程发每个字节的请求太重。所以：**渲染进程换一张短期票据，交给主进程；主进程凭票据开隧道。**

| 方案                                                                         | 评价                                                                                                                                                                                                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #8841：自签 HMAC 票据，只含端口和过期时间                                    | 不绑会话，撤销不了；任何持有者 5 分钟内可用；签名密钥单独管理                                                                                                                                                       |
| 复用现成的 `wsTicket`，**audience 用 `"media"`**                             | 现成，但同一张票据也能打开预览推流等媒体路由，范围比需要的大                                                                                                                                                        |
| **复用 `wsTicket` 的签发与验证，新增 audience `"loopback-gateway"`（推荐）** | `SessionStore.issueWebSocketToken(sessionId, { audience })` 已有；票据绑会话，`verifyWebSocketToken` 每次读库检查未撤销、未过期；上游只改 `AuthWebSocketTicketUse` 的一个字面量；**认证函数是 fork 自己的**（§4.4） |

### 4.2 票据

| 属性             | 值                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 形态             | `base64url(claims).hmac`，由 `SessionStore` 签发，签名密钥是这台 server 的 `server-signing-key`（别的环境的 server 验不过）                                                                                                                                                                                                                                                              |
| 签发             | RPC `loopbackGateway.issueTicket` 的处理器直接调用 `sessions.issueWebSocketToken(sessionId, { audience: "loopback-gateway", proofKeyThumbprint })`，TTL 用默认的 5 分钟（`DEFAULT_WEBSOCKET_TOKEN_TTL`）。`proofKeyThumbprint` 的含义和为什么要有它见下面的 N1；不采纳 N1 时改用 `EnvironmentAuth.issueWebSocketTicket(session, { use: "loopback-gateway" })`，它不会写入指纹            |
| 有效期内能否复用 | 能。每条隧道的升级请求都带同一张；每次升级都重新读库确认会话未撤销、未过期（`verifyWebSocketToken`）                                                                                                                                                                                                                                                                                     |
| 刷新             | 渲染进程在剩余约 40% 时调 RPC 换新的，经 IPC 推给主进程；主进程在剩余不足 60 秒仍没收到新的时，发 `ticket-needed` 事件让渲染进程立刻换。这是一次性的定时器，没有轮询。过期期间新连接得到 401，卡片显示"正在重新连接"，换到票据后下一次加载恢复 **时钟：** 续期时机和交给主进程的到期时刻都按本机收票时刻算，寿命夹在 30 秒到 5 分钟，服务端时间给出的寿命 ≤ 0 时按 5 分钟（详见 §7.3）。 |
| 存放             | 只在主进程内存里；不写盘、不进 URL、不进渲染进程日志、不经 IPC 回传给任何页面                                                                                                                                                                                                                                                                                                            |

#### 签发时怎样不绑 DPoP（回答主控的提醒）

`authenticateWebSocketUpgrade` 里，**票据**带 `jkt`（`session.proofKeyThumbprint`）时才会要求每次使用都出示 DPoP 证明（`EnvironmentAuth.ts:1261`）；DPoP 绑定的**会话**本身并不让它签出的票据自动带 `jkt`。`EnvironmentAuth.issueWebSocketTicket`（`:1216`，条件在 `:1223`）只在 `input?.use === "rpc"` 时才把会话的指纹传给 `SessionStore.issueWebSocketToken`，所以经这个包装、用 `use: "loopback-gateway"` 签发的票据**不带 `jkt`**，即使会话是 DPoP 绑定的。我们的认证函数（§4.4）也从不要求 DPoP 证明：主进程没有私钥，这张票据是 bearer，仅在加密或本机的连接上使用（§4.6）。

「渲染进程为每次升级签一个 DPoP 证明」是将来要支持明文局域网时的方案，列在「以后再做的安全加固」。

#### 一个必须说明的后果：会话续期（N1）

DPoP 会话约每小时换成一个新的会话 id（设备会话 TTL 是 1 小时，`DeviceAssertionAuth.ts` 的 `SESSION_TTL`；续期由 `renewDpopBeforeExpiry` 触发，不替换旧会话）。`SessionStore.awaitInvalidation(sessionId, proofKeyThumbprint?)` 靠这个指纹把"旧会话到期但有继任会话"算作同一个连接（`latestSessionByProofKey`，`SessionStore.ts:711`；链式等待在 `:1082-1099`）。**不传指纹时，旧会话一到期它就返回**（`successorId === undefined`），隧道（包括 Vite 的 HMR WebSocket）每小时断一次；Vite 客户端在非正常断开后会轮询并 `location.reload()`，页面状态丢失。

而 `verifyWebSocketToken` 只会把票据 claims 里的 `jkt` 还给调用方，没有别的渠道知道会话的指纹。所以建议（N1）：**RPC 签发时把会话的指纹写进票据的 `jkt`，仅作续期链的键**。这和"不绑 jkt"在字面上不同，意图相同：

- 网关的认证函数**不**把它当作要出示 DPoP 证明的理由，也不去验证证明；票据仍是 bearer。
- 上游 `/ws` 和媒体路由对这张票据先在 audience 上被拒（`EnvironmentAuth.ts:1256` 在 `:1261` 的 DPoP 逻辑之前），所以带 `jkt` 的网关票据不可能在别处被当成要出示证明的票据，也不可能被当成 RPC 票据。测试覆盖：用这张票据去打 `/ws` 和一个媒体路由，必须得到 audience 拒绝。
- 签发方式相应是直接调用 `sessions.issueWebSocketToken(sessionId, { audience, proofKeyThumbprint })`，不经过 `issueWebSocketTicket` 包装。

这个取舍主控已接受（第三轮第 7 条），后果和测试见 §4.8「接受的取舍：续期链上的 bearer 延长」。备选（票据里完全没有 `jkt`，会话到期时隧道关闭，HMR WebSocket 每小时断一次）不采用。

### 4.3 票据放在哪里：`Authorization: T3X-Gateway <票据>`（N2），以及它怎样不进日志

#### 查证结果：现有认证有没有人会去解析 `Authorization`

我查了 server 里所有读这个头的地方：

| 位置                                                                      | 做什么                                                                                    | 对 `T3X-Gateway` 方案的影响 |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | --------------------------- |
| `auth/EnvironmentAuth.ts:632` `parseBearerToken`、`:641` `parseDpopToken` | 只认前缀 `Bearer ` 和 `DPoP `                                                             | 不匹配，返回 `null`         |
| `selectRequestCredential`（`:647`）                                       | 先 cookie，再 bearer，再 dpop                                                             | 方案不是这两种，不会被选中  |
| `resolveRequestCredential`（`:757`）                                      | `hasAuthorization` 只用来禁用 dev cookie 回退                                             | 只在会话认证路径里          |
| `auth/http.ts:62` `appendDpopChallengeOnUnauthorized`                     | 只看 `DPoP ` 前缀                                                                         | 不影响                      |
| `mcp/McpHttpServer.ts:208`                                                | 只在 `/mcp`                                                                               | 不在我们的路由上            |
| `httpCors.ts:6`                                                           | CORS 允许头清单                                                                           | 与非浏览器客户端无关        |
| 全局中间件（`AuthAttemptLimiter`、请求日志、`layerAuthenticatedAuth`）    | 没有任何一个对所有请求解析 `Authorization`；`layerAuthenticatedAuth` 只包住被它保护的路由 | 我们的路由不用它            |

所以**功能上没有冲突**：只要网关路由不调用 `authenticateRequest` / `authenticateWebSocketUpgrade`，`Authorization` 头就不会被会话认证碰到。用自定义方案名 `T3X-Gateway`（而不是 `Bearer`）进一步保证：即使将来有人让这条路由误落进 `authenticateRequest`，票据也不会被当作会话凭据。

**这是源码结论，不是实测。** 复核 P2-1 要求把它变成测试：9.1 的验收里，带 `Authorization: T3X-Gateway <有效票据>` 的请求依次打：一个受保护的普通路由、`/mcp`、OAuth 路由（`/oauth/token`）、`TunnelListener` 的监听口上的同样几条，逐条断言：不被当作会话凭据（得到的是各自"没有凭据"的响应，不是"凭据无效"以外的新行为）、**`AuthAttemptLimiter` 的计数不变**（网关路径不在它统计的路由里，`rejectedCodeStatus` 只对认证端点返回状态，`AuthAttemptLimiter.ts:151-175`；测试用连续多次错误票据打网关路由，断言限流器状态不变，网关不会因此把某个客户端锁在 `/oauth/token` 之外）。

#### 为什么用 `Authorization` 而不是自造请求头名

主控的默认是"专用请求头，不要用 `Authorization`，先查清再说"。查清之后用 `Authorization` 的自定义方案，理由只有一条：**没有任何解析器会把 `T3X-Gateway` 当会话凭据**（上表）。**不再把"默认遮蔽"当作理由或安全前提**（复核 P0-2）：Effect 和 Caddy 默认遮蔽 `Authorization` 是一层兜底，下面的显式脱敏才是机制。

代价和退路：中间设备如果对 `Authorization` 做特殊处理（企业代理剥掉、frp 的 `httpUser` 基本认证），请求会失败。我们的 frpc 配置没有 `httpUser`/`httpPassword`（`frpcConfig.ts`）；frp 与 Caddy 是否原样保留，9.4 实测（§3.5）：自建隧道这条路径已经证明会原样保留，场景 15 的隧道和场景 16 的升级都靠 `Authorization: T3X-Gateway` 经 Caddy 和 frps 到达 B 并通过认证（其余连接方式仍待测）。若发现问题，退路是自造头 `X-T3x-Gateway-Ticket`，并把这个名字追加进下面第 3 条的遮蔽名单和 Caddyfile——实现里头名是一个常量，改动一处。

#### 显式脱敏：票据永远不以明文离开入口函数

泄露渠道：console 日志、OTLP 日志、trace 落盘（`LocalFileSpan`）、OTLP trace、span 属性和事件、错误诊断（`ServerAuthInvalidCredentialError.diagnostic`）、`--log-ws-events` 打开时 HTTP 错误里携带的请求 URL（`serverLogger.ts:14` 的注释）、Caddy 和 frps、A 端主进程日志。机制：

1. **入口立刻包成 `Redacted`。** 路由处理函数第一步读 `Authorization`，解析出票据，**马上** `Redacted.make(ticket)`，并且不再保留原始头字符串；之后传递的只有 `Redacted<string>`（打印为 `<redacted>`）。只在调用 `sessions.verifyWebSocketToken` 的一处解开。
2. **任何错误对象、诊断、span 属性都不带请求头、请求对象或原始票据。** 路由的错误类型只有固定字段（`code`、`reason`），诊断只写固定短语（"gateway ticket rejected: audience"）；不把 `HttpServerRequest` 或 `request.headers` 放进错误、日志注解或 span 注解；路由里用 `Effect.annotateCurrentSpan` 只写白名单键（`gateway.port`、`gateway.outcome`），不写会话 id 之外的任何凭据相关值。处理函数里的缺陷（`die`）也不会带出请求：`catchCause` 把缺陷映射成固定的 `500 { code: "internal" }`，原因只记录在日志里，且日志内容经过 §3 的同一条规则。
3. **票据不在 URL 里**，所以 `serverLogger.ts` 里"请求 URL 带连接票据"的问题（P0-2 的根因）对这条路由不存在。query 里出现 `wsTicket` 直接 `400 { code: "ticket-in-url" }`，**不读它**，也不把它当票据。上游已经遮蔽了 query 里的 `wsTicket`（`httpObservability.ts` 的 `UrlParams.CurrentRedactedNames`，以及 `observability.ts:408` 对 cause 文本的正则），这是兜底。
4. **兜底层（不是前提）的依据，可引用：**
   - Effect 4.1.2 `.repos/effect/packages/effect/src/http/Headers.ts:445-453`：`Headers.CurrentRedactedNames` 的默认值含 `authorization`、`cookie`、`set-cookie`、`x-api-key`；同文件 `:438` 写明"自定义名单替换默认值"。
   - `.repos/effect/packages/effect/src/http/HttpMiddleware.ts:204-209`：`TracerHeaderFilter` 默认 `constFalse`，请求头不进 span（文档 `:197` "Header capture is opt-in"）；`:321-350` 的 span 收尾处（`:345`、`:350`）只在 filter 通过时才写头，并按 `CurrentRedactedNames` 遮蔽。
   - **server 自己有没有覆盖：** `apps/server/src/observability/Observability.ts:37` 装的是 `HttpObservability.layer`（`packages/shared/src/httpObservability.ts:8-12`），它是**追加**（`[...names, "dpop", "expo-session"]`），没有替换；grep `apps/server/src` 和 `packages/shared/src`，没有任何地方设置 `HttpMiddleware.TracerHeaderFilter`，`HttpMiddleware.TracerDisabledWhen` 只在 `apps/server/src/http.ts:392` 用于若干带令牌的路径。fork 的层（如果要给自造头名加遮蔽）同样只能追加。
5. **A 端主进程：** 隧道客户端的日志和错误不含请求头；`ws` 的错误只带状态码和 URL（URL 不含票据）；票据只放 `Redacted`。

**验收（9.1、9.2）：**

- **sink 全覆盖测试：** 收集 logger（console、文件、OTLP 的 `Logger` 实例）和 tracer（本地文件 tracer 加一个捕获全部 span 属性、事件、错误 cause 的测试 tracer）的**全部输出**，走完整个请求周期，断言找不到哨兵票据，也找不到它的任何长度 ≥ 12 的子串。路径至少包括：成功；坏票据（篡改）；过期；已撤销；错 audience（无 audience、`rpc`、`media`）；错方案（`Bearer`）；缺 scope；端口被拒（`not-owned`、`reserved`、`debug-process`）；核对失败（`owner-changed`）；拨号失败（`upstream-refused`）；隧道中途断开；撤销导致断开；处理器内部抛出缺陷。`--log-ws-events` 打开和关闭各跑一遍。
- **守卫测试（真实 server 层）：** 在真实 server 层的上下文里读 `Headers.CurrentRedactedNames`，断言含 `authorization`；断言 `HttpMiddleware.TracerHeaderFilter` 对 `authorization`（请求和响应两个阶段）返回 `false`；再加一个静态扫描测试，断言 `apps/server/src`、`packages/shared/src` 里对 `Headers.CurrentRedactedNames` 和 `TracerHeaderFilter` 的赋值点只有已知的几处（现在：`httpObservability.ts` 的追加）——新增覆盖点会让测试失败，直到有人确认它没有丢掉 `authorization`。
- `Headers.redact` 对 `authorization` 返回被遮蔽的值。
- **Caddy 与 frps（9.4，逐项实测后才能把 P0-2 标为解决）。已实测通过（`fork:selfhost:e2e` 场景 16，2026-11-07）：** `Caddyfile`、`Caddyfile.test` 和 ntfy 片段里没有 `log`、`log_credentials`；在运行中的 Caddy 里临时加载带访问日志的配置，真票据和哨兵票据各发一次经 Caddy 和 frps 的隧道升级，访问日志里 `Authorization` 是 `REDACTED`，Caddy、frps、registry 的全部输出里找不到两个票据（哨兵票据每一段都是独立随机内容，整串的每个 12 字符窗口都查；真票据同样查每个 12 字符窗口，只排除同一会话、同一时刻再签的另一张票据里也出现的窗口：票据的固定前缀和键名、会话 id、密钥指纹、时间戳的前几位。这些是同一会话的所有票据共有的，访问日志里 `/ws?wsTicket=` 那张就带着它们，不是这张票据能被用的原因；含唯一数字或签名任何一部分的窗口一律检查。真票据只露出这些共有部分的泄漏查不出来）；加上 `log_credentials` 场景会失败，往日志里伪造一行只含 claims 片段的内容场景也会失败（2026-11-07 复核后改成查全部窗口，之前只查签名段）。frps 以 info 级别运行，没有打印任何请求头。

### 4.4 网关路由的认证函数 `authenticateGatewayTicket`

fork 自己的函数，不调用 `authenticateWebSocketUpgrade`（P0-1 的根因：那个函数只在 `session.audience !== undefined && session.audience !== use` 时拒绝，没有 audience 的票据能过）。步骤，任何一步失败都不再往下：

1. query 里有 `wsTicket` → 400（不读）。
2. 请求带 `Origin` → 403（浏览器一定带，我们的客户端不带；网页不可能直接用这个端点）。
3. 读 `Authorization`：必须恰好一个值，方案恰好是 `T3X-Gateway`，票据长度 ≤ 2048。`Bearer`、`DPoP`、cookie、缺失 → 401，且这些凭据**被忽略**。
4. `sessions.verifyWebSocketToken(token)`，错误按上游同样的映射。
5. 拒绝 MCP 客户端主体（保留上游 `rejectMcpClientAudience` 的行为：`subject === "mcp-client"` → 拒绝）。该函数和常量 `MCP_CLIENT_SUBJECT`（`EnvironmentAuth.ts:77`）在上游文件里都不是导出的，fork 里用 3 行重写并写死同一个字面量，测试里用真实的 MCP 客户端会话（`issueMcpClientSession`）断言被拒，这样上游改了常量测试会失败。
6. **严格 audience：** `session.audience === "loopback-gateway"`。`undefined`（旧的/通用的 `wsTicket`）、`"rpc"`、`"media"`、其他任何值一律拒绝。
7. 两个 scope 都在 `session.scopes` 里。
8. 带 `jkt` 不是拒绝理由（N1），也不验证任何证明。

`/ws` 和媒体路由的行为不变：它们仍然接受没有 audience 的票据（兼容旧客户端）。

**测试（路由层，真实 server 层加真实 `ws` 客户端）：** 没有 audience 的票据（用 `SessionStore.issueWebSocketToken(sid)` 不带 audience 签发）、`rpc`、`media`、篡改、过期、已撤销会话、MCP 客户端会话、缺 scope、`Bearer <票据>`、`Bearer <有效会话令牌>`、`DPoP <…>`、cookie、query 里的 `wsTicket`（400）、带 `Origin`（403）：全部被拒。反向：网关票据去打 `/ws` 和一个媒体路由，被 audience 拒绝；没有 audience 的票据仍能打 `/ws`（回归保护）。

### 4.5 权限：两个 scope 都要

默认要求 `preview:operate` **和** `terminal:operate`。理由：

1. 被转发的是终端和 agent 起的进程。网关给页面的能力是"以用户身份访问 B 上这些进程的网络接口"。这些接口常常没有认证（调试端点、管理界面、带副作用的开发 API），与在终端里运行命令的权限等价。上游已有先例：`previewStopLocalServer`（对列出的服务发信号）要求 `terminal:operate`（`CLIENT_GUARDED_RPC_SCOPES`）。
2. 只要 `preview:operate`，一个只能操作预览、不能操作终端的会话（例如以后给访客或 MCP 客户端的受限会话）就能借网关碰到终端里起的服务，这比它本来的权限大。
3. 我们自建连接的电脑会话和手机会话两项都有（`DeviceAssertionAuth.ts` 的 `scopesForDevice`：电脑是 `AuthStandardClientScopes`，手机只去掉 `access:write` 和 `relay:write`）；只读会话两项都没有。所以对实际用户没有额外限制。

实现：

- RPC 方法放进 `CLIENT_GUARDED_RPC_SCOPES`（用 fork 的展开 `FORK_LOOPBACK_GATEWAY_GUARDED_RPC_SCOPES`，值写 `preview:operate`，让 `permissionAtom` 可用）。`CLIENT_GUARDED_RPC_SCOPES` 每个方法只能写一个 scope，所以在 `clientRpcRequiredScopes` 里为这个方法加一条分支返回 `[preview:operate, terminal:operate]`（该函数本来就返回数组，`RpcAuthorization.ts:279` 对数组全部强制）。上游 4 行。
- 隧道路由自己检查两个 scope（§4.4 第 7 步），因为它不走 RPC 授权层。
- 按 AGENTS.md 的要求，在权限行为测试里加这个方法。

### 4.6 只在加密或本机的连接上启用（主控 Q1，已定；N3，已定）

票据是 bearer、不绑 DPoP，所以只在票据不会被同网段嗅探的链路上使用。判定是**一个纯函数**，放在 `packages/shared/src/forkLoopbackGateway/transport.ts`，web 的状态机和桌面主进程共用；主进程在开隧道前自己再调用一次（渲染进程说"启用"也不够）。

**Tailscale 的判定直接调用上游的 `isTailnetHost`**（`packages/shared/src/hostClassification.ts:83`，上游注释："MagicDNS or fd7a:115c:a1e0::/48 identifies Tailscale; shared 100.64.0.0/10 addresses alone do not."）：只认 `*.ts.net`（后缀匹配，经 `normalizeHostname` 去掉方括号和尾点）和 `fd7a:115c:a1e0::/48`。**不单独认 `100.64.0.0/10`**，我们不另写一份范围判定。回环的判定在 fork 的同一个文件里（`localhost` 含尾点、`*.localhost`、`127.0.0.0/8`、`::1`、`::ffff:127.x`，比上游的 `isLocalLoopbackHost` 宽，因为要和 Chromium 的回环集合一致）。

输入：环境的 `httpBaseUrl`（`readPreparedConnection(envId).httpBaseUrl`，即**实际会用的那条路由**）。输出：`{ ok: true, via: "tls" | "loopback" | "tailnet" }` 或 `{ ok: false, reason: "insecure-transport" | "invalid-url", hint?: "tailscale-address" }`。隧道的 scheme 由此推出：`https:` → `wss:`，`http:` → `ws:`。`hint: "tailscale-address"` 在 host 是 IPv4 的 `100.64.0.0/10`（上游的 `isSharedAddressSpaceHost`）时给出，只用来让错误卡片提示"改用 MagicDNS 名字或 HTTPS"，不影响判定。

| `httpBaseUrl`                                                                                                                                                                                 | 结果                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `https://x.t3.example.com`、`https://192.168.1.5:3873`、`https://[2001:db8::1]`                                                                                                               | `tls`（任何 https；证书是否可信由 TLS 栈校验，§3.6，通过检查不等于连接安全）                           |
| `http://127.0.0.1:3999`、`http://localhost:3999`、`http://LOCALHOST.:3999`、`http://app.localhost:3999`、`http://127.255.255.254:3999`、`http://[::1]:3999`、`http://[::ffff:127.0.0.1]:3999` | `loopback`（含 SSH 转发端口和本机）                                                                    |
| `http://mac.tail1234.ts.net:3873`、`http://MAC.TAIL1234.TS.NET.:3873`                                                                                                                         | `tailnet`                                                                                              |
| `http://[fd7a:115c:a1e0::1234]:3873`、`http://[fd7a:115c:a1e0:ffff::1]`                                                                                                                       | `tailnet`                                                                                              |
| `http://[fd7a:115c:a1e1::1]`、`http://[fd7a:115c:a1df::1]`                                                                                                                                    | `insecure-transport`（`/48` 之外）                                                                     |
| `http://100.64.0.1`、`http://100.101.102.103:3873`、`http://100.127.255.255`                                                                                                                  | **`insecure-transport`，`hint: "tailscale-address"`**（`100.64.0.0/10` 不单独认作 Tailscale，主控 N3） |
| `http://100.63.255.255`、`http://100.128.0.1`                                                                                                                                                 | `insecure-transport`（范围外，没有 hint）                                                              |
| `http://evil.ts.net.example.com`、`http://ts.net`、`http://notts.net`、`http://ts.net.evil.com`                                                                                               | `insecure-transport`（必须是 `.ts.net` 后缀的子域）                                                    |
| `http://192.168.1.10:3873`、`http://10.0.0.5`、`http://172.16.0.1`、`http://169.254.1.1`                                                                                                      | `insecure-transport`                                                                                   |
| `http://mac-mini:3873`、`http://mac-mini.local:3873`、`http://home.arpa`                                                                                                                      | `insecure-transport`（局域网名字）                                                                     |
| `http://example.com`、`http://127.0.0.1.evil.com`、`http://localhost@evil.com`                                                                                                                | `insecure-transport`（按真正的 host 判定）                                                             |
| `http://0.0.0.0:3999`、`http://[::]:3999`                                                                                                                                                     | `insecure-transport`（不是回环）                                                                       |
| `ftp://x`、`not a url`、空字符串                                                                                                                                                              | `invalid-url`                                                                                          |

规则写在一处，其余各处（状态机 §8、错误卡片 §7.2、主进程 §3.2、表格测试、文案）都从这张表和这一个函数推出，不各写一份：测试是这张表的逐行表格测试，再加一组随机化性质测试（任何 `https:` 一定 `tls`；任何 `http:` 且 host 不在三类里一定不通过；**任何 `http:` 且 host 是 IPv4 `100.64.0.0/10` 的一定不通过**；`tailnet` 的结果一定满足 `isTailnetHost`）。

明文局域网和明文 `100.x` 的状态是 `unsupported-route`，原因 `insecure-transport`：走现有行为（私网改写成环境 IP，公网回退），错误卡片说明原因并提供「在 {environment} 的浏览器中打开」（§7.2）；`hint` 存在时卡片多一句"这看起来是 Tailscale 的 IP 地址，请改用它的 MagicDNS 名字（`*.ts.net`）或 HTTPS"。

### 4.7 A 端代理的认证与 `login` 处理

主进程代理只绑 `127.0.0.1`，但同一台电脑上的任何进程（包括同机其他用户）都能连这个端口。所以：

**口令**

- 每个环境、每次应用启动一个随机 256 位口令，用户名固定为 `t3x`，用常量时间比较。
- **只在主进程内存里**：不进任何 URL（不用 `http://user:pass@…` 形式的代理地址）、不进日志、不经 IPC 发给渲染进程（渲染进程拿不到口令，也拿不到代理的端口：它只传"启用/停用"和票据）、不写盘。
- 没有口令的连接只能得到 `407` 或被销毁，永远到不了 B（上限见 §3.7）。

**`app.on("login")` 的处理：四条同时满足才回应**

1. `authInfo.isProxy === true`；
2. `authInfo.host` **精确等于** `127.0.0.1`；
3. `authInfo.port` **精确等于**该环境代理的端口；
4. 有 `webContents` 时，它的 session 属于该环境已登记的 session（`partition → environmentId` 登记表）；**没有 `webContents` 时（Service Worker、`session.fetch`、下载发出的请求）这一条不查**，由第 3 条的端口认出是哪个环境。

满足才调用 `event.preventDefault()` 和 `callback("t3x", 口令)`，并且只对自己的请求这样做。不满足的一律不动：不 `preventDefault`、不调用 `callback`，让 Electron 的默认行为和其他处理器照常运行。这样口令不会交给用户的系统代理、其他本机代理、页面自己的 HTTP 认证框（`isProxy === false`）、或另一个环境的代理（端口、session 都不对）。

没有 `webContents` 也回应的理由：`login` 事件只会由本 app 的 Chromium 为本 app 自己的请求发出，本机别的进程触发不了；host 和 port 又保证质询来自我们自己的代理（每个环境的端口独有），口令也只会送回那个代理，所以不需要靠 session 再确认一遍。要求 session 反而会让这类请求在认证缓存为空时（刚重启、全新分区）拿到 407。

**与现有处理的共存：** `apps/desktop/src` 里目前没有任何 `app.on("login")`、`session.on("login")`、`select-client-certificate` 或 `certificate-error` 处理（我 grep 过）；没有处理器时 Electron 对代理认证的默认行为是取消。所以我们的处理器是增量，不改变任何现有行为。将来上游若加自己的处理器，我们的条件保证互不干扰，测试里放一个假的上游处理器（只处理 `isProxy === false` 的页面认证）与我们的并存，两边各自生效。

**测试：** 错误的 host（`localhost`、`::1`、另一个 IP）、错误的 port、`isProxy === false`、不在登记表里的 session、已登记但属于另一个环境的 session：都不回应；正确组合回应且口令正确；与假的上游处理器并存。

**代理层自己的限制：** §3.7 的 A 端三行。验收：另起一个本机客户端（Node `net`），不带口令连代理，只能得到 407，B 端（用假隧道工厂计数）收到 0 次开隧道请求；带错误口令同样；大量并发未认证连接被限流。

**Chromium 的限制，不能用更强的本机隔离：** Chromium 的代理不支持 Unix 域套接字或命名管道（`--proxy-server` 只接受 TCP 上的 http、https、socks4、socks5），所以"绑 Unix socket 或校验对端凭据"这类 GPT 建议的增强项在这条路上做不了。口令加 `127.0.0.1` 绑定加限流就是这条路能做到的。同机其他用户可以连端口、猜不出口令。同一用户下的恶意进程能读主进程内存，不在本设计的防护范围。

### 4.8 撤销链

复用 8.2 的机制（`research/self-host-device-keys.md` §3.8）。三条路径都必须**用真实 server 层和真实 `ws` 客户端**测，每一条都验证已建立隧道的**两端**（B 到开发服务器的 TCP 连接、A 端的 WebSocket）都关闭，而不是只验证新升级得到 401：

| 路径                                                                                                         | 机制                                                                                                                                      | 测试                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 会话被撤销（Sharing & access 里撤销、`./t3x revoke`）                                                        | `SessionStore.revoke` 总会发布 `clientRemoved`；每条隧道的 `awaitInvalidation` 醒来读到 `revokedAt` 返回                                  | 建立隧道，撤销，等 `Deferred`（"B 端 TCP 已销毁"和"WS 已收到关闭帧"），断言之后没有字节再被转发；新升级得到 401                              |
| 会话自然过期                                                                                                 | `awaitInvalidation` 按 `expiresAt` 睡眠到期；无继任会话（或 N1 的链上没有继任）就返回                                                     | 路由层用 `TestClock` 加一对假套接字；再加一个 `it.live`，会话 TTL 取 1 秒，等事件，不 sleep                                                  |
| 设备移除后经 8.2 对账撤销（`DeviceDirectory` 里 `sessions.revoke(row.sessionId)`，`DeviceDirectory.ts:242`） | 对账撤销 `t3x-device:*` 会话，发布 `clientRemoved`；FORK.md 记载其他电脑和手机的会话在各自下一次同步时撤销、已建立的连接约 20–30 秒内断开 | 用 8.2 已有的 `registryFake.testkit.ts` / `deviceHarness.testkit.ts`：建立设备会话的隧道，从清单里移除该设备，触发同步，等事件，断言两端关闭 |
| 续期（N1）                                                                                                   | DPoP 会话续期产生继任会话，`awaitInvalidation` 沿链继续等                                                                                 | 签发继任会话，旧会话到期后隧道仍然活着；撤销继任会话后隧道关闭                                                                               |

**升级与撤销同时发生的竞速**（都要有测试）：

1. 票据已验证通过，撤销发生在拨号之前：先启动 `awaitInvalidation`，再拨号（§3.3 第 4 步），所以撤销得到的结果是"放弃拨号、不接受升级"，不会留下一条没人管的隧道。
2. 撤销发生在拨号期间：拨号被中断，TCP 连接被销毁。
3. 撤销发生在 WS 升级响应写出之后、第一个数据帧之前：隧道在转发任何字节前关闭。
4. 撤销发生在数据正在流动时：关闭之后不再转发字节（计数断言）。

#### 接受的取舍：续期链上的 bearer 延长（N1，已定）

N1 的做法有一个必须写明的后果（GPT 复核 P1-5）：

- `SessionStore.awaitInvalidation`（`SessionStore.ts:1043-1105`）按票据 claims 里的 `jkt`（会话的 `proofKeyThumbprint`）沿 `latestSessionByProofKey` 追到继任会话；这个索引只由**服务端签发**的 DPoP 会话建立，票据的 claims 由服务端签名、不可篡改，所以伪造 `jkt` 挂不到别人的会话链上。但票据持有者**不需要再证明**自己持有这个 `jkt` 对应的私钥（这条路由是 bearer）。
- 所以：偷来的网关票据只有在 5 分钟有效期内才能开隧道；开出的隧道会随续期链一直活下去。**最多活到这台设备的会话链结束（设备不再续期、最后一个会话到期）或被撤销为止。** 这是明确接受的 bearer 延长。它的范围受限于：只能开隧道（不能调 RPC、不能读文件、不能用终端），端口许可、现场核对、排除清单、并发和速率上限照常约束，只在加密或本机的连接上使用（§4.6）。
- 撤销链上**任一**会话行都会让正在等待的隧道结束。设备移除要做到的是：8.2 的对账 `reconcile` 对移除设备的**所有活动会话行**调用 `sessions.revoke`（`DeviceDirectory.ts:230-242` 用 `sessions.listActive()` 过滤出这些行，逐行撤销，且每次同步都跑，幂等），不是只撤销最新一行。

三个新增测试（真实 server 层 + 真实 `ws` 客户端，两端都验证，沿用上面的 harness）：

1. **续期期间被盗的票据开出的隧道，撤销后关闭。** 设备会话 S1（DPoP，带 `jkt`）签发网关票据 T；用 T 从"攻击者"的客户端开一条隧道；S1 到期并由 S2 续期；隧道仍然活着；撤销 S2：隧道的 TCP 和 WS 两端都关闭，用 T 的新升级被拒。再来一遍撤销的是 S1（旧行）而不是 S2：等待中的隧道同样结束。
2. **撤销和升级同时发生，在续期链上。** S1 已到期、S2 是活动行：撤销 S2 与一次用 T 的升级同时发生，结果只能是"升级被拒"或"隧道建立后立即关闭"，不能留下一条没人管的隧道（先启动 `awaitInvalidation` 再拨号，§3.3 第 4 步）。
3. **移除设备后，整条会话链上的每一行都被撤销，对应的隧道都关闭。** 设备有三行会话（已到期的一行、活动的两行），每个活动行各开隧道；从清单移除该设备并触发对账；断言**每个活动行**的 `revokedAt` 非空（读库），所有隧道两端关闭；再同步一次不出错（幂等）。

**顺序测试要保留：** `EnvironmentAuth.ts:1256`（audience 检查）先于 `:1261`（DPoP 分支）。带 `jkt` 的网关票据去打 `/ws` 和媒体路由，必须得到 audience 拒绝，而不是被要求出示 DPoP 证明；上游改动这个顺序时这条测试会失败。

### 4.9 重放与限速

- 票据是 bearer，窃取者在剩余有效期内可以开隧道，但仍受端口许可、复核、排除清单、并发上限、速率上限、撤销约束，**不能**调用 RPC（RPC 需要 DPoP）、不能读文件、不能用终端。只在加密或本机的连接上使用（§4.6），所以同网段嗅探不构成风险。
- 隧道升级失败（401/403/404/429 等）不进 `AuthAttemptLimiter`：它只统计认证端点（`rejectedCodeStatus`，`AuthAttemptLimiter.ts:151-175`），网关路径不在其中，票据是 256 位 HMAC，暴力猜测没有意义，不为它改上游文件。**这一条由测试保证，不靠推断**（§4.3 末尾的中间件测试：连续多次错误票据打网关路由，断言限流器状态不变）。
- 浏览器不能直接用这个端点：必须带 `Authorization` 自定义方案（浏览器的 `WebSocket` API 设置不了任意请求头），且带 `Origin` 就拒绝。

## 5. 端口许可

### 5.1 "T3 终端和 agent 起的服务"的精确定义

照 `apps/server/src/preview/PortScanner.ts` 的实现。一个端口"有主"（`isOwned`），当且仅当扫描结果里它的 `terminal !== null` 或 `agent != null`：

- **终端有主**：监听该端口的进程 PID 属于某个 T3 终端的进程集合。集合由 `terminal/Manager.ts` 的 `subprocessInspector` 产生（终端 shell 的 PID 加它的全部后代，`Manager.ts:755-770`），经 `registerTerminalProcesses` 登记。
- **agent 有主**：监听进程的启动环境里有 `T3CODE_THREAD_ID=<线程>`（`AGENT_THREAD_ENV`）。macOS 用 `ps -E`，Linux 读 `/proc/<pid>/environ`；agent 起的任何作业都继承这个变量，所以 agent 退出后留下的服务仍算。Windows 没有这一档（`hostPlatform !== "win32"`），本来就只有终端有主；网关不支持 Windows 的 B（§5.6.5）。**只有 Claude 和 Codex 会设置这个变量**（§5.6.2），所以"agent 起的服务"这一档只对这两家出现；其他 provider 的 agent 起的服务，只有在 T3 终端里起的才有主。
- 同一端口上有 IPv4 和 IPv6 两个监听，其中一个无主 → 整个端口当无主（`parseLsofOutput` 的合并规则）。

不属于"有主"的（网关一律拒绝）：用户自己的终端之外起的数据库、Docker 发布的端口、其他应用、IDE 的服务。

归属判断不是安全边界对抗本机恶意进程：任何能在 B 上跑代码的人本来就越过了这条线（环境变量和 argv 都能伪造，`parsePsEnvironmentThreads` 的注释也写明了）。它的作用是**别把用户 B 上无关的服务暴露给标签页里的页面**。

### 5.2 Preview URL 配置项：不算（建议）

`PortScanner` 对项目脚本配置的 Preview URL 做两件事：对它发一次 HTTP GET 探测（`probeWebServers`，只在订阅者传了配置 URL 时发生；用户文档 Local servers 一节也分开写了：列出的端口不连接，Preview URL 会被检查），探测为网页就列出，**不要求有主**（`configured` 分支）。

建议网关**不**把"配置过 Preview URL"当作许可：

- Preview URL 存在项目脚本里。如果 agent 能通过 MCP 的项目更新工具改项目脚本（我没有核实），一条配置就能把 B 上任意回环端口开放给页面。
- 实际使用里，配了 Preview URL 的服务几乎总是脚本自己起的（用户点"运行"→ 在 T3 终端里跑 → 有主），本来就已经许可。
- 没有主的 Preview URL（服务是在别处起的）走错误页，提供"在 B 的浏览器中打开"。

这是 Q2。如果主控要求算，改法很小（许可检查多读一个集合），但需要把"谁能改项目脚本"这条权限路径核实一遍。

### 5.3 连接时怎样核对：快照提名 + 每条隧道的现场核对（无缓存）

端口发现有两档节奏：面板打开时 3 秒（live），只有后台订阅时至少间隔 15 秒（`BACKGROUND_POLL_INTERVAL_MS`）。**只用快照会有 TOCTOU（GPT P1-1）**：T3 的服务退出后，别的无主进程可以在快照窗口里抢占同一端口，网关还会拨给它，直接违反"其他程序打不开"。第二版加了拨号前的按 PID 复核，但允许同一 (端口, pid) 的结果缓存 2 秒；复核指出这只是把窗口从 15 秒缩到 2 秒，不是堵住（owner 交换仍可发生在缓存期内）。**主控第三轮第 3 条：去掉缓存，每条新隧道都现场核对一次。**

```
authorize(port)                // 每条新隧道都完整走一遍；结果不缓存，不跨隧道复用
  A 提名     servers = PortDiscovery.scanBackground()      // 上次扫描不到 15 秒就直接用，不起新扫描
             找 port 对应的项 → 候选 (pid, 类别 terminal | agent)；快照只用来提名
             找不到或无主：距上次"未命中重扫"不到 2 秒 → 跳到下一步
                           否则 scan() 一次（复用 scanSemaphore，同时到达的合并），再找
             仍没有：读这个端口的监听者（`inspector.listeners`，每台 server 每 2 秒一次，同端口共用；
                     间隔内别的端口不再读，读取失败同样处理）
                       一个都没有 → 拒绝 upstream-refused
                       恰好一个 pid → 作为候选进入 C（读取只提名，不放行）
                       多个 pid，或没读到 → 拒绝 not-owned
                     原因：扫描器的快照只收有主的服务，而终端子进程要等 Manager 每秒一次的检查登记后才算
                     有主，刚在终端里起的服务在这段时间（机器忙时可达好几秒）不在快照里，不读就会被拒
                     一次，约 10 秒后重载才通。C2 本来就沿祖先链现读，不依赖扫描器的登记，所以提名不到
                     时让读取来提名是安全的
             读取提名的候选和快照提名的一样走 C，被拒时原因原样返回（reserved / debug-process /
             not-owned 都是 C 里的真实判定），不改写。曾把读取提名的这三种都改成 not-owned，理由是
             不想借此泄露排除规则；但 §6.6 已接受同类侧信道（能用网关的会话一定有 terminal:operate，
             自己开终端跑 ps、lsof 就能看到进程的参数和端口），改写不保护任何东西，反而让终端里刚起的
             `--inspect=0` 服务第一次打开时被告知"不是 T3 起的"，重载后才变成"带调试参数"
  B 静态排除 登记端口（主口、隧道口、…）∪ 屏蔽表 → reserved；pid 是本 server → reserved（祖先在 C2 用现读的进程表判）
  C 现场核对 verify(pid, port)
     C0 身份₁   读 (pid, 启动时间)。读不到（进程已不在）→ owner-changed
     C1 监听    pid 在这个端口上 LISTEN；读出绑定地址（127.0.0.1 / ::1 / 通配）；
                同一端口上不止一个 pid → owner-changed（SO_REUSEPORT）
     C2 归属    不信快照里的类别，对当前这个进程实例重新证明"有主"：
                  终端：祖先链（现读）到达一个正在运行的终端 shell（或它自己就是这个 shell）
                  agent：现读这个 pid 的启动环境，仍有 T3CODE_THREAD_ID
                再套排除规则 E1–E7（§5.6）和调试参数（§5.7）
     C3 身份₂   再读 (pid, 启动时间)，必须等于身份₁，并确认仍在 LISTEN（同一个套接字：Linux 比较 inode）
     任何一步读不出来、不一致、或工具失败 → 拒绝（owner-changed 或 verify-failed），并触发限流重扫
  D 拨号     只拨 C1 得到的那个地址（通配 → 127.0.0.1）；不解析任何名字
```

#### 与主控第 3 条的关系（一处细节上的调整，需要说明）

第 3 条的原话是"确认当前监听这个端口和地址的，就是快照判为有主的那一个进程实例，也就是 PID 和进程启动时间都一致"。照字面做要在**快照里**有启动时间。`PortScanner` 的快照没有（`DiscoveredLocalServer` 只有 pid、进程名、归属），而且上游的 agent 归属缓存按 pid 存（`PortScanner.ts:492-545` 的 `agentThreadsRef`："A process keeps its launch environment, so a pid is read once while it listens"），pid 被复用时快照里的归属可能是旧进程的。要在快照里记启动时间就得改 `PortScanner`（约 +15 行上游），与 N4（不改 `PortScanner` 的记录）冲突。

所以我这样实现，**结论比字面要求更强，不依赖快照里的归属**：快照只负责提名候选 `(port, pid)`；C2 对**当前**这个进程实例重新证明有主；C0 和 C3 两次读 (pid, 启动时间) 保证 C1、C2 读到的是同一个实例。pid 被复用时，新进程得自己证明有主，不能沿用旧进程的快照归属。有一处行为上的差别：终端有主从"上次轮询时在终端进程集合里"变成"现在祖先链能到终端 shell"，所以脱离终端后被 init 收养的进程（`setsid` 加守护化）不再被转发——`PortScanner` 自己下一次轮询也会把它们从集合里去掉，只是现在更早。**如果主控仍要和快照比启动时间：** 在 `PortScanner` 内部记录（约 +15 行，不进 contracts），启用条件是 9.1 的关口发现某个平台上现场证明做不到；预算 §13 有余量。

#### 各平台怎么取进程身份、监听和归属

| 平台    | 身份（pid + 启动时间）                                                                                                                                                                                                                  | C1 监听核对                                                                                                                                                                                                     | C2 归属                                                                                                                                                                                                | 状态                                                                                             |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| macOS   | `LC_ALL=C TZ=UTC /bin/ps -ww -o pid=,ppid=,pgid=,stat=,lstart=,args= -p <pid>`，启动时间取 `lstart` 文本（精度 1 秒）。这是上游 `OpenCodeServerLedger.ts` 已有的做法（`psDarwin`、`DARWIN_PS_LINE`），fork 里照抄约 30 行，不依赖它导出 | `lsof -a -p <pid> -iTCP:<port> -sTCP:LISTEN -P -n -F pn`。`n127.0.0.1:<port>`、`n[::1]:<port>`、`n*:<port>`；pid 不对时输出为空、退出码 1                                                                       | 祖先链：一次 `ps -A -o pid=,ppid=,pgid=,lstart=`（进程表带启动时间，同一时刻的快照）；agent 环境：`ps -E -ww -o command= -p <pid>`，在整行里找 `T3CODE_THREAD_ID=`（沿用 `parsePsEnvironmentThreads`） | `lsof -a -p` 和 `ps -E` 已在本机实测（附录 A），`lstart` 同上游用法；**组合调用在 9.1 关口核实** |
| Linux   | 读 `/proc/<pid>/stat`，在最后一个 `)` 之后按空白切，下标 19 是 `starttime`（开机后的时钟节拍数）；这也是 `OpenCodeServerLedger.ts` 的 `observeLinux` 的做法                                                                             | 读 `/proc/<pid>/fd/*` 的符号链接，取 `socket:[inode]`；在 `/proc/net/tcp`、`/proc/net/tcp6` 里找状态 `0A`（LISTEN）、inode 和端口都匹配的行，本地地址即绑定地址。只读这一个 pid 的 fd（设上限），不遍历 `/proc` | 祖先链：沿 `/proc/<pid>/stat` 的 ppid 一路走（每一级同时读 `starttime`）；agent 环境：`/proc/<pid>/environ`；argv：`/proc/<pid>/cmdline`                                                               | 未实测（本机是 macOS）。**在 Linux 容器里的真实进程测试通过之前，Linux 的 B 不广告能力**         |
| Windows | —                                                                                                                                                                                                                                       | —                                                                                                                                                                                                               | —                                                                                                                                                                                                      | **不支持，B 不广告 `loopbackGateway`**（主控 N6，§8）                                            |

**终端归属的"正在运行的终端 shell"从哪来：** `TerminalManager` 的 `subscribeMetadata`（`terminal/Manager.ts`，摘要里有 `pid` 和 `status`；`session.pid` 在进程退出时置空）。fork 里一个小的 `TerminalShellRegistry` 订阅它，事件驱动、不轮询，维护"当前正在运行的终端 shell 的 pid 集合"。9.1 关口核实 `subscribeMetadata` 覆盖了 shell 退出、终端重启和关闭这几种事件（不覆盖的话回退到快照里的终端进程集合，并把这个回退当作未决项，见 §5.6.0）。

#### 成本，以及批量核对（9.1 修复轮）

**单次核对的耗时分解（macOS，本机空闲时单次调用的中位数，`/tmp/t3x-p91/breakdown.txt`）：**

| 读取                                | 调用                                      | 耗时                         |
| ----------------------------------- | ----------------------------------------- | ---------------------------- |
| C0 进程表                           | `ps -A -ww -o pid=,ppid=,lstart=,args=`   | 47 毫秒                      |
| C1 监听者                           | `lsof -nP -iTCP:<端口> -sTCP:LISTEN`      | 119 毫秒                     |
| 同上，不带端口过滤（全部 TCP 监听） | `lsof -nP -iTCP -sTCP:LISTEN`             | 120 毫秒                     |
| 启动文本（agent 标记、调试参数）    | `ps -E -ww … -p <pid>`                    | 2 毫秒                       |
| C3 启动时间                         | `ps -ww … -p <pid>`                       | 2 毫秒                       |
| C3 同一个套接字                     | `lsof -nP -a -p <pid> -iTCP -sTCP:LISTEN` | 51 毫秒                      |
| 多个 pid 的 `ps -p`（对比）         | `ps -ww … -p <pid1>,<pid2>`               | 75 毫秒（比单 pid 慢 35 倍） |

改前每条隧道是 `ps -A`（47）→ `lsof`（119，与 2 毫秒的启动文本并行）→ `lsof -a -p`（51），串行合计约 217 毫秒，与实测的并发 1 中位数 228 毫秒吻合。代价都在三次整机扫描上（进程表、两次 `lsof`）；逐 pid 的 `ps` 几乎免费，而 `ps -p` 带多个 pid 反而很慢，所以逐 pid 并行读。

**批量核对（不是缓存）。** 没有核对在跑时，第一个到达的请求先等一个收集窗口（硬上限 10 毫秒），窗口内到达的请求合成一批；批开始后到达的请求进下一批，下一批在上一批结束后立即开始（它们已经等过了，不再等窗口）。一批做一套读取：进程表和一次不带端口过滤的 `lsof` 和各个不同 pid 的启动文本并行（C0、C1），逐个请求判定（C2），然后所有幸存者一起做一次 `lsof -a -p <全部 pid>` 和逐 pid 的启动时间（C3）。保证：

- **一次观察只给在它开始之前就已经到达的请求共用。** 批在读取开始之前就把队列拿走，之后到达的请求进下一批，用的是在它到达之后才开始的读取。
- **绝不复用开始得更早的观察，批与批之间不留任何结果。** 没有缓存，没有“上一批的进程表”这种东西。
- 每个请求自己的检查各做各的：端口参数、会话、并发与速率上限（都在进入核对之前），C2 的归属与排除规则对每个请求单独判定，C3 对每个 (pid, 端口) 单独比较。一个请求被拒不影响同批的其他请求；读取本身失败则整批失败（fail-closed），下一批重新开始。
- **等待不拖慢撤销。** 隧道路由在进入核对之前就开始 `awaitInvalidation`，并让核对与“会话已失效”竞速：会话在收集窗口里被撤销，请求立即被拒（401），并从批里退出，不影响同批的其他请求。
- C0 和 C1 可以并行读（改前是串行）：它们之间不需要顺序，因为 C3 的启动时间比较仍然能发现两次读取之间 pid 被换成了别的进程。

**实测（改后，同一方法：同一端口、真实进程、本机约 1,050 个进程）：** 并发 1：中位数 175 毫秒，p95 223；并发 6：中位数 185，p95 230；并发 32：中位数 175，p95 197。每个并发档的所有请求都落在同一批里（88 轮就是 88 批），并发 6 的 p95 已经低于 300 毫秒的目标。前后对照见 §11。

没有换成 `netstat -anv`（约 14 毫秒，带进程号）：它给的是套接字最后一次被使用的进程，不是全部持有者，和 `lsof` 不等价；如果以后要把 119 毫秒的 `lsof` 再压下去，这是要主控同意的另一个观察原语。

#### 剩下的窗口，和 PID 复用

- 去掉缓存后，剩下的窗口只有 C3 到 `connect()` 之间的几毫秒：原监听者在这段时间退出、同时别的进程恰好在同一个端口同一个地址上绑定。攻击者得已经能在 B 上跑进程，并且要赢一次几毫秒的竞速，所以是残余风险，不是可远程利用的洞。拨号后不再复核（`connect` 成功不能证明连到了哪个进程）。
- **PID 复用：** C2 让复用的新进程得自己证明有主（agent 要带标记，终端要有 shell 祖先）；C0/C3 的启动时间在同一个 pid 上区分新旧实例。macOS 的 `lstart` 精度是 1 秒：同一秒内同一个 pid 被复用并绑定同一端口，在 pid 顺序分配的系统上不现实，且仍要过 C2。
- **`SO_REUSEPORT`：** 两个同用户进程可以在同一地址、同一端口上同时监听，内核负载均衡。C1 发现同一端口上不止一个 pid 就拒绝。
- **另一种地址族：** T3 的服务在 `127.0.0.1:5173`，别的进程在 `[::1]:5173`。网关拨 C1 为那个 pid 得到的具体地址，不会拨到另一个地址族。

#### 测试（socket harness，真实进程）

- 有主进程退出，另一个进程绑定同一端口：**立即**被拒，没有任何 TTL 参与（`owner-changed`）。
- 身份注入测试：身份读取函数是可注入的；让它在 C0 和 C3 之间对同一个 pid 返回不同的启动时间 → 被拒；读取失败（工具退出码非零、超时、输出无法解析）→ 被拒（fail-closed）。
- 归属：agent 归属项的环境被清掉标记 → 被拒；终端归属项的祖先链被打断（用 `setsid` 加双 fork 的辅助进程让它被 init 收养）→ 被拒；终端 shell `exec` 成监听者 → 放行。
- `SO_REUSEPORT` 两个监听者 → 被拒；IPv4/IPv6 双栈：只绑 `127.0.0.1`、只绑 `::1`、通配绑定各自的拨号目标正确（通配 → `127.0.0.1`）。
- 平台命令的解析函数用记录下来的真实输出做夹具测试（macOS 的 `lsof -F`、`ps` 的 `lstart`，Linux 的 `/proc/<pid>/stat`（含 comm 里带空格和括号的情形）、`/proc/net/tcp{,6}`），在所有平台上都跑；真实进程测试在各自平台上跑：macOS 本机，Linux 在容器里（`vp run fork:loopback-gateway:linux-check`，见 §12 9.4；两处测试用 `runsOnRealProcesses` 和 `realInspectorLayer` 选平台，macOS 路径不变）。
- 每条隧道都经过核对，没有缓存：同一个端口上一条接一条的 6 条隧道是 6 批、6 套完整读取（`PortAuthorizerBatch.test.ts`、`PortAuthorizer.test.ts`）；同时到达的 6 条是 1 批，每条仍各自得出结论；在某次读取开始之后才到达的请求绝不用那次读取的结果；收集窗口里或读取进行中被撤销的会话立即被拒。

### 5.4 `T3CODE_PORT_DISCOVERY=0`

这时 `scanUnlocked` 只探测配置的 URL，`discovered` 永远为空，网关没有任何可许可的端口。处理：

- server 启动时读同一个环境变量（上游需要把 `PORT_DISCOVERY_ENV` 常量 `export` 一下，1 个词），为 `0` 时不广告能力（`capabilities.loopbackGateway` 不出现）。客户端据此走"B 不支持"的路径，不会白取票据。
- 取票的 RPC 在这种状态下回 `LoopbackGatewayUnavailableError { reason: "discovery-disabled" }`，防止旧缓存的能力。
- 错误页文案专门说"这台环境关闭了端口发现"。

### 5.5 绑定地址

见 §5.3 的 C1：复核时从那个 pid 在这个端口上的监听读出绑定地址，网关只拨这一个地址。通配绑定（`*`、`0.0.0.0`、`::`）拨 `127.0.0.1`。

### 5.6 排除清单与运行时归属（即使端口发现里出现也不行）

**规则：** T3 server 进程自己的监听，以及 T3 自己启动的运行时进程（不是 agent 工具调用或终端命令起的作业）的监听，一律排除。排除优先于许可，在 §5.3 的 B 和 C2 两处检查。

第二版的这一节被复核否定了三处（GPT 复核 P1-2、P1-3、P1-4）：监听点清单里还有"未核实"项，防漂移测试只保证新增的地方会被登记、不能证明已有条目的归属判断正确；E2 假设 provider 运行时是 server 的直接子进程且带环境标记，这对经过 shell 或包装层的启动不稳定，server 重启后遗留的孤儿运行时还会落进"agent 作业"的许可；Windows 只做 C1 与"所有平台的安全边界"不匹配。这一版的处理：**清单的逐项落实变成 9.1 开工的第一道关**（§5.6.0），provider 运行时改为**显式登记 pid + 启动时间**加**运行时特征**加**不可靠时只放行已登记运行时的后代**，Windows 不广告能力。

#### 5.6.0 9.1 开工的第一道关：监听点和运行时进程的逐项落实

**网关路由的代码要等这一关过了才开始写**。关口的产出是一份提交进仓库的清单（`apps/server/src/fork/loopbackGateway/exclusions.json`）加这一节的核实版本（写回 9.1 分支里的 §5.6，替换下面的"本轮读码所得"为"已核实"）。

关口的做法：

1. **每个监听点、每个长期运行的子进程各一条记录**，字段：位置（`文件:行`）、是不是 TCP（代码依据）、属于哪个进程（server / 子进程 / CLI）、处理（规则编号、登记端口、登记运行时、或"非 TCP"的依据）、验证（读码，或运行时测试的名字）。
2. **能做运行时测试的就做**：起真实的 server 层，provider 一律用测试用的假可执行文件（会在回环上监听的小脚本）或现有的回放 harness；**不跑真实的 agent 回合，不碰用户真实的 provider 凭据**，不用真实的 provider 登录流程。
3. **拿不准的一律排除，不放行。** 条目照样留在清单里，标"未核实，已排除"，并在 §5.6 的残余风险里列出，不会被默默放行。
4. 防漂移的源码扫描测试（§5.6.4）在关口之后接上；它保证新增监听点会让测试失败，不能替代这一步的逐项核实。

**关口必须逐项落实的条目**（第二版标"未核实"或依赖"现状没有"的，加上这一轮读码新发现的）：

| 条目                                                                                                                                                                                       | 要回答什么                                           | 本轮读码已经得到的                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 设备 hub 和 agent-device 守护进程（`LocalDeviceHost.spawnHub`、`AgentDeviceShim.ts`、`DeviceService.ts`）                                                                                  | 监听哪些端口，进程树是什么，server 退出时会不会遗留  | hub 是回环 TCP 口（`reserveLoopbackPort("127.0.0.1")`、`--host 127.0.0.1`、`detached: false`）；守护进程是 hub 的子进程（`--daemon-base-url`），也是回环 TCP                                                             |
| provider 的 OAuth 和回调（`CodexChatGptAuth.ts:486,500`、`codexAuthCallback.ts:39,86`、`antigravityAuthSupport`、`packages/provider-acp-registry/src/server/auth.ts`、`providerAuthFlow`） | 谁监听、在哪个进程里、持续多久                       | Codex 的两处是 server 或桌面主进程内的临时回环监听（E1）；`antigravityCallback.ts` 是**客户端**（`node:http` 的 `request`，把回调转发到 `127.0.0.1`），不是监听；ACP 注册表的登录命令和 `providerAuthFlow` 未读完 → 排除 |
| Muse（`packages/provider-muse`，`@muse-code/sdk`）                                                                                                                                         | `muse serve` 本身会不会开端口；T3 能不能拿到它的 pid | SDK 里写明 stdio 绑定（`connection/spawn.js`："Node stdio binding"），`detached` 由 SDK 的 `ownsProcessGroup` 决定；`muse` 可执行文件自己会不会监听、pid 能否取得 **未核实**                                             |
| 资源监视器（`resourceTelemetry/NativeTelemetryClient.ts`）                                                                                                                                 | 原生监视进程会不会监听                               | 命令走 stdin（`stdin: "pipe"`），是 server 的直接子进程；原生二进制是否监听 **未核实**                                                                                                                                   |
| `CodexManagedTokenBroker.ts:129,201`                                                                                                                                                       | 是不是 TCP                                           | **已核实不是 TCP**：端点是 `NodePath.join(directory, "s")` 的 Unix 套接字，创建后 `chmod 0o600`（`:78`、`:207`），Windows 是命名管道（`:53`）。关口加一条运行时测试，断言它不在 server 的 TCP 监听里                     |
| 受管端点连接器 `cloud/ManagedEndpointRuntime.ts:705-717`                                                                                                                                   | 监听什么                                             | **第二版漏了这一项**：`tunnel … --metrics 127.0.0.1:0 run`，连接器在回环上开了一个随机端口的指标监听（`detached: false`，server 的直接子进程）→ 登记为运行时                                                             |
| 其余所有 `ChildProcess.make`/`spawn(` 的调用点（本轮 grep 出约 50 个文件，大多数是 git、gh、ps 之类的瞬时命令）                                                                            | 哪些是长期运行的                                     | 长期运行的已归入 §5.6.2 的表；瞬时命令在表末尾一行说明                                                                                                                                                                   |

#### 5.6.0.1 两道关的结果（9.1 M2 核实版）

**设计变更（主控，M2）：不在 adapter 文件里登记运行时。** 原因：登记要改 7 个上游文件里最常变的启动代码（约 +19 行），而"这个进程是不是某个 provider 的运行时"本来就能从现读的进程祖先链和命令行判断。改为：每条隧道现读祖先链；一张 fork 里的特征表（`RuntimeSignatures.ts`）给出每个驱动的"根特征"和"运行时特征"；二进制路径取自 server 设置的 `binaryPath`，不取自 adapter。规则见 §5.6.3。`forkRuntimeRegistry.ts` 不再创建，adapter 里一行都不加。

**关口 A（监听点清单）：** `apps/server/src/fork/loopbackGateway/exclusions.json`，21 条监听点记录、12 条长期子进程记录；防漂移测试 `ExclusionsInventory.test.ts` 把 18 个文件、34 处匹配的源码扫描与清单逐项比较，并要求每个文件至少有一条记录、每条记录写明处理方式和验证、验证里引用的测试名真实存在。

- 运行时核实的：server 自己的监听（主口、隧道口、桌面标签页通道）、hub 与守护进程的形态、cloudflared 的指标口、frpc 的形态都由 `PortAuthorizer.test.ts` 里的真实子进程用例覆盖（E1、E2）；`CodexManagedTokenBroker` 的端点用真实的层起一次，断言是模式 0600 的 Unix 套接字文件，不是 TCP；完整自检（下）。
- **"未核实，已排除"的 4 条：** 桌面单实例激活套接字（`DesktopAppActivation.ts`，读码认为是路径型套接字，没有在运行的桌面应用上看过，也不在 B 的 server 进程树里）、无头 Chrome（`--remote-debugging-pipe`，没起真实 Chrome；E7 还会拒绝带 `--remote-debugging-port` 的参数）、资源监视器（原生二进制是否监听没验证）、Muse（SDK 内部如何起 `muse` 没读到底）。它们都是 server 的直接子进程或不在 server 的树里，被 E2 或"不在 server 的树里"一律拒绝，不会被默默放行。
- **完整自检：** `PortAuthorizer.test.ts` 的 self-check 用例：测试进程当作 server，起三个进程内监听、一个 hub（孙进程在监听）、cloudflared 形、frpc 形、OpenCode 形、Claude 形的直接子进程（**全部带 agent 标记，覆盖最坏情形**），再加一个终端 shell 的作业和一个 Claude agent 的作业；用 `lsof` 列出该进程树里全部 TCP 监听（至少 10 个），逐个过网关：只有终端的作业和 Claude agent 的作业被放行，其余全部被拒。

**关口 B（provider 运行时的进程树）：** 没有起任何真实 provider CLI。依据是读启动代码、读本机已安装的启动器（文件类型和开头），再加假包装层的真实进程测试。

| 驱动               | 根（server 的直接子进程）                                                                                           | 真正的运行时                                         | 前提成立？                                                             | agent 作业                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------------------------------------- | ----------------------------- |
| Claude             | `/bin/sh` 看守脚本 `exec` 成 CLI，pid 不变（`ClaudeAdapterV2.ts:354-381`）；本机 `claude` 是 Mach-O（`versions/…`） | 与根相同                                             | 成立                                                                   | 有（设置 `T3CODE_THREAD_ID`） |
| Codex              | `agentScope.wrap`（`exec`）→ 本机的 `codex` 是 npm 的 node 启动器                                                   | **根的子进程**：启动器 `spawn` 原生二进制，不 `exec` | 成立，但根与运行时是两个进程（根特征是启动器，运行时特征是原生二进制） | 有                            |
| OpenCode           | `opencode serve --hostname --port`（Mach-O）                                                                        | 与根相同，自己监听回环口                             | 成立                                                                   | 无标记，只有终端有主          |
| Grok               | `grok agent stdio`（Mach-O）                                                                                        | 与根相同                                             | 成立                                                                   | 无标记                        |
| Kiro               | `kiro-cli acp …`                                                                                                    | 与根相同                                             | 成立（读码；本机没装）                                                 | 无标记                        |
| Fx                 | `fx acp`                                                                                                            | 与根相同                                             | 成立（读码；本机没装）                                                 | 无标记                        |
| Pi                 | `node …/pi-coding-agent/…/cli.js --mode rpc`（本机 `pi` 是 node 脚本）                                              | 与根相同（node 进程）                                | 成立                                                                   | 无标记                        |
| Muse               | SDK 起 `muse`（stdio）                                                                                              | 与根相同（读码）                                     | **未核实**：SDK 内部没读到底                                           | 无标记                        |
| Cursor             | Cursor SDK 内部起自己的本地运行时                                                                                   | —                                                    | **前提不成立**：形态没验证                                             | —                             |
| Antigravity        | ACP 运行时加用户安装的二进制                                                                                        | —                                                    | **前提不成立**：名字和参数没验证                                       | —                             |
| ACP 注册表的 agent | 注册表条目或用户配置的命令（`npx`、`uvx`、二进制）                                                                  | —                                                    | **前提不成立**：没有固定形态                                           | —                             |

- **前提成立的 8 个驱动，不成立的 3 个（Cursor、Antigravity、ACP 注册表）。不是"大多数不成立"，不需要停下。** 这三个在 `NO_SIGNATURE` 里写明理由（测试保证 `BUILT_IN_DRIVERS` 里每个驱动要么在特征表里，要么在这张清单里），它们的根认不出特征，按 E2 整棵子树排除，也就是"拿不准就排除"。
- **转发不了脱离父进程的后台作业的有哪些：** 因为归属只看现读的祖先链，**所有驱动**都一样：作业所在的祖先链一旦断了（父进程退出，作业被 launchd 收养），它就不在 server 的子树里，被拒为 `not-owned`。具体后果取决于各家 CLI 的 shell 工具是不是一次性的 shell：每条命令一个 shell、命令结束 shell 退出，则 `nohup cmd &` 起的服务会被收养而转发不了。这一点**没有用真实 CLI 验证**（不能起真实 provider），要写进用户文档和错误卡片。Cursor、Antigravity 和 ACP 注册表的 agent 即使作业祖先链完好也转发不了（根认不出，E2 整棵排除）；只有 Claude 和 Codex 有"agent 有主"一档，其余驱动的作业只有在 T3 终端里起才能转发。
- **server 崩溃后遗留的运行时：** 新做法不依赖"它会不会退出"。遗留的运行时被 launchd 收养，不在 server 的子树里，它和它的所有作业（带标记的也一样）都被拒为 `not-owned`；用假包装层的测试验证了这一点（"refuses a marked job whose launcher is gone"和不 `exec` 的包装层用例里启动器退出后的断言）。Codex 在 stdin EOF 后是否退出没有验证，也不再影响安全结论（§14.2 第 4 条）。
- `TerminalManager.subscribeMetadata` 先给快照，之后每次启动、重启、退出、关闭、出错都带 `pid` 与 `status`；`TerminalShellRegistry` 的折叠函数和注册表有单元测试覆盖快照替换、重启换 pid、退出、移除、订阅解除（§14.2 第 3 条）。

#### 5.6.1 所有监听点（源码扫描，排除测试、脚本、fixture）

我 grep 了 `apps/server`、`apps/desktop`、`packages/*`、`scripts` 里的 `.listen(`、`createServer(`、`NodeHttpServer.make`、`NodeSocketServer.make`、`HttpServer.serve`、`WebSocketServer(`，以及 `--port`、`--metrics`、`--listen` 参数：

| 位置                                                          | 是什么                                                    | 谁的进程                                                                   | 处理                                                           | 状态                         |
| ------------------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------- | ---------------------------- |
| `apps/server/src/server.ts:363`                               | 主 HTTP/WS 监听口                                         | server                                                                     | E1，登记端口                                                   | 读码                         |
| `apps/server/src/fork/deviceKeys/TunnelListener.ts:90-94`     | frpc 的隧道监听口，`127.0.0.1` 随机口                     | server                                                                     | E1，登记端口                                                   | 读码                         |
| `apps/server/src/preview/DesktopBrowserChannel.ts:140`        | 桌面 CDP 中继的 WS，回环随机口                            | server                                                                     | E1，登记端口                                                   | 读码                         |
| `apps/server/src/provider/CodexChatGptAuth.ts:486,500`        | Codex 登录的 OAuth 回调，`127.0.0.1` 随机口，登录期间存在 | server                                                                     | E1                                                             | 读码；关口核实持续时间       |
| `packages/shared/src/codexAuthCallback.ts:39,86`              | OAuth 回调，端口取自 redirectUri，`127.0.0.1`             | 调用者：server 和桌面主进程（`apps/desktop/src/app/CodexAuthCallback.ts`） | E1（含祖先）                                                   | 读码                         |
| `apps/server/src/htmlRender/publicProxy.ts:129,191`           | HTML 渲染的公网代理，`127.0.0.1` 随机口                   | server                                                                     | E1                                                             | 读码                         |
| `apps/server/src/provider/CodexManagedTokenBroker.ts:129,201` | 令牌代理                                                  | server                                                                     | **非 TCP**（Unix 套接字 / 命名管道）                           | 读码已核实；关口加运行时测试 |
| `apps/server/src/provider/antigravityCallback.ts`             | 一次性把回调转发到 `127.0.0.1`                            | server                                                                     | **客户端，不是监听**                                           | 读码已核实                   |
| `apps/server/src/cloud/ManagedEndpointRuntime.ts:705-717`     | 受管端点连接器的指标监听 `127.0.0.1:0`                    | 连接器子进程                                                               | E2（登记运行时）+ E3                                           | 读码；**第二版漏了**         |
| `apps/server/src/device/LocalDeviceHost.ts`（`spawnHub`）     | 设备 hub 的回环 TCP 口；守护进程也是回环 TCP              | hub 子进程及其后代                                                         | E2（登记**子树**）+ E3                                         | 读码；关口做运行时测试       |
| `apps/server/src/cli/sshHelper.ts:13,16`                      | `pick-port`：试绑一个端口，成功就立即关闭                 | CLI 进程（不是 server）                                                    | 瞬时                                                           | 读码                         |
| `packages/ssh/src/tunnel.ts:240,243`                          | SSH 本地转发监听 `127.0.0.1`                              | 托管 SSH 环境的进程：桌面主进程或 server                                   | E1（含祖先）                                                   | 读码                         |
| `packages/shared/src/Net.ts:49,78,135,148`                    | 找空闲端口的探测（立即关闭）和通用监听工具                | 调用者                                                                     | 瞬时                                                           | 读码                         |
| `apps/desktop/src/app/DesktopAppActivation.ts:178,189`        | 桌面单实例/激活控制 socket                                | 桌面主进程                                                                 | 路径型（FORK.md 记为 `/tmp/t3code-<uid>/<哈希>.sock`），非 TCP | 读码                         |
| 桌面 `T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT`                   | Chromium 调试端口，用户显式设置才开                       | 桌面主进程（B 是桌面内置 server 时是 server 的父进程）                     | E1（祖先）+ 屏蔽表 + 调试参数                                  | 读码                         |
| `mcp/McpHttpServer.ts`                                        | T3 自己的 `/mcp`，挂在主路由上                            | server                                                                     | 没有独立监听，随主口                                           | 读码                         |
| 测试、脚本、fixture                                           | 不进产品                                                  | —                                                                          | 不适用                                                         | —                            |

#### 5.6.2 server 启动的长期子进程：每个 provider 的实际进程树

下表来自这一轮读各 adapter 的启动代码（不是跑出来的）。"未核实"项由关口落实，**落实之前一律按"不可靠"处理**（按 §5.6.3 的 E5 只放行已登记运行时的后代）。

| 运行时                                                                  | 启动处和进程形态                                                                                                                                                                                                                                                                                                                                                                          | server 退出时                                                                                                                                                                                                                                                                                           | T3 是否设置 `T3CODE_THREAD_ID`                                                      | 会监听                                     |
| ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------ |
| **Claude Code CLI**                                                     | `ClaudeAdapterV2.ts:354-381` `spawnClaudeProcessGroup`：`NodeChildProcess.spawn("/bin/sh", ["-c", 看守脚本, "t3-claude", command, …], { detached: true })`。`sh` 用 `exec "$@"` 变成 CLI（pid 不变，pid = pgid = `child.pid`）；另有一个后台子 shell 看守者（argv 同样带 `t3-claude`）在同一进程组。command 可能先经 `agentScope.wrap`（同样 `exec`，pid 保持）。运行时 = exec 之后的 CLI | **有界。** 正常退出：`child.once("exit")` 里对整个进程组 `SIGKILL`（`:373-378`）。server 崩溃：看守者在只有 server 持有的 fd 3 上读到 EOF，`kill -TERM 0`，5 秒后 `kill -KILL 0`（`:344-347`），整组被杀。`setsid` 脱组的后代不在组里，Linux 上由 systemd scope 的 `agentScope.stop` 兜底，macOS 上没有 | **设置**（`:998-1004`，进程环境里就有）                                             | 可能有登录回调或 IDE 桥（未核实）          |
| **Codex app-server**                                                    | `CodexAdapterV2.ts:1450-1479` `makeCodexAppServerSpawnCommand`：`agentScope.wrap`（`/bin/sh -c … exec`，pid 保持）→ `ChildProcess.make`；`:1586` `spawner.spawn` 得到 `handle.pid`。Effect 的 spawner 默认 `detached`（独立进程组）                                                                                                                                                       | 正常：scope 关闭时对进程组 `SIGTERM`（`NodeChildProcessSpawner.ts` 的 `terminateProcessGroup`）。**server 崩溃：没有看守者**；app-server 读标准输入，stdin 的 EOF 会不会让它退出 **未核实** → 按无界处理                                                                                                | app-server 本身**不设置**；它的 shell 带（`shell_environment_policy.set`，`:1410`） | 未见（stdio）                              |
| **OpenCode `serve`**                                                    | `packages/provider-opencode/src/server/OpenCodeRuntime.ts:507-545`：`agentScope.wrap` → `ChildProcess.make(…, { detached })`，参数 `serve --hostname=… --port=…`，端口已知。`OpenCodeServerLedger.track({ pid, port, args })` 把 `{pid, startTime, command, port, owner}` 记在 state 目录                                                                                                 | 正常：scope 关闭时对进程组 `SIGTERM` 再 `SIGKILL`。崩溃：**下次 server 启动时**由账本按 pid + 启动时间 + pgid + 完整命令行精确回收孤儿（`stopOrphan`）→ 有界，但回收发生在下次启动，不是立刻                                                                                                            | 不设置                                                                              | **回环 TCP 口**（端口已知）                |
| **ACP 系**（Cursor、Grok、Kiro、Antigravity、Fx、ACP 注册表里的 agent） | `packages/provider-acp/src/server/AcpSessionRuntime.ts:1374-1445`：`resolveSpawnCommand` → Linux cgroup 包装（`sh -c … exec`）或 `agentScope.wrap` → `spawner.spawn(ChildProcess.make(…, { detached: options.ownDetachedProcessGroup }))`，pid = `child.pid`。自带 pid + 启动时间的后代所有权账本（`AcpOwnedPosixProcess`）                                                               | 正常：runtime scope 的终结器终止进程（Linux 加 cgroup）。崩溃：没有看守者，stdio EOF 是否让 agent 退出取决于各家 agent → 按无界处理                                                                                                                                                                     | 不设置                                                                              | 未见（stdio）；各家 agent 自己的行为未核实 |
| **Pi**                                                                  | `packages/provider-pi/src/server/rpc.ts:194-206`：`spawner.spawn(… { detached: platform !== "win32" })`                                                                                                                                                                                                                                                                                   | 同 ACP：正常终止，崩溃无看守者                                                                                                                                                                                                                                                                          | 不设置                                                                              | 未见（RPC over stdio）                     |
| **Muse**                                                                | `@muse-code/sdk` 的 `MuseServeChild.spawn`（`detached` 由 SDK 决定），`provider-muse/src/server/sdk.ts` 里 `spawnMspConnection`；stdio 绑定                                                                                                                                                                                                                                               | SDK 自己管；崩溃无看守者（未核实）                                                                                                                                                                                                                                                                      | 不设置                                                                              | 未核实（SDK 是 stdio）                     |
| 设备 hub（及 agent-device 守护进程）                                    | `LocalDeviceHost.ts` `spawnHub`：`detached: false`，`--port` 取自 `reserveLoopbackPort("127.0.0.1")`，`--host 127.0.0.1`                                                                                                                                                                                                                                                                  | 关口核实                                                                                                                                                                                                                                                                                                | 继承 server 环境                                                                    | **回环 TCP 口**；守护进程也监听回环        |
| 受管端点连接器（cloudflared）                                           | `ManagedEndpointRuntime.ts:705-717`，`detached: false`，`--metrics 127.0.0.1:0`                                                                                                                                                                                                                                                                                                           | 关口核实                                                                                                                                                                                                                                                                                                | 继承                                                                                | **回环 TCP 口**（指标，随机端口）          |
| frpc                                                                    | `fork/deviceKeys/frpcProcess.ts`（fork 文件）；`frpcConfig.ts` 写明不开管理页                                                                                                                                                                                                                                                                                                             | fork 自己管                                                                                                                                                                                                                                                                                             | 继承                                                                                | 否                                         |
| 无头 Chrome                                                             | `htmlRender/headlessChrome.ts:188`、`preview/PreviewBrowserHost.ts`：`--remote-debugging-pipe`                                                                                                                                                                                                                                                                                            | 关口核实                                                                                                                                                                                                                                                                                                | 继承                                                                                | 否（管道）                                 |
| 资源监视器                                                              | `resourceTelemetry/NativeTelemetryClient.ts`：`spawner.spawn`，stdin/stdout 管道                                                                                                                                                                                                                                                                                                          | 关口核实                                                                                                                                                                                                                                                                                                | 继承                                                                                | 未核实                                     |
| 终端 shell                                                              | `terminal/Manager.ts`、`NodePtyAdapter.ts`：node-pty，server 的直接子进程                                                                                                                                                                                                                                                                                                                 | 终端自己的生命周期                                                                                                                                                                                                                                                                                      | 不设置                                                                              | shell 或其后代：**这是终端归属的来源**     |
| 短命令（git、gh、ps、lsof、文本生成 CLI、`status` 探测等）              | `vcs/`、`textGeneration/`、`processRunner.ts`、各 provider 的 `status.ts` 等                                                                                                                                                                                                                                                                                                              | 瞬时                                                                                                                                                                                                                                                                                                    | —                                                                                   | 无                                         |
| provider 侧由 CLI 自己启动的 MCP 进程                                   | 由各家 CLI 启动，是 CLI 的后代                                                                                                                                                                                                                                                                                                                                                            | 随 CLI                                                                                                                                                                                                                                                                                                  | 继承 CLI 的环境（Claude 的带标记）                                                  | 取决于 MCP 服务                            |

**两条要明说的事实：**

1. **只有 Claude 和 Codex 设置 `T3CODE_THREAD_ID`**（grep `AGENT_THREAD_ENV`/`T3CODE_THREAD_ID`：`ClaudeAdapterV2.ts`、`CodexAdapterV2.ts`、`PortScanner.ts`、codex 回放）。所以"agent 起的服务"这一档（§5.1）只会对 Claude 和 Codex 出现；OpenCode、ACP 系、Pi、Muse 的 agent 起的服务**只有在 T3 终端里起的才有主**。除非 server 本身是在一个带这个变量的终端里启动的（这个仓库的日常开发就是这样），这时 server 的所有子进程都继承了标记，所以绝不能靠"没有标记就不会被列出"。
2. **server 崩溃后遗留的运行时**：Claude 的看守者保证整组被杀；OpenCode 靠下次启动的账本回收；Codex、ACP 系、Pi、Muse 没有看守者，是否遗留取决于它们读 stdin 的行为（未核实）。所以孤儿运行时必须被特征（E4）识别排除，而不是靠"我们登记过它"。

#### 5.6.3 规则

M2 的设计变更见 §5.6.0.1：判断全部来自每条隧道现读的祖先链，不再有登记表。

**基本量。** 对监听者 L，C2 读 L 到根的祖先链。**运行时根（root）** = 链上本 server 的直接子进程（不计正在运行的终端 shell，那是终端归属的来源）。每个驱动有"根特征"和"运行时特征"（`RuntimeSignatures.ts`），两者相同（`exec` 过的启动）或不同（不 `exec` 的包装层：根是包装层，真正的运行时是它的子进程）。特征匹配整行 `ps` 参数文本；server 设置里的 `binaryPath` 也算（取第一或第二个词的文件名，node 垫片）。

| 编号 | 排除                                                                                                                                                                                                                                                                                       | 适用于     |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------- |
| E1   | 监听者的 pid 是本 server 进程，或是它的**祖先**（桌面主进程等）                                                                                                                                                                                                                            | 所有归属   |
| E2   | **server 的直接子进程**，既不是正在运行的终端 shell、又不匹配任何驱动的根特征：**整棵子树**一律排除（hub 与守护进程、cloudflared、frpc、资源监视器、无头 Chrome、git、没有特征的 provider、任何认不出的东西）。不在 server 子树里的监听者（含被 launchd 收养的遗留运行时）一律 `not-owned` | 所有归属   |
| E3   | 匹配某驱动根特征的直接子进程：**它自己**的监听排除；它的后代是"作业"，继续按 E4 到 E7 判断                                                                                                                                                                                                 | 所有归属   |
| E4   | 匹配任何驱动**运行时特征**的进程：它自己的监听排除，不管它在根的哪一层（不 `exec` 的包装层下的真实运行时就靠它）                                                                                                                                                                           | 所有归属   |
| E5   | **agent 有主**的监听（祖先环境带 `T3CODE_THREAD_ID`）：只有当它的根是 "本 server 现在活着的、匹配该驱动根特征的直接子进程"，且该驱动会设置标记（`agentJobs`，目前只有 Claude 和 Codex），才放行；其他一律排除。**终端有主的端口不受影响**                                                  | agent 归属 |
| E6   | 端口 ∈ 已登记端口（`ServerConfig.port`、隧道监听口）∪ 屏蔽表（§5.7，8 个）                                                                                                                                                                                                                 | 所有归属   |
| E7   | argv 或 `NODE_OPTIONS` 带调试参数（§5.7）：这个 pid 的所有监听一律排除                                                                                                                                                                                                                     | 所有归属   |

**测试保证每个驱动都有声明：** `RuntimeSignatures.test.ts` 遍历 `BUILT_IN_DRIVERS`，每个驱动要么有特征，要么在 `NO_SIGNATURE` 里写明理由；新加驱动而没声明，测试失败。

**哪些驱动归哪一类**见 §5.6.0.1 的表。Claude 与 Codex 有 agent 作业；其余驱动没有"agent 有主"一档，作业只有在 T3 终端里起才能转发。Codex 的原生运行时是启动器的子进程，由 E4 排除它自己的监听，它的后代是作业（E5 适用）。

**「根」是按位置认的，不是按名字认的。** `classifyListener` 里的根固定是 `chain[serverIndex - 1]`：监听者祖先链上、本 server 的直接子进程，别的位置都不算。特征（名字、路径）只回答“这个根是哪个驱动的”，不决定谁是根。所以文件名撞车要成立，只能是 **server 自己**起了一个同名程序；agent 或终端里的命令起的同名程序不是 server 的直接子进程，当不了根（它只会是某个根的后代，按作业判断）。

**没配 `binaryPath` 时，默认特征怎么匹配：** `DRIVER_SIGNATURES` 里每个驱动按命令名匹配整行 `ps` 参数的开头部分（例如 `claude` 或 `…/claude/versions/…`，Codex 是 `codex … app-server`，OpenCode 是 `opencode … serve`），**不看目录**，因为默认情况下 provider 是按 `PATH` 解析的，路径本来就因机器而异。这是有意的，上面那条位置规则限制了它的影响面。

**配了 `binaryPath` 时（9.1 修复轮收紧）：** 只在以下情形才把一个根认作该驱动：进程的 argv[0]（或 argv[0] 是解释器 `node`/`bun`/`deno`/`python`/`bash`/`sh`/`zsh` 时的 argv[1]，即 node 垫片）是**绝对路径**，且它的 `realpath` 等于 `realpath(binaryPath)`。同名不同目录的文件不匹配；不是绝对路径的词（`my-codex`、`./my-codex`）不匹配；第三个词不匹配；`binaryPath` 自己不是绝对路径或解析不出来，什么都不匹配。**拿不准就排除：** 匹配不上时这个根没有特征，落到 E2，整棵子树都拒。路径比较在每条隧道现读（`realpathSync`），符号链接换了指向也跟得上。

**脱离父进程的 agent 后台作业：这一版对所有驱动都拒绝（决定）。** 作业的归属只看现读的祖先链：从作业一路能走到一个活着的、匹配该驱动根特征的直接子进程，才算 agent 作业。父进程退出、作业被 launchd 收养之后，它不在 server 的子树里，被拒为 `not-owned`（`nohup cmd &` 在一次性 shell 里起的服务就是这样）。**没有按 `T3CODE_THREAD_ID` 反查 provider 来放行**，原因：那会把线程归属、provider 类型、E4、E6、E7 几个条件耦合在一起，撤销（线程或设备被撤销）的时序也更难证明，而没有真实 provider 生命周期的证据支撑。端口列表不改：这类服务仍可用“在 B 的浏览器中打开”查看，9.3 的错误卡片说明被拒原因。

**后来的修订：用户手动放行可以覆盖 `not-owned`。** 上面“一律拒绝”没有给用户出路，而真实使用里（`scripts/start.sh` 用 `nohup uv run … &` 起服务后退出）这正是最常见的情形。现在用户可以在卡片上放行那个端口：server 按端口记一份全环境共用的列表，`classifyListener` 的 `granted` 只把两处 `not-owned`（不在 server 子树里；子树里但没有 agent 标记）改成放行，E1 到 E4、E7、屏蔽端口和 server 自己的端口照旧拒绝，C2、C3 的现场核对不变。这不违背 §5.1 的用意：归属规则是不让标签页里的**网页**碰到 B 上无关的服务，放行是用户在 T3 自己界面上的操作，网页点不到，而且能用转发的会话本来就有 `terminal:operate`。agent 没有 MCP 工具可以放行。放行过的端口不会再以 `not-owned` 被拒（读不出监听者是 `owner-changed`，非回环地址是 `not-loopback`），否则卡片会让用户反复点放行。代码：[`LoopbackGatewayGrants.ts`](../apps/server/src/fork/loopbackGateway/LoopbackGatewayGrants.ts)、[`GatewayExclusions.ts`](../apps/server/src/fork/loopbackGateway/GatewayExclusions.ts)、[`PortAuthorizer.ts`](../apps/server/src/fork/loopbackGateway/PortAuthorizer.ts)。

**`TerminalShellRegistry`：** fork 里订阅 `TerminalManager.subscribeMetadata`，事件驱动，维护"正在运行的终端 shell 的 (pid, 启动时间)"；E2 和 §5.3 的 C2 都用它。读启动时间的读取还在进行时，`shells` 会等它完成，所以刚启动的终端不会因为"还不认识"被误拒。

#### 5.6.4 验收

- **完整 server 的自检：** 起一台完整的 server（带隧道监听口、`DesktopBrowserChannel`、设备 hub 的假可执行文件、受管端点连接器的假可执行文件，`T3CODE_THREAD_ID` 在自己的环境里，覆盖最坏情形），用 `lsof -p`（macOS）或 `/proc`（Linux）列出 server 进程和它全部后代的 TCP 监听，断言每一个都被网关拒绝，除非它是终端 shell 的后代或 agent 作业。
- **假运行时（每种形态一个假可执行文件，会在回环上监听）：** 直接子进程自己监听 → 被拒（E2）；匹配根特征的根自己监听 → 被拒（E3）；它的后代（作业）按 E5 放行或拒绝；不 `exec` 的假包装层下，真实运行时的监听被拒（E4）、它的作业按 E5 判断，包装层退出后一律被拒；终端 shell 的作业 → 放行；hub 的孙进程 → 被拒（E2 整棵子树）。
- **孤儿：** 模拟 server 重启：启动器退出，遗留的运行时与它的作业被 launchd 收养，不在 server 的子树里 → 一律 `not-owned`（带标记的作业也一样）；终端有主的端口不受影响。
- **特征声明测试**（上面）、**防漂移测试**：`ExclusionsInventory.test.ts` 的源码扫描列出产品代码里所有 `.listen(`、`createServer(`、`NodeHttpServer.make`、`NodeSocketServer.make`、`HttpServer.serve`、`WebSocketServer(` 以及 `--port`、`--metrics`、`--listen`、`-L` 参数的位置，与 `exclusions.json` 逐项比较。新增监听点会让测试失败，直到有人给它写上处理方式。
- 关口产出的清单里每个条目都有验证（读码或运行时测试），"未核实，已排除"的条目单独列出。
- **防漂移扫描的已知盲区（P2-2）：** 它只数固定的字面量，所以看不到：动态拼出来的参数（`["--po" + "rt"]`、模板拼接的 `-L` 参数）；别名导入（`import { createServer as cs }` 之后的 `cs(`）；其他监听 API（`dgram`、`http2`、Unix 套接字的 `listen`、第三方库自己开的端口、Bun/Deno 的 `serve`）。它是回归护栏，不能替代关口 A 的一次性人工与运行时审计；以后新增监听抽象（新的服务器工厂、新的传输库）时，要给实际用到的 API 补一个扫描模式，或补一条运行时断言。

#### 5.6.5 残余风险

- server 崩溃后遗留的运行时：不再依赖特征。它被 launchd 收养，不在 server 的子树里，整棵被拒（`not-owned`）。代价是它们的合法作业也转发不了。
- ACP 的客户端终端命令（`packages/provider-acp/src/server/clientTerminals.ts`）是 server 的直接子进程，被 E3 默认拒绝；它们不带标记，本来也不属于"agent 有主"，只有 server 自己是在带标记的终端里启动时才会碰到（开发这个仓库的日常工作流）。
- **接受的残余风险：CLI 自己起的、带 agent 标记的 MCP 进程，如果在回环上监听，会按 agent 作业放行。** MCP 进程是 CLI 的后代，继承 CLI 的环境（Claude 的带 `T3CODE_THREAD_ID`），所以满足 E5。会发生的写法有：stdio MCP 同时开 HTTP/SSE 回环口（如 `npx @playwright/mcp --port 8931`）、`mcp-remote` 一类做 OAuth 的代理在随机回环口监听回调、带本地管理页的 MCP、`npx`/`uvx` 起的 MCP 再起的子服务。**这一版不改代码**，理由：(1) “从运行时到监听者之间必须隔一层 shell”不可靠：`bash -c` 和 `zsh -c` 对最后一条命令常常直接 `exec`，shell 就不在链上了，结果会把真正的 dev server 也误拒，而 MCP 进程由 CLI 直接 spawn 的情形也不一定没有 shell；(2) 首次转发某个端口时让用户确认命令行，违背易用性（页面冷启动一次开五六条连接），也没人会逐条读；(3) 按名字（`mcp`、`@modelcontextprotocol`）排除会误伤名字里带这些字样的正常服务，漏掉没有这些字样的 MCP。**仍然生效的约束：** E7（带调试参数的整进程排除，例如 `chrome-devtools-mcp` 起的 Chrome）、保留端口（8 个屏蔽端口和 server 自己的端口）、速率与并发上限（每会话 64、每 server 256、令牌桶、每会话每分钟 30 张票据）、`preview:operate` 加 `terminal:operate` 两个 scope、所有隧道只在加密或本机的连接上。暴露面是“用户的 agent 起了一个服务，而用户的另一台机器的浏览器能看到它”，与 dev server 同类；论据不是“上游浏览器本来就能访问全部回环端口”（那是另一个主体、另一条路径），而是这一类服务本来就属于 agent 的作业，没有可靠的、不误伤正常服务的判据把它们分开。
- **脱离父进程的 agent 后台作业对所有驱动都转发不了**（决定见 §5.6.3）：被 launchd 收养的作业不在 server 的子树里。用户文档要写明，改用“在 B 的浏览器中打开”。
- 用户自己在 B 上以终端归属启动的、本意不想暴露的服务：这是功能的前提；用户要避免就不要在 T3 终端里起它。
- **Windows：** 没有 argv 和环境的读取路径、没有 agent 归属档、没有未验证的 `netstat` 复核——所以 Windows 的 B **不广告能力**，不存在"只做一部分检查"的状态（复核 P1-4）。Linux 同样：真实进程测试通过前不广告。9.4 的容器测试已经通过（§12 9.4），广告函数没有改，是否放开由主控定。

### 5.7 调试进程：整进程排除（评估结论）

问题：进程 argv 带 `--inspect`、`--inspect-brk`、`--remote-debugging-port` 的监听是否一律排除？

**事实：**

- `PortScanner` 手上**没有 argv**：`lsof -F pcn` 只给命令名（`c` 行）；macOS 的 `ps -E -ww -o pid=,command=` 只在为 agent 归属读取环境时调用，结果只解析出线程标记就丢弃（`parsePsEnvironmentThreads`），不保留 argv；Linux 读 `/proc/<pid>/environ`，不读 `cmdline`。
- 我在本机实测：`node --inspect=0 listener.cjs` 的进程在自己的监听之外**又开了一个随机端口的检查器监听**（`lsof -a -p` 同一个 pid 下出现 `127.0.0.1:64563` 和 `[::1]:64565` 两个监听）。随机口从 argv 里读不出来，静态端口表也盖不住。
- 复核步骤 C2 本来就要读这个 pid 的 argv 和环境（macOS 一次 `ps -E` 同时给出两者），所以判断的成本是零。

**结论：是，整进程排除。** C2 在 argv 或 `NODE_OPTIONS` 里匹配到下列任一项，这个 pid 的**所有**监听一律被拒（原因 `debug-process`）：`--inspect`、`--inspect-brk`、`--inspect-wait`、`--inspect-port`、`--remote-debugging-port`、`-agentlib:jdwp`、`-Xrunjdwp`。

- 理由：检查器和 JDWP 是远程代码执行级别的接口，可能开在随机端口上（`--inspect=0`），同一个进程的 web 服务和调试口无法按端口分开。
- 代价：用 `--inspect` 启动的 dev server 本身也预览不了。可恢复：错误卡片说明原因（§7.2），用户可去掉参数重启，或用「在 {environment} 的浏览器中打开」。
- 匹配是对 `ps -E` 整行文本的正则，可能把环境变量值里的字样也算上：宁可误拒（fail-closed）。
- Windows 没有 argv 和环境的读取路径，所以 Windows 的 B 不广告这个能力（§5.6.5），不存在"没有 argv、只靠屏蔽表"的状态。
- 名单可扩展，但不做通用的"调试器检测"。其他语言的调试器（`debugpy --listen`、`dlv --listen`）这次不列进参数名单；它们的默认端口 5005（JDWP）和 5678（debugpy）在端口屏蔽表里（N5，已定）。

端口屏蔽表（Q3 和 N5，已定，最终 8 个）：`9222`、`9229`、`5858`、`5859`、`2375`、`2376`、`5005`、`5678`。

## 6. 威胁模型

### 6.1 恶意页面借转发能多做什么

页面指：标签页里加载的任何内容，包括被 agent 改过的开发页面，或用户在这个标签页里导航到的外部网站。

| 能做的                        | 说明                                                                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 访问 B 上所有"有主"的回环服务 | 这是功能本身，**包括这些服务的完整网络接口**（见 6.7）。比"在 B 的浏览器中打开"（现有功能，页面能访问 B 的全部回环端口，没有许可）窄                                                                                                                                                                                     |
| 对有主端口说调试协议          | 页面只能通过浏览器 API 发 HTTP、WebSocket、TLS，不是任意 TCP。但 WebSocket 握手不受 CORS 约束：只检查 `Host` 的调试协议服务（例如 Node 的 `--inspect`）会接受 `Host: localhost`，页面能直接说调试协议，等于在 B 上执行代码（我对这类服务行为的了解，没有实测）。**所以屏蔽调试端口并整进程排除带调试参数的进程**（§5.7） |
| 访问 A 的回环服务             | **不能**。同一分区里回环流量全部去了 B。相对现状（B 的标签页里 `localhost` 指 A）这是收紧                                                                                                                                                                                                                                |
| 访问 T3 自己的端口            | 不能（§5.6），页面连不上 B 的 T3 API、隧道口、桌面内置 server 的其他回环口                                                                                                                                                                                                                                               |
| 读 A 的文件、剪贴板           | 与网关无关，沿用预览的现有权限（`ALLOWED_PREVIEW_PERMISSIONS`）                                                                                                                                                                                                                                                          |

### 6.2 DNS rebinding

- A 端：只有回环名（含 `*.localhost`）和回环 IP 字面量会到代理，Chromium 自己判定，不经 DNS。代理再校验一遍（`packages/shared` 里同一个判定函数），非回环一律 403。`evil.com` 解析到 127.0.0.1 的重绑定页面，其请求直连 A（现状如此，实测见 `direct.test`），不经过我们。
- B 端：只拨复核得到的 `127.0.0.1`/`::1` 字面量，不解析名字；目标只有端口号。
- 页面的 `Host` 头原样转发，是它自己的请求，不构成越权。

### 6.3 转发出来的连接在 B 上看起来来自回环地址

会。B 上的程序看到的对端是 `127.0.0.1`，可能因此放宽检查：免认证的调试接口、`allowedHosts` 里放行 localhost 的 dev server、只信任回环的管理端点。这就是 §6.1 说的风险面。缓解叠加：只许可有主端口；屏蔽调试端口并整进程排除调试进程；`Host` 和 `Origin` 头保持原样（程序仍能拒绝它不认的）；功能本身只在用户明确打开这个标签页时才有流量。记入文档："转发进来的连接对 B 上的程序看起来是本机访问"。

### 6.4 cookie 隔离

分区按环境隔离（§2）。同一环境内 `localhost` 的 cookie 不分端口（浏览器的通用行为，与在本机开发一样）。不同环境之间、与本机环境之间互不可见。B 的 T3 自己的会话 cookie 在这个分区里不存在（T3 的页面不在预览分区里加载）。

### 6.5 票据泄露后的影响范围

持票者（5 分钟内，需要能到达 B 的加密或本机地址）可以：对 B 上有主、未排除、复核通过的端口开隧道，上限 64 条并发，速率受限。不能：调用 RPC（要 DPoP）、读文件、用终端、碰 T3 自己的端口。撤销会话后立即失效。票据只在 A 主进程内存中，不在任何 URL 或日志里（§4.3）。

### 6.6 其他

- A 端代理被本机其他进程利用：需要口令，只能得到 407（§4.7）。
- B 端被未认证请求打：路由要求严格 audience 的票据、拒绝带 `Origin` 的请求、拒绝 query 里的 `wsTicket`；票据校验失败不进数据库以外的任何地方。
- 日志泄露：§4.3 的测试保证。
- 端口是否有程序在监听（已接受的侧信道）：端口没人认领时，拒绝原因区分"没有程序在监听"（`upstream-refused`）和"别人的程序占着"（`not-owned`），页面能借此探测 B 上哪些回环端口有服务。接受的理由：能用网关的会话必须同时有 `preview:operate` 和 `terminal:operate`，有 `terminal:operate` 本来就能在 B 上开终端自己跑 `lsof`，这个区分没有比这个权限多泄露什么。同一条理由也覆盖读取提名的进程被排除时的原因：`reserved`、`debug-process` 照实返回，不为了"没被快照认作有主"而改写成 `not-owned`（§5.3）。这次读取（`PortAuthorizer` 的 `readListeners`）只提名，放不放行仍全部来自 C0–C3 的现场核对；每台 server 每 `RESCAN_MIN_INTERVAL_MS` 最多读一次，同一时间到达、同一端口的请求共用这一次，间隔内别的端口和读取失败都回到 `not-owned`。

### 6.7 页面对 dev server "完整网络接口"的访问（GPT P1-6）

转发的是原始 TCP 字节，Host、Origin、路径都原样到 B。所以网关给标签页里的页面的不只是"一个网页"，而是**有主服务的完整网络接口**：

- Vite 的 `/@fs/`（读 `server.fs.allow` 范围内的任意文件）、`/@id/`、`/@vite/`、source map、`/__open-in-editor` 一类开发端点；Next、webpack-dev-server 的类似开发端点；用户自己的开发 API（带副作用的 POST、管理接口）。
- 暴露程度**等同于本机 dev server 对本机浏览器里的页面**：同样的 Host、同样的 Origin、同样的服务自己的 CORS 和 `allowedHosts` 策略。网关不放宽也不收紧这些策略；具体能不能读到，取决于该 dev server 版本的默认值（早期 Vite 默认对所有来源开放 CORS，较新的版本限制 `Host` 和跨源读取）。这是 dev server 本身的属性，不是网关引入的。
- 网关引入的变化是**页面所在的位置**：本来在 A 上的页面现在能碰到 B 上的服务。所以"这个标签页里加载了什么"变成了安全问题：用户在 B 的对话标签页里导航到外部网站，那个网站的脚本能对 B 上有主的 dev server 发请求。缓解见 6.1：许可范围、调试端口、整进程排除；文档要明说"别在转发的标签页里打开不信任的网站"。

**验收用例（2026-11-07 做完，`vp run fork:loopback-gateway:electron-smoke` 的 29 个场景里有 5 个是它们，连跑两遍全过；用例 2 由 server 测试覆盖）：**

用的是同一个假网关（`fakeGateway.testkit.ts`）、真实 Electron 和真实回环夹具，`--host-resolver-rules` 把 `direct.test`、`rebind.test`、`localhost.localdomain` 映射到 127.0.0.1。"直连"一组用一个没装代理的 session 对照。

1. **外部来源的页面读不到 `/@fs/`（冒烟，通过）：** 夹具模拟 Vite 的 `/@fs/…`：`Host` 必须是 `localhost:<端口>`，只对同源 `Origin` 返回 CORS 头。同源页面读到内容；`direct.test` 上的页面跨源 `fetch` 被拒（`TypeError`，请求到了夹具，但没有 `Access-Control-Allow-Origin`）；`http://127.0.0.1:<端口>/` 页面的请求得 403（`Host` 没被改成 `localhost`）。网关和直连两组，夹具收到的 `Host`、`Origin` 值**逐字节相同**（同源 GET 没有 `Origin`，跨源是 `http://direct.test:<端口>`）；网关没有加 `X-Forwarded-*`、`Forwarded`、`Via`、`X-Real-IP`。头名的大小写会变（网关的代理按 Node 的小写头名转发），值不变。这测的是"网关不改变 dev server 能看到的头"，不是 Vite 本身。
2. **默认端口上的 Node inspect 被拒（server 测试，冒烟不做）：** `PortAuthorizer.test.ts`（9229 在有主的前提下仍被拒）和 `GatewayExclusions.test.ts`（`--inspect=0` 的 web 端口和随机检查器端口都被拒）用真实进程覆盖，macOS 和 Linux 都跑。
3. **`*.localhost`（冒烟，通过）：** `app.localhost` 和 `deep.app.localhost` 的 `resolveProxy` 是代理，页面加载、`location.origin` 不变，夹具看到各自的 `Host`，假网关看到隧道；`localhost.localdomain` 是 `DIRECT`，页面直连夹具，假网关没有新隧道。代理用的共享判定函数对两者的答案和 Chromium 一致。
4. **IPv4-mapped IPv6（冒烟，通过）：** `http://[::ffff:127.0.0.1]:P` 过代理。**Chromium 实际写出来的主机形式是 `[::ffff:7f00:1]`**（`location.host`，也是夹具收到的 `Host`）；代理判定接受这个形式。映射的公网地址（`[::ffff:8.8.8.8]`）是 `DIRECT`。限定：假网关只能看到隧道请求里的端口（协议只带端口），它拨的是硬编码的 `127.0.0.1`，所以这里能证明的是"页面的原始字符串没有进入隧道请求"，"B 端拨复核得到的地址"本身由 server 端的拨号测试保证。
5. **DNS rebinding（冒烟，通过）：** `rebind.test` 映射到 127.0.0.1。页面导航、同源 `fetch`、从被隧道的回环页面发出的跨源 `fetch` 都直连（夹具收到请求、`Host` 原样，假网关对这个端口开隧道 0 次）。直接对代理口发带正确 `Proxy-Authorization` 的请求：`rebind.test`、`localhost.localdomain`、`0.0.0.0`、`[::ffff:808:808]`、`127.0.0.1.rebind.test` 的绝对 URI 请求和 `CONNECT` 全部 403，隧道 0 次；对照：回环地址 200，没有口令 407。原来的"非回环主机直连"场景并入了这一条。
6. **source map（冒烟，通过）：** 夹具提供带 `sourcesContent` 的 `.map`，规则同 1：同源读到，`direct.test` 页面跨源读不到，`Host`、`Origin` 与直连逐字节相同。

**测试本身有效的证据（反例）：** 三处临时改坏产品代码，各跑一遍完整冒烟，改回后 `git diff` 为空。Chromium 的代理规则改成 `<-loopback>`（非回环主机也进代理）：4 个场景失败；代理的主机判定改成对任何主机都接受：DNS rebinding 场景失败（`rebind.test` 经 HTTP 得 200）；代理改写 `Host` 并删掉 `Origin`：`/@fs/`、source map、`*.localhost` 三个场景失败。**还要人工走查的：** 真实 dev server（Vite 当前版本的默认 `server.fs`、`allowedHosts`、CORS）对外部来源的实际行为，这取决于它的版本和配置，冒烟里只有模拟的夹具。

### 6.8 Local Network Access（Chromium 152 / Electron 44.10.1）

要查的问题：公网站点的页面访问回环地址时，在预览分区里会发生什么，`ALLOWED_PREVIEW_PERMISSIONS` 怎么处理那个权限。

**读代码：** `BrowserSession.ts` 的权限请求处理器和检查处理器都用同一个集合 `ALLOWED_PREVIEW_PERMISSIONS` 作答，其中有 `"loopback-network"`（注释："Loopback requests already succeed in Electron 44; permission-aware sign-in widgets query first"），没有 `"local-network"`。

**实测**（`/tmp/t3x-gateway-design/spike/main5.cjs`，复制了上面的处理器，附录 A）：

- 页面里 `navigator.permissions.query` 的结果：`loopback-network` → `granted`，`local-network` → `denied`，`local-network-access` → `denied`。
- 一个标成公网地址空间的页面（用 `--ip-address-space-overrides` 把测试页的端口标为 `public`），对回环地址的跨源 `fetch`、`WebSocket`、带 `targetAddressSpace: "loopback"` 的 `fetch` **全部成功**。权限处理器只被**检查**过（`check`），**从未收到过权限请求**（`request`）。
- 走转发代理和直连的结果一样（A、B 对照）。
- 把处理器改成"对非回环来源拒绝 `loopback-network`"（`SPIKE_DENY=1`）后，查询结果变成 `denied`，但请求**仍然成功**。

**限定：** 我无法确认 Chromium 真的把测试页当成了公网地址空间（`document.addressSpace` 不存在，也没有可观察的信号），所以不能断言"LNA 一定不生效"，只能说"在这个设置下没有观察到拦截"。

**结论：** 设计不依赖 LNA 作为防线。`ALLOWED_PREVIEW_PERMISSIONS` 不动：改它会改变 `permissions.query` 的答案，上游注释说有登录控件会先查询。公网页面能不能读到转发后 B 上服务的内容，取决于那个服务自己的 CORS/Host 策略（6.7），和今天本机 dev server 一样。

## 7. 界面与文案

原则：地址栏不变；不新增常驻控件；用上游 `components/ui` 现有 variant；所有文案走 `t()` 并补 `zh-Hans` catalog（新文件 `catalogs/zh-Hans/loopbackGateway.ts`，术语按 `GLOSSARY.md`）；桌面主进程生成的 HTML 用 `translate(getUiLocale(), …)`（`BrowserSession.ts` 已有先例）。

### 7.1 转发标识

地址栏旁一个小图标（现有 `PreviewChromeRow` 里），在桌面运行时的远程环境标签页、当前 URL 的主机是回环名、并且网关**可用**（能力、路由、权限都满足，§8）时出现。两种状态，**两个方向都有**：

- **转发中（`active`）**：悬停提示"localhost 已转发到 {environment}"。点开是小菜单（现有 Menu 组件）：「在 {environment} 的浏览器中打开」（上游已有动作，复用）、「停止转发，使用这台电脑的 localhost」。
- **已被用户关闭（`disabled-by-user`）**：同一个位置显示灰色的同一个图标，悬停提示"localhost 的转发已关闭，这里的 localhost 指这台电脑"。点开菜单只有「恢复转发」。不能因为关闭了就让标识消失：那会让"停止转发"成为没有退路的单向门（GPT P2-2）。

**实现（9.3）：** 标识是 `PreviewChromeRow` 的一个新 prop `gatewayBadge`，放在地址栏之前、`leadingActions` 之后，由 fork 的 `useLoopbackGatewayTab`（`apps/web/src/fork/loopbackGateway/`）生成，`PreviewView` 只负责摆放。图标是静态的 `ArrowLeftRight`，`disabled-by-user` 时颜色减淡。只在桌面渲染的标签页（不是服务端运行时的标签页，那里 `localhost` 本来就是 B）、当前 URL 的主机是回环名、状态是 `active` 或 `disabled-by-user` 时出现；"在 {environment} 的浏览器中打开"只在上游的 `moveTarget === "server"` 时有。菜单底部一行说明：转发对该环境所有标签页生效、不能只关某一个；转发开着时，这些标签页里的外部网站直接连接，不经过系统代理。

「按环境生效」要明说（主控 Q7）：悬停提示和菜单项的说明里写"对 {environment} 的所有标签页生效"；用户文档里同样写明，不支持单个标签页关闭。

### 7.2 错误卡片

加载失败时上游画 `PreviewUnreachable`（带「在 X 的浏览器中打开」，来自 #17316）。我们给它加一个 `reason`，根据主进程发来的 `gatewayDenied` 事件（以及 B 离线、旧版、明文链路等状态）换文案，不新做页面：

| 情形                                                                                                                                                                | 标题 / 说明                                                                                                                                         | 操作                                           |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 端口不是 T3 起的（`not-owned`）                                                                                                                                     | 「这个端口不是 T3 起的服务」「{environment} 只转发它的终端和 agent 启动的服务。」                                                                   | 在 {environment} 的浏览器中打开                |
| 端口被保留（`reserved`，T3 自己的或屏蔽的调试端口）                                                                                                                 | 「这个端口不能转发」                                                                                                                                | 同上                                           |
| 进程带调试参数（`debug-process`）                                                                                                                                   | 「这个服务带着调试参数运行，不能转发」「去掉 `--inspect` 一类参数后重启，或者在 {environment} 的浏览器中打开。」                                    | 同上                                           |
| 监听者变了（`owner-changed`）                                                                                                                                       | 「这个端口的服务刚刚变了」「重试。」                                                                                                                | 重试                                           |
| 没有程序在监听（`upstream-refused`）                                                                                                                                | 「{environment} 上没有程序监听 {port}」「服务启动后重试。」                                                                                         | 重试                                           |
| B 离线 / 不可达（`offline`）                                                                                                                                        | 「连不上 {environment}」                                                                                                                            | 重试                                           |
| 权限不够（`forbidden`）                                                                                                                                             | 「这个连接没有转发权限」「需要预览和终端权限。」                                                                                                    | —                                              |
| B 是不支持网关的旧版或上游版（`unsupported-server`）                                                                                                                | 「{environment} 的 T3 版本不支持转发 localhost」「更新它，或者在它的浏览器中打开。」                                                                | 在 {environment} 的浏览器中打开                |
| 明文局域网链路（`unsupported-route` / `insecure-transport`）                                                                                                        | 「这个连接没有加密，不转发 localhost」「用 https、Tailscale（MagicDNS 名字）或 SSH 连接 {environment}，或者在它的浏览器中打开。」                   | 在 {environment} 的浏览器中打开                |
| 明文 Tailscale IPv4 地址（`insecure-transport`，`hint: "tailscale-address"`）                                                                                       | 「这个连接没有加密，不转发 localhost」「这看起来是 Tailscale 的 IP 地址。请改用它的 MagicDNS 名字（`*.ts.net`）或 HTTPS，或者在它的浏览器中打开。」 | 在 {environment} 的浏览器中打开                |
| 证书不受信任（`tls-untrusted`：过期、自签名、主机名不符、私有 CA）                                                                                                  | 「{environment} 的证书不受信任」「这台电脑没有信任它的证书（私有 CA 暂不支持）。请使用公共 CA 的证书或 Tailscale，或者在它的浏览器中打开。」        | 在 {environment} 的浏览器中打开                |
| 转发是 `active` 但 `register` 失败（`start-failed`，9.3 第三轮加）                                                                                                  | 「无法启动 localhost 转发」「到 {environment} 的转发没能启动，所以这个标签页保持关闭。请重试，或改用这台电脑的 localhost。」                        | 「重试」「停止转发，使用这台电脑的 localhost」 |
| 本机记得 B 上次在转发，A 已有这个标签页但 B 连不上（`waiting`，9.3 加）。A 重启时 B 离线则 A 没有标签页，面板只显示\"连不上 {environment}，连上后浏览器预览会恢复\" | 「连不上 {environment}」「连上后这个标签页会自动打开。」                                                                                            | 「停止转发，使用这台电脑的 localhost」         |
| 经 T3 Connect 中继（`unsupported-route` / `relay`）                                                                                                                 | 「通过 T3 Connect 的连接不支持转发 localhost」                                                                                                      | 同上                                           |
| 端口发现关闭（`discovery-disabled`）                                                                                                                                | 「{environment} 关闭了端口发现」                                                                                                                    | 同上                                           |
| 达到上限（`limit-reached` / `rate-limited`）                                                                                                                        | 「转发的连接太多」                                                                                                                                  | 重试                                           |

**实现（9.3）：** 卡片仍是 `PreviewUnreachable`，加了一个 `gateway: { title, description }` 可选 prop（有它时标题和说明换成这里的文字，隐藏通用的"Details"排查列表，错误标签显示原因码，「重新加载」保留；「在 {environment} 的浏览器中打开」只在上表标了它的情形出现，并且要上游的 `moveTarget === "server"`）。文案和选择逻辑在 fork 的 `gatewayCard.ts`（纯函数，表格测试）。两条来源：主进程的 `denied` 事件，和"页面加载失败 + 回环主机 + 状态不是 `active`"。`mainFrame` 的 `denied` 带 `webContentsId`，渲染进程在内存里按 `webContentsId` 对到标签页（manager 订阅一次 `previewBridge.onStateChange`），一次拒绝只属于那个标签页**最近一次加载**：标签页开始新一次加载时旧拒绝即作废，用递增序号比较，没有时钟。新标签页的来宾一挂上就开始加载，标签页要等主进程登记它之后才知道它，所以登记前到达的拒绝（来宾没有对应的标签页）记为"未绑定"，标签页第一次绑到这个来宾时按"这次加载引起的"算，只算一次，不会因为随后才上报的"开始加载"而被当成更早的加载。`CONNECT` 被拒（https、ws，没有页面）按 `(环境, 端口)` 匹配同一规则。`not-owned` 的说明写明：端口不是 T3 终端或 agent 起的，或者服务已经脱离了启动它的终端或 agent（例如用 nohup 放到后台），建议改在 T3 的终端里启动。`unauthorized` 显示"正在重新连接…"，拿到票据后自动重载一次（§7.3）。

"不支持"和"明文"这几行没有主进程事件（没装代理，Chromium 直接连 A 的 `localhost` 被拒）。这时 `PreviewUnreachable` 的 fork 钩子看"远程环境 + 回环主机 + 网关状态不是 active"，按状态换成对应的说明。

**已知限制（第三轮复核 P2）：** 同一环境同一端口有两个标签页同时加载失败时，没有 `webContentsId` 的 `CONNECT` 拒绝（https、ws）只有一条 `(环境, 端口)` 记录，后到的拒绝原因可能被两个失败的标签页一起拿来解释（例如一个标签页是普通网络错误，却显示另一个的拒绝码）。已加载的页面不受影响：`CONNECT` 拒绝只解释自己加载失败的标签页。要严格做到"只解释本标签页"需要主进程给连接带上可归属的加载批次，现在不做。

### 7.3 票据自动续期

用户感觉不到：续期在渲染进程里提前做（§4.2）；刚过期的短窗口里，新连接的错误卡片显示"正在重新连接…"并在拿到票据后自动重载一次主框架（只在卡片是因为 401 出现时）。**实现（9.3）：** 续期时机是纯函数 `planTicketRenewal({ now, receivedAt, expiresAt })`，剩 40% 时续。**一切都按本机时钟算**（修复轮改，原先用服务端的 `expiresAt` 减本机收票时刻，A 比 B 快超过票据寿命时寿命 ≤ 0，续期被最短间隔挡掉后没有定时器，成为死路）：`localTicketExpiry` 把服务端的 `expiresAt − 收到时刻` 当作寿命，夹在 30 秒到 5 分钟之间；`≤ 0` 只可能是时钟偏差（刚签出的票不会已过期），按名义寿命 5 分钟（服务端 WebSocket 票据的默认寿命）算。**交给桥的 `expiresAt` 是本机时钟下的到期时刻**，不是服务端给的值：9.2 的主进程只用它排\"剩 60 秒提醒\"，从不拿它判断票是否有效（那是 B 的事，过期就回 401），所以时钟偏差不会让主进程的提醒立刻触发，也不用改 `apps/desktop`。**节流不吞续期：** 取票被最短间隔（3 秒）或失败冷却（10 秒）挡住时，在窗口结束的时刻排一个一次性定时器（每个环境同一时间只有一个定时器，同时承担下一次续期），不轮询；续期失败时，只要手里的票还没到期就每 10 秒重试，到期后不再自己重试，由主进程的 `ticket-needed` 触发。

### 7.4 i18n 工作量

约 25 条新文案，一个 catalog 文件，`vp run i18n:report` 必须 0 missing / 0 stale，`i18n.test.ts` 通过。需要截图验收：中英文各一张的转发标识和三种错误卡片，守住上游风格（见记忆：UI 审美要求）。

## 8. 能力探测与退路

五道门，全部满足才启用，任何一道不满足都**保持现有行为**：

1. **运行时**：`window.desktopBridge?.preview` 存在（桌面版）。网页和手机不进入。
2. **环境**：非主环境，且不满足 `reachesEnvironmentLoopback`（WSL 等不需要）。
3. **能力**：`environment.capabilities.loopbackGateway === true`。读取方式照 `readEnvironmentSupportsServerBrowser`（`apps/web/src/state/entities.ts:349`），在 `apps/web/src/fork/loopbackGateway/capability.ts` 里写一个同样的读取函数，不改上游。服务端在 `ServerEnvironment.ts:279` 旁加一行（`T3CODE_PORT_DISCOVERY=0` 时不加）；契约在 `environment.ts:156` 旁加一行 `optionalKey`，老服务端不发这个字段，客户端读到 `false`。 服务端只在 macOS 的 B 上广告；Windows 的 B 不广告，Linux 在容器里的真实进程测试通过前不广告（§5.3、§5.6.5）。
4. **连接**：连接目标不是中继；`httpBaseUrl` 通过 §4.6 的传输检查（`https:`、回环、Tailscale 的 `*.ts.net` 与 `fd7a:115c:a1e0::/48`；明文 `100.x` 不通过）。
5. **权限与用户意愿**：会话有两个 scope（`permissionAtom`）；用户没有在这个环境上关闭转发（§10）。

这些组合成状态：`active | unsupported-server | unsupported-route(relay | insecure-transport) | no-permission | disabled-by-user | not-applicable`，**外加 9.3 实现时多出的 `unknown`**：能力位（服务器配置还没加载）、路由（还没有准备好的连接）或权限（会话状态还没加载）任何一个还不知道时的答案，只给"重启后的 webview 门"用（§2.3），不显示给用户。**第一个不满足的门决定答案**，顺序是：运行时 → 本机环境 → 能力 → 路由（先中继，再传输检查；`invalid-url` 当作 `not-applicable`）→ 权限 → 用户关闭。用户的开关放在最后，所以"已被用户关闭"只出现在重新打开确实能用的时候；一个已经知道不支持的门不会被还没加载的后面的输入盖住（旧版 B 加路由未知，答案是 `unsupported-server`）。`resolveDiscoveredServerUrl` 只在 `active` 时对回环 URL 原样放行；其他状态走原逻辑（私网改写成环境 IP、公网回退）。这样上游版本的 B、明文局域网和关闭转发的用户完全不受影响，「在 B 的浏览器中打开」始终存在。

状态是一个纯函数：输入（运行时、环境类别、能力位、连接目标、`httpBaseUrl`、scope、用户设置），输出状态。表格测试覆盖每道门单独失败和多道同时失败时的优先级。

## 9. 入口逐个决定

关键事实：拦截发生在**分区的网络层**，不在 URL 层。所以只要标签页是桌面运行时、环境是远程、网关 `active`，无论 URL 怎么进入，`localhost:5173` 都会被转发。URL 层要做的只有一件事：别把 `localhost` 改写掉。

| 入口                                                                                                          | 现状                                                                                               | 决定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 地址栏输入                                                                                                    | `handleSubmitUrl` 直接导航，不经 resolver，今天连到 A 的 `localhost`                               | 不改。网关生效后自然可用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| 端口列表（`ThreadServersPanel`、`PreviewLocalServerCard`、`useDiscoveredLocalServers`、`openDiscoveredPort`） | 经 `resolveDiscoveredServerUrl`，私网会被改写成环境 IP，公网回退                                   | `resolveDiscoveredServerUrl` 在 `active` 时原样放行（上游 +8 行）。显示用的 URL 和导航用的 URL 都是 `http://localhost:5173`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 终端链接（`openTerminalLinkInPreview`）                                                                       | Vite 打印的 `http://localhost:5173/` 直接作为 `url` 打开桌面标签页，不经 resolver，今天连不上      | 不改，自动可用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 「在这台电脑上打开」（`PreviewView` 的 `moveTarget === "desktop"`，约 386–410 行）                            | 调 `resolveDiscoveredServerUrl`                                                                    | 同上，`active` 时得到 `localhost` URL，网关生效                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| 「在 {environment} 的浏览器中打开」                                                                           | 切到服务端运行时（B 上的无头 Chrome，推流）                                                        | 保留，作为不允许转发时的退路和所有错误卡片上的按钮。**观察（9.4，上游行为，阶段 9 不改）：** 服务端浏览器第一次使用时要从 `storage.googleapis.com` 下载约 104 MB 的 `chrome-headless-shell`（`apps/server/src/preview/PreviewBrowser.ts:88`），调用方每次只等 45 秒（`:172`），下载完成前界面一直显示“正在连接”；基线 `12ece4aefa` 上相同，证据 `/tmp/t3x-p94e/results.md`。装好之后 3 到 5 秒出画面                                                                                                                                                                                                                                                                                                                                                 |
| 系统浏览器（`FooterPorts.tsx:95`、`ThreadServersPanel.tsx:85` 的 Cmd-click）                                  | `shell.openExternal(resolveDiscoveredServerUrl(…))`                                                | **保持原行为**（系统浏览器不受网关影响）：`resolveDiscoveredServerUrl` 加一个 `{ systemBrowser: true }` 选项，这两处调用点各改一行，行为与今天完全相同（9.3 已做：`ThreadServersPanel.tsx` 与 fork 的 `FooterPorts.tsx`；有测试逐状态断言带这个选项时永远走原逻辑）。`active` 时 `0.0.0.0`、`[::]` 在 resolver 里按显示规则改成 `localhost`（`displayUrlForUnspecified`，只用于已知的预览 URL，不参与安全判断）。`PreviewView.handleOpenInBrowser` 把标签页当前 URL 原样交给系统浏览器，那里的 `localhost` 是这台电脑，和转发中的标签页里 B 的页面不是一个东西，所以转发中的标签页（`active` 且当前 URL 的主机是回环名，即标识出现的条件，`badgeModeFor`）不显示「在系统浏览器中打开」；`disabled-by-user` 时标签页里本来就是 A 本机的页面，照常显示 |
| 项目脚本的 `autoOpenPreview`（`useChatTerminalActions`）                                                      | 经 resolver                                                                                        | 同端口列表，`active` 时直接是 `localhost`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 命令面板                                                                                                      | 现有的打开链接和浏览器命令都落到上面这些路径                                                       | 不新增命令。转发开关放在标识的菜单里（§7.1）。如果主控想要面板里也有，是一条 fork 命令，成本很低但属于范围扩大，主控已定不加（Q6）；标识的「恢复转发」是必须有的反向入口，不是命令                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 重启后恢复的标签页                                                                                            | B 进程在内存里保存会话，打开对话时重新取回并挂 webview；B 重启后列表为空，标签页不回来（上游行为） | 靠 §2.3 的"网关已登记"门（实际放在 `AuthorizedBrowserWebview`，要等该环境连上，见 §2.3）；不持久化转发状态，只持久化"用户对哪些环境关闭了转发"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| agent 用 `preview_open` / `preview_navigate` 打开标签页                                                       | 见下                                                                                               | **不涉及网关**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

关于最后一行，我查到的事实：远程环境上 agent 打开的标签页用**服务端运行时**（B 上的无头 Chrome，画面推流），`localhost` 本来就指 B。证据：`previewRuntimeFor` 对 `serverBrowser` 的环境返回 `"server"`；上游在 #16827 的关闭说明里写明"desktop now opens remote-environment browser tabs locally for user-opened tabs. Agent-opened tabs and web/mobile clients still stream."；`DesktopBrowserChannel` 是桌面应用和**它自己内置 server** 之间的 fd 通道（`ServerConfig.desktopBrowserFd`），不连别的环境；`apps/web/src` 里没有 B 的 agent 去驱动 A 桌面 webview 的 automation host 代码。所以"B 的 agent 在 A 桌面渲染的标签页里操作"在这个代码库里不存在，网关不需要也不应该处理它。我没有端到端验证这一点（没有启动应用），9.3 的手动检查里加一条：在远程对话让 agent 打开 `localhost:5173`，确认它是服务端标签页。

## 10. 反向状态

每个"进"都有"出"，也都有办法看到当前状态（AGENTS.md 的"反向状态"一条）。

| 想要                              | 办法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 这个环境不再转发                  | 标识菜单「停止转发，使用这台电脑的 localhost」。写入本机设备级 store（`apps/web/src/fork/loopbackGateway/disabledStore.ts`，localStorage 键 `t3extend:loopback-gateway:v1`，写法沿用 `sidebarViewStore.ts`，不进 `ClientSettings`、不改 contracts）。渲染进程的控制器随之对该环境再调一次 `register({ enabled: false })`（开关两个方向都走 `register`，不另用 `setEnabled`）。主进程把该环境所有已登记分区改回 `{ mode: "direct" }`，`closeAllConnections()`，并**关闭该环境所有已建立的隧道**（不是等它们自然结束）。标识**留在原处**变成灰色（`disabled-by-user`，§7.1） |
| 恢复转发                          | 灰色标识的菜单只有一项「恢复转发」，清掉 store 里的关闭记录，状态回到 `active`（若其他门仍满足），主进程重新装代理。入口和出口对称                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 作用范围                          | **按环境生效**（主控 Q7）：这个环境的所有标签页、所有 profile 一起。标识的悬停提示、菜单项说明、用户文档都写明这一点                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| 某个标签页单独不转发              | **做不到，也不做**：代理是 session 级的，一个环境的所有标签页共用。需要 A 的 `localhost` 时：系统浏览器，或本机环境对话里的标签页。写进用户文档                                                                                                                                                                                                                                                                                                                                                                                                                            |
| 环境断开                          | 渲染进程把状态置 `offline` 推给主进程；之后的新请求得到 `offline` 错误页。**已建立的隧道不受 RPC 连接影响**（它们是独立的 WebSocket），只在 B 或网络真断、或会话失效（§4.8）时才断                                                                                                                                                                                                                                                                                                                                                                                         |
| 环境重连                          | 渲染进程重新取票据、推给主进程、状态回 `active`。页面可能需要手动刷新；Vite HMR 会自己恢复                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 票据过期                          | 票据只在**升级那一刻**检查。已建立的隧道不受影响；新隧道在续期失败时得到 401，错误卡片显示"正在重新连接…"（§7.3）。会话被撤销时才会断已建立的隧道（§4.8）                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 路由切换（局域网 → 隧道）         | 渲染进程订阅连接的 `httpBaseUrl`，变化时把新的 `{ baseUrl, ticket }` 一对推给主进程（连接目标在安装票据时固定，连接建立后不会切到另一个地址，§3.6）；每次都**重跑传输检查**（§4.6）并**换用新票据**。新地址通过：旧隧道自然结束，新连接走新地址。新地址不通过（例如切到明文局域网）：状态变 `unsupported-route`，主进程拆代理、改回直连，并关闭该环境所有已建立的隧道，不让旧加密链路上的隧道继续用                                                                                                                                                                        |
| 设备被移除 / 会话被撤销           | 服务端关闭隧道（§4.8）；A 端看到隧道断开，之后的升级得到 401，状态变 `no-permission`；用户重新配对后恢复                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| 应用重启                          | 代理、口令、票据都不持久化。启动后打开对话时从 B 取回标签页，webview 等"网关已登记"（本地 IPC）和该环境的转发状态确定（要连上 B）；B 离线时 A 没有标签页可挂；主进程以 `pending` 状态先装好代理，没有票据时回 503，非回环流量不受影响；渲染进程连上 B 后取票据变 `active`。持久化的只有"用户对哪些环境关闭了转发"（环境从应用里移除时，这份和下一份记录一起删掉）和"哪些环境上次是 `active`"（后者只用来在 B 连不上时让恢复的标签页不去加载 A 的 localhost，§2.3）                                                                                                         |
| B 升级成支持的版本 / 降级成不支持 | 能力来自服务器配置，随连接更新；`active` 与否变化时安装器装上或拆掉代理                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

## 11. 性能

- **不轮询。** 票据续期是一次性定时器；端口许可靠现有快照，未命中至多每 2 秒触发一次扫描；没有新增订阅。
- **不按请求扫描整机，也没有缓存。** 每条新隧道都经过一次现场核对（§5.3），同时到达的隧道合成一批、共用一套读取（批量核对，不是缓存）。核对耗时（macOS，真实进程，本机约 1,050 到 1,070 个进程，同一方法，同一端口，毫秒）：

  | 并发 | 改前中位数 | 改前 p95 | 改后中位数 | 改后 p95 |
  | ---- | ---------- | -------- | ---------- | -------- |
  | 1    | 228        | 272      | 175        | 223      |
  | 6    | 355        | 415      | 185        | 230      |
  | 32   | 1,394      | 1,572    | 175        | 197      |

  样本数：改前 60/120/256，改后相同。并发 6（页面冷启动）的 p95 从 415 降到 230，低于 300 毫秒的目标。改后的并发 1 比改前快，是因为进程表和 `lsof` 现在并行读（改前串行），加上收集窗口多等的 10 毫秒仍然更快。单次核对的耗时分解见 §5.3。Linux 容器的核对耗时没测：Apple Silicon 上的 x86 容器是模拟运行，数字没有意义；Linux 的广告函数没有改。

- **连接复用。** A→B 每个端口有 keep-alive 池；实测 Chromium→代理本身复用良好。
- **B 端零 HTTP 解析。** 隧道是字节管道，没有逐请求的 Effect `HttpClient` 开销（#8841 的路径是逐请求）。
- 没有持续重绘的动画；标识是静态图标。

### 11.1 经隧道的模块图抓取时间（9.4 实测，无浏览器的代理指标）

**这不是浏览器首屏。** 原定办法是在 Electron 里开 Vite，读 `performance` 条目；这里测的是无浏览器下抓取一个 300 个模块的模块图所花的时间：没有 HTML、没有模块解析和执行、没有 `DOMContentLoaded`、没有 LCP、没有 Vite 客户端、没有真实 Chromium 的连接行为。它只是个对比网络路径的代理指标，不能当作用户看到的首屏时间。

`vp run fork:selfhost:first-paint`（即 `node scripts/fork-selfhost-e2e.ts --only 1,2,4,17`，场景 17；默认的 `fork:selfhost:e2e` 不跑它，脚本名沿用原来的叫法）。B 的 T3 终端里起一个夹具服务（`scripts/fork-selfhost-e2e/gateway-fixture.mjs`），`/m/0.js` 是入口，共 300 个模块（每个约 4 KB，入口引 20 个，这 20 个再引其余 279 个）；客户端按广度优先、最多 6 条 HTTP/1.1 连接取完整张图，走桌面代理模块（纯 Node，没有 Electron）。没有保存文件到热更新的延迟，用 WebSocket 回显的往返代替。每一轮都新建一个网关环境，也就是冷的：还没有任何隧道。

延迟注入：A 与 Caddy 之间一个只监听回环的 Node TCP 中继，每个方向加半个往返，连接建立时多等一个往返（模拟 TCP 握手），TLS 原样穿过；不动系统网络设置。为了分清"往返本身的代价"和"网关的代价"，每个延迟另测一组"没有网关，直连服务"，同样经过这个中继。

**结果**（macOS，Docker 栈，机器负载 9 左右；2026-11-07 修掉 `TunnelSocket` 的监听器累积之后重测，中位数 / p95，毫秒）：

| 路径                           | 轮数 | 首个响应  | 整张图        | 每次加载的隧道数 | 隧道建立  | WebSocket 回显（中位数） |
| ------------------------------ | ---- | --------- | ------------- | ---------------- | --------- | ------------------------ |
| 直连回环（无代理、无网关）     | 20   | 0 / 1     | 7 / 13        | -                | -         | -                        |
| 网关到 B 自己的端口（同机）    | 20   | 197 / 243 | 408 / 462     | 6                | 199 / 230 | 0                        |
| 自建隧道（Caddy + frps，本机） | 20   | 202 / 220 | 447 / 509     | 6                | 213 / 253 | 1                        |
| 无网关，直连服务，50 ms 往返   | 10   | 77 / 80   | 2,698 / 2,710 | -                | -         | -                        |
| 自建隧道，50 ms 往返           | 10   | 395 / 538 | 3,468 / 3,540 | 6                | 339 / 387 | 54                       |
| 无网关，直连服务，100 ms 往返  | 10   | 152 / 154 | 5,309 / 5,323 | -                | -         | -                        |
| 自建隧道，100 ms 往返          | 10   | 567 / 736 | 6,212 / 6,580 | 6                | 462 / 786 | 104                      |

B 的现场核对（`LoopbackGateway.authorize` 的 span，B 的本地 trace 文件，420 个）：中位数 196.4 ms，p95 244.4 ms。原始输出：`/tmp/t3x-p94a/first-paint-rerun.md`（一次运行，没有重复整组）。

**判据（主控定，2026-11-07）：同样往返下，经隧道比直连服务多出多少。** 旧写法是"50 ms 往返时比同机网关慢 1.5 秒，或每条新隧道超过 3 个往返"，它把网络往返本身的代价算进了网关。现在的数：

- 50 ms 往返：多出约 0.77 秒（3,468 对 2,698）。100 ms 往返：多出约 0.90 秒（6,212 对 5,309）。另跑一次（改完场景输出之后）得 0.73 秒和 0.89 秒，一次运行之间的差别在 0.05 秒左右。
- 多出的部分是冷隧道的建立：入口模块要等第一条隧道（50 ms 下首个响应晚约 318 ms），之后一级 20 个模块需要再开 5 条，又等一次。
- 一条隧道的建立在本机约 200 毫秒，几乎全是 B 的现场核对（`ps` 加 `lsof`，§5.3）；去掉它，50 ms 往返下约 2.9 个往返，100 ms 下约 2.7 个，接近 TCP、TLS、WebSocket 升级各一个往返的下限。
- 剩下的 2.7 秒（50 ms）和 5.3 秒（100 ms）是 300 个模块在 6 条连接上逐个取的往返，没有网关也一样。热更新消息的往返是一个往返（54、104 ms），网关没有加东西。

**决定：阶段 9 不做预开隧道。** 预开最多省掉第二次建隧道，约 0.3 秒；多路复用省不掉大头，因为瓶颈是 6 条连接上的逐个往返。真正占份额的是现场核对的约 196 毫秒，它是安全检查，不是预开能去掉的。等 Electron 真实网络走查时，用户觉得慢再看。没有为现在的数字另定阈值。

没测到的：真实 Chromium 对代理的连接数和重试行为、Vite 的 `/@vite/client` 与依赖预构建、热更新端到端。这些留给 9.4 的 Electron 人工验收。

## 12. 分阶段计划

流程同前几阶段：独立 worktree 实现 → 测试与 review 并行 → 修复 → `--no-ff` 合入。每阶段的验收都包含它自己的安全验收。测试放在"在 main 上会失败的最低一层"，遵守 AGENTS.md：不用 sleep/超时/轮询，用 `Deferred`、`Queue`、`drain`、`TestClock`。

**没有独立的 9.0（主控第 13 条）：** 9.1 的第一道关是监听点与运行时进程的逐项落实（§5.6.0），关口之后的第一步是 B 端的技术前提；A 端的技术前提是 9.2 的第一步；失败就停下回报，不继续往下做。严格 audience、票据不进日志、`login` 条件、撤销竞速、TOCTOU 是 9.1 和 9.2 的**验收项**，不是 spike。

### 9.1 server 网关（M+）

**第 0 关（开工关口：两项都过了，才开始写网关路由的代码）。** 拿不准的条目一律排除，不放行；关口的产出和代码一起提交，结果写回本文 §5.6。

- **关口 A：监听点清单逐项落实**（§5.6.0、§5.6.1）：`LocalDeviceHost` 的 hub 与守护进程、provider 的 OAuth 和回调、Muse、资源监视器、`CodexManagedTokenBroker`（已读码确认非 TCP，补运行时测试）、受管端点连接器（第二版漏了的 cloudflared 指标监听），以及其余所有 `ChildProcess.make`/`spawn(` 调用点中长期运行的。每条一个记录：代码依据、是不是 TCP、属于哪个进程、处理方式、验证（读码或运行时测试）。能做运行时测试的就做（起真实的 server 层，provider 用测试用的假可执行文件，**不跑真实的 agent 回合，不碰真实 provider 凭据**）；产出 `exclusions.json`。
- **关口 B：provider 运行时的进程树与排除规则**（§5.6.2、§5.6.3，M2 按主控的设计变更做完）：逐个读启动代码和本机已安装的启动器，画出根与真正运行时；**不在 adapter 里登记**，改为每条隧道现读祖先链加 fork 里的特征表；测试保证每个驱动都在特征表或 `NO_SIGNATURE` 里。结果在 §5.6.0.1。
- 两项关口的产出要列出：哪些 provider 因此转发不了脱离父进程的后台作业，写进用户文档。
- 关口过不去的条目不阻塞其余部分，但这些条目对应的监听一律排除，并在 §5.6.5 列为残余风险。

**第一步（技术前提，关口之后，失败就停下回报）：** 在共享 `HttpRouter` 上加一条 `GET /api/loopback-gateway/tunnel` 升级路由，把 `request.upgrade` 的 Socket 对接到 `net.connect`。确认：主监听口和 `TunnelListener` 口都能用；背压（写慢的一端不会无限缓冲）；`awaitInvalidation` 竞速能关闭它，且 TCP 和 WS 两端都销毁。不行就改用 `ws` 的流接口，再不行回到本文重新设计传输层。第一步的原始输出放 `/tmp`，结论回写 §3.3。

范围（`apps/server/src/fork/loopbackGateway/`、`packages/contracts/src/forkLoopbackGateway.ts`、`packages/shared/src/forkLoopbackGateway/`）：

- 契约：RPC `loopbackGateway.issueTicket`、错误类型、能力位 `loopbackGateway`；`AuthWebSocketTicketUse` 加 `"loopback-gateway"`。
- **能力广告的条件：** `T3CODE_PORT_DISCOVERY` 不是 `0`，**且平台是 macOS**；Linux 在容器里的真实进程测试通过前不广告；Windows 不广告（§5.6.5）。
- 权限：`CLIENT_GUARDED_RPC_SCOPES` 展开 + `clientRpcRequiredScopes` 返回两个 scope；扩展权限行为测试。
- 隧道路由与认证函数 `authenticateGatewayTicket`（§4.4）、显式脱敏（入口立刻 `Redacted`，§4.3）。
- 端口许可、**每条隧道的现场核对（无缓存）**、`GatewayExclusions`、特征表（`RuntimeSignatures.ts`）、`TerminalShellRegistry`、监听点清单与防漂移测试（§5）。
- ~~各 adapter 启动点的运行时登记~~ 取消（M2，主控的设计变更）：不改任何 adapter 文件。
- 上限（§3.7 的 B 端项）。

验收：

- **严格 audience：** 没有 audience、`rpc`、`media`、其他值、篡改、过期、已撤销、MCP 客户端会话、缺 scope、错误方案（`Bearer`/`DPoP`）、query 里的 `wsTicket`、带 `Origin`：全部被拒；反向：网关票据（带 `jkt`）打 `/ws` 和媒体路由被 audience 拒绝，而不是被要求出示 DPoP 证明（`EnvironmentAuth.ts:1256` 先于 `:1261`）；没有 audience 的票据仍能打 `/ws`。
- **票据不进日志（§4.3，复核 P0-2）：** 收集 logger 和 tracer 的全部输出，覆盖成功和每一条失败路径（坏票据、错 audience、端口被拒、核对失败、拨号失败、隧道中途断开、撤销断开、处理器缺陷），`--log-ws-events` 开关各一遍，断言找不到哨兵票据及其长度 ≥ 12 的子串；守卫测试（真实 server 层里 `Headers.CurrentRedactedNames` 含 `authorization`，`TracerHeaderFilter` 对它返回 `false`，赋值点的静态扫描）。
- **自定义 `Authorization` 方案不被误用（复核 P2-1）：** 带 `Authorization: T3X-Gateway <票据>` 的请求打普通受保护路由、`/mcp`、`/oauth/token`、以及 `TunnelListener` 监听口上的同样几条，都不被当作会话凭据；连续多次错误票据打网关路由，`AuthAttemptLimiter` 的状态不变。
- 两个 scope 缺一不可；只读会话被拒。
- **现场核对（TOCTOU，§5.3）：** 有主进程退出后另一个进程绑到同一端口，**立即**被拒，没有 TTL 参与；身份读取可注入，C0 与 C3 之间启动时间变化被拒，读取失败被拒；agent 项标记被清被拒；终端项祖先链被打断被拒；同端口两个 pid 被拒；只绑 `::1` 和只绑 `127.0.0.1` 的服务各自连得上，通配绑定拨 `127.0.0.1`；同一端口一条接一条的 6 条隧道是 6 批读取、同时到达的 6 条是 1 批且各自判定（防止悄悄加缓存）；未命中重扫的 2 秒限流。
- **核对耗时实测（M2 已做）：** macOS 并发 1、6、32 的中位数与 p95 见 §11；Linux 容器一组没测（x86 容器在 Apple Silicon 上是模拟运行）；9.4 只跑了正确性（§12 9.4），Linux 的广告函数没有改。
- **排除（§5.6.4）：** 完整 server 自检；每种 provider 的假运行时（E2、E3 的正反例）；孤儿（启动器退出后遗留的运行时与带标记的作业被收养，不在 server 的树里，被拒；终端有主不受影响）；特征声明测试（`BUILT_IN_DRIVERS` 每个驱动都在特征表或 `NO_SIGNATURE` 里）；防漂移测试；带 `--inspect=0` 的进程的两个端口都被拒；屏蔽表 8 个端口（9222、9229、5858、5859、2375、2376、5005、5678）被拒。
- 能力广告：`T3CODE_PORT_DISCOVERY=0`、Windows、未验证的 Linux 都不广告，RPC 报 `discovery-disabled` 或 `unsupported-platform`。
- **撤销（§4.8）：** 会话被撤销、会话自然过期、设备移除后经 8.2 对账撤销，三条路径都验证已建立隧道的 TCP 和 WS 两端关闭；续期链；升级与撤销同时发生的竞速场景；**N1 的三个新增测试**（续期期间被盗的票据开出的隧道在撤销后关闭、续期链上撤销与升级同时发生、设备移除后整条会话链的每个活动行都被撤销且对应隧道都关闭）。
- 上限、速率、超大帧、背压、关闭传播：在 socket 层测。
- 主监听口和隧道监听口行为一致。
- 阶段结束时按实际 diff 重估上游改动行数（§13）；超过 130 行停下回报。

测试层：许可、排除、拨号选择、传输检查、命令输出解析是纯函数 → 单元测试（解析函数用记录的真实输出做夹具，所有平台都跑）；路由、撤销、上限、核对 → 起真实 server 层加真实 `ws` 客户端和真实回环服务（沿用 `TunnelListener.test.ts` 的 harness）和真实子进程；Linux 的真实进程测试在容器里跑；设备移除 → 8.2 的 `registryFake.testkit.ts` / `deviceHarness.testkit.ts`；权限表 → 契约行为测试。

### 9.2 桌面代理与分区（M+）

**第一步（前提，失败就停下回报）：** `http.Agent` 的 `createConnection` 返回自定义 `Duplex`，对着本地 SSE、分块、大上传、`100-continue`、keep-alive 复用的服务跑通；`ws` 的 `createWebSocketStream` 到 B 的通路；确认 `ws` 不跟随重定向（`followRedirects: false`，3xx 当失败）；用真实 TLS 服务端（自签名、过期、主机名不符、链不完整）逐个测出校验失败的错误码并映射到 `tls-untrusted`（第一版不并入系统根证书，N7）。结论回写 §3.2、§3.6。

范围（`apps/desktop/src/fork/loopbackGateway/`）：每环境代理、隧道客户端、环境注册表、会话安装器与 `getPreviewConfig` 钩子、`app.on("login")`、错误页和 `webRequest` 事件、IPC 与 preload 桥（`preloadSandbox.test.ts` 比对）、票据续期请求、传输检查（调用 `packages/shared` 的同一个函数）。

**回环主机的判定和规范化放在 `packages/shared/src/forkLoopbackGateway/` 里**（GPT P2-3），界面（web 的状态机、地址规范化）和主进程（代理的主机校验）共用一个函数，不各写一份。它包含：判定（`localhost` 含尾点、`*.localhost`、`127.0.0.0/8`、`::1`、`::ffff:127.x`）、以及**仅用于显示和已知 Preview URL** 的规范化（`0.0.0.0`、`[::]` → `localhost`）。**规范化不参与任何安全判断**（主控 Q8，GPT 同意）：代理和 B 端的判定只用判定函数，不接受"规范化之后才算回环"；页面自己写死的 `0.0.0.0` 不转发。

验收：

- **`login` 处理的四个条件**（§4.7）：错误的 host、port、session、`isProxy === false`、属于另一个环境的 session，都不回应；与假的上游处理器并存。
- **口令与限制：** 口令只在内存（测试里扫描 IPC 消息、日志、传给渲染进程的任何数据，找不到口令）；本机另一个客户端不带口令或带错口令，只能得到 407，假隧道工厂计数为 0；并发与速率限制（§3.7）。
- 主机判定表（§1.2）逐项；非回环一律 403；`0.0.0.0`、`[::]` 不转发。
- HTTP：流式/SSE、分块、`Connection: close`、大请求体、中途取消；同一条 Chromium 连接上不同端口的请求各自选对隧道；keep-alive 复用。
- CONNECT（https、ws）：数据双向、一端关闭另一端关闭。
- 主进程自己的传输检查：`httpBaseUrl` 不通过时不发出任何连接。
- **连接目标固定、不跟随重定向（§3.6）：** 隧道升级请求得到 3xx 当失败（`unexpected-redirect`）；安装票据时的 `baseUrl` 之后不会被其他地址替换；路由切换时重新判定加密与否并换新票据，新地址不通过则拆代理、关隧道。
- **TLS 失败保持失败（§3.6）：** 自签名、过期、主机名不符、链不完整的服务端都失败并映射到 `tls-untrusted`；没有任何路径设置 `rejectUnauthorized: false`（静态扫描测试）。
- **票据不进主进程日志（§4.3）：** 收集主进程的日志与错误输出，走完成功与每条失败路径，找不到哨兵票据。
- 票据过期的行为；`pending` 状态回 503。
- 会话安装器：`setProxy` 的参数就是 §1.1 的规则串；改回直连时 `closeAllConnections`；**新 profile 的第一次导航之前代理已装好**（钩子在 `getPreviewConfig` 里，测试用 mock `Session` 断言 `setProxy` 先于返回）。
- **真实 Electron 冒烟**（附录 A 的 spike 整理成 `vp run fork:loopback-gateway:electron-smoke`，不进 CI，9.4 人工验收时跑）：普通 HTTP、SSE、WebSocket、`https://localhost`，加上 §2.3 末尾列的路径：Service Worker、prefetch、`sendBeacon`、无痕分区、新 profile 首次导航、favicon 的 `session.fetch`、下载。
- 关闭传播、背压、帧和连接上限：在 socket 层测（真实 TCP + 真实 `ws`）。
- 阶段结束时按实际 diff 重估上游改动行数；超过 130 行停下回报。

测试层：代理逻辑用假隧道（一对 `Duplex`）做单元测试，不碰 Electron；安装器用 mock 的 `Session`；Chromium 实际行为只能在真 Electron 里证明，所以放在脚本里。

**9.2 完成情况（2026-11-04，分支 `t3/7dc5f1ea`）：** 范围内全部做完；第一步结论在 §3.2、§3.6。实现与设计不同、或设计没写清而自己定的地方：

1. **恢复用 `{ mode: "system" }`，不是 `{ mode: "direct" }`。** 分区从来没设过代理，默认就是 `system`；改成 `direct` 会让用户配了系统代理的人在"停止转发"之后丢掉自己的代理。冒烟里 `resolveProxy` 在恢复后是 `DIRECT`（这台机器没有系统代理），其余步骤（`closeAllConnections`、关闭隧道）照设计。
2. **票据的"过期"不在 A 端判断。** 过期的票据照常发给 B，B 回 401，状态变 `rejected(unauthorized)` 并发 `ticket-needed`；A 端只在剩余不足 60 秒时提醒一次（一次性定时器，上限 2^31-1 毫秒，到点再算一次），没有票据时请求得到 503（头里的码是 `unauthorized`）。这样"没有票据"和"票据被拒"在 9.3 看来是同一种"正在重新连接"。
3. **环境状态集合：** `pending`（有代理没有票据）、`active`、`offline`、`disabled-by-user`、`unsupported-route`（`code`: `insecure-transport` 或 `unsupported-route`，可带 `hint: "tailscale-address"`）、`rejected`（`code` 是 `unauthorized`/`forbidden`/`tls-untrusted`/`unexpected-redirect`/`unsupported-server`/`discovery-disabled`）。端口级的拒绝（`not-owned`、`reserved`、`debug-process`、`upstream-refused`、`owner-changed`、`limit-reached`、`rate-limited`）不改环境状态，只发 `denied` 事件；打开隧道成功会把 `rejected`/`offline` 清回 `active`（仅当用的还是当前这张票据）。
4. **代理只在"该环境登记过、传输检查通过、用户没关"时存在。** 关闭或路由不再通过传输检查时代理停掉，口令也随之换新，恢复时是新的端口和新的口令；会话先改回 `system` 再停代理。
5. **`denied` 事件的两条来源：** HTTP 主框架导航由该分区的 `webRequest.onHeadersReceived` 看到 `X-T3x-Gateway-Error`（只信回环主机上的响应，页面自己发这个头没用），带 `webContentsId` 和 URL；`CONNECT` 被拒由代理直接发，没有页面信息（`mainFrame: false`）。子资源的 HTTP 拒绝不发事件。
6. **`getPreviewConfig` 钩子失败即失败：** 该环境该有代理而 `setProxy` 抛错时，整个 `getPreviewConfig` 失败，不返回 webview 配置，否则页面会连到 A 自己的 `localhost`。没登记的环境完全不碰。
7. **Fork 桥的类型和 schema 放在 `packages/shared/src/forkLoopbackGateway/bridge.ts`**（同 `keepAwake`、`selfHost` 的先例，IPC 通道名在 `apps/desktop/src/fork/loopbackGateway/channels.ts`，preload 只有两行）。票据在 IPC 上是字符串，主进程的 schema 一解码就是 `Redacted`；格式检查放在解码之后（schema 的长度检查失败会把原值放进错误信息）。`expiresAt` 在线上是 ISO 字符串（`DateTimeUtcFromString`）。
8. **错误页文案**（`translate(getUiLocale(), …)`）的 13 条中文放进了现有的 `catalogs/zh-Hans/desktop.ts`，没有新开 catalog 文件，避免和 9.3 的 `loopbackGateway.ts` 注册行冲突。
9. 并发中的"开隧道"上限是 32，超过得到 `limit-reached`（429）；每环境 Chromium 连接 256（`server.maxConnections`）。

**9.2 审查后的修复（GPT 审查，3 条 P1）：**

10. **每次切进代理都关连接。** `applyToSession` 在 `setProxy` 之后无条件 `closeAllConnections()`，包括从 `system` 第一次切到代理。冒烟里 Chromium 的连接池按代理分组，登记前打开的直连 keep-alive 连接在切换后本来就没有被复用（旧代码也过），所以这一条在真实 Electron 里没有可见的差别；但没有这一步时，"新 profile 首次导航前 `resolveProxy` 已是代理"的冒烟在旧代码上失败过一次（`setProxy` 返回时规则还没生效，`closeAllConnections` 起了同步点的作用）。单元测试用 mock `Session` 断言顺序。
11. **多个 session 的状态靠"期望状态加幂等重试"收敛。** 每个 session 只在 `setProxy`、监听器、`closeAllConnections` 全部成功后才记入"已切到哪个端口"；动手之前先标脏，中途失败的 session 下次一定重做。`onProxyChange` 用 `Promise.allSettled`，任何一个失败就让环境报 `rejected`/`internal`（没有新协议字段），环境之后的每个操作（`register`、`updateTicket`、`setEnabled`、`setReachable`、`installSession`）先把所有 session 重新收敛。停止转发时某个 session 没能恢复，它会指着一个已经关闭的代理，回环请求失败（不会走到别处），下一次操作再恢复。`installSession` 对自己这个 session 没到位就抛错，`getPreviewConfig` 随之失败，不返回 webview 配置；`unregister` 在环境关闭后再收敛一次，失败也抛错。
12. **没有 `webContents` 的请求也能通过代理认证**，理由写在 §4.7。真实 Electron 里的结论（冒烟）：
    - 下载（`session.downloadURL`，全新分区的第一个请求）：`login` 事件来了，`webContents` 为空，应答成功，下载完成。
    - Service Worker 在 app 重启之后的第一个请求：持久分区，第一次运行注册并缓存页面后退出；第二次运行是新进程，不开任何页面，只用 `session.serviceWorkers.startWorkerForScope` 启动那个 worker，它在脚本顶层 `fetch` 上游。`login` 事件来了，`webContents` 为空，应答成功，请求经隧道到达。旧代码（要求 session）在这里超时。
    - **`session.fetch` 是例外：Electron 根本不为它发 `login`。** 全新分区上的第一个 `session.fetch` 得到代理的 407，没有任何质询事件，请求没有泄露到 A 本机；该分区里只要有过一次会发 `login` 的请求（导航、下载），认证被缓存，之后的 `session.fetch` 正常。实际影响很小：favicon 抓取（`FaviconCapture.ts`）用的是已经导航过的标签页所在的 session。若以后要覆盖，最小的备选是：`installSession` 成功后，对该 session 做一次发往代理自身端口的 `session.downloadURL`（会触发 `login` 并缓存凭据）预热；没有做，因为它是为一个没有真实触发路径的窗口多加一个机制。冒烟把这一缺口当作已知现象固定下来（407、无 `login`、无泄露、导航之后恢复），Electron 行为变了冒烟会提醒。
13. **`not-owned` 错误页文案**加上"或者它已经脱离了启动它的终端或 Agent（例如用 nohup 放到后台）"，建议在 T3 的终端里启动（9.1 的规则：不在 server 子树里的监听一律算不是 T3 起的）。
14. **每个 session 只有一个 `onHeadersReceived`**：FORK.md 记了一笔，`singleWebRequestListener.test.ts` 在 `apps/desktop/src/fork/` 以外的产品代码里出现 `webRequest.on…(` 就失败。

**9.2 第二轮审查后的修复（GPT 定向复核，2 条 P1）：**

15. **注销失败后能恢复。** `unregister` 删掉环境对象之后无论如何都再恢复一次这个 id 的所有 session，失败就抛错；环境对象已经不在时再调一次 `unregister` 照样重试。对没登记的环境调 `installSession`，会先把该 id 的 session 收敛回 `system`，这个 session 没到位就抛错（`getPreviewConfig` 随之失败，不放行）。没碰过的 session 不产生任何调用。
16. **宿主层按 environmentId 串行。** `register`、`updateTicket`、`unregister`、`setEnabled`、`setReachable`、`installSession`（和 `dispose` 里的注销）对同一个 id 按调用顺序一个接一个执行，一个失败不卡住后面的；不同 id 互不等待。用一个 `Map<id, Promise>` 串起来，没有锁和回滚事务。`getStatus` 和 `answerProxyLogin` 是同步读，不排队。
17. 冒烟的两个空闲端口改为同时监听再读取，监听失败时打印原因并以非零退出。FORK.md 里补了一句：`webRequest` 的静态扫描只是守护，抓不到别名和间接注册。9.1 的 `exclusions.json` 登记了 `LoopbackProxy.ts`（E1：B 本身是桌面版时，桌面主进程是 server 的祖先；另有 `Proxy-Authorization`）。

### 9.3 web 接线、界面与中文（M）

范围：`apps/web/src/fork/loopbackGateway/`（能力读取、状态机、取票据与续期的挂载组件、store、标识、错误卡片）、`resolveDiscoveredServerUrl` 的改动、`HostedBrowserWebview` 的等待门、`PreviewUnreachable` 的 reason、zh-Hans catalog。

验收：

- 传输检查的表格测试（§4.6 的整张表，含明文 `100.x` 的 `insecure-transport` 与 `tailscale-address` 提示）加性质测试（任何 `100.64.0.0/10` 的 `http:` 一定不通过）。
- 状态机的表格测试：每道门单独失败、多道同时失败的优先级，含 `insecure-transport` 与 `relay`。
- `resolveDiscoveredServerUrl` 表测试：`active` 时放行；各非 active 状态走原逻辑；`systemBrowser` 选项行为不变。
- 续期调度是纯函数（输入现在时间和过期时间，输出下一次动作），不用定时器测。
- **`disabled-by-user` 的标识和「恢复转发」入口**（浏览器测试，`render` from `apps/web/test/render.tsx`），再加错误卡片按 reason 换文案的浏览器测试（含明文 `100.x` 的 MagicDNS 提示和「证书不受信任」）。
- `vp run i18n:report` 0 missing / 0 stale；`i18n.test.ts` 通过。
- 中英文对照截图（标识的两种状态和各种卡片）。
- `vp run fork:guard`、`vp run check:changed`。
- 手动检查：在远程对话让 agent 打开 `localhost:5173`，确认它是服务端标签页（§9）。

**9.3 的实现结果（2026-11-04）：**

- `apps/web/src/fork/loopbackGateway/`：`gatewayState.ts`（状态机与"门"的纯函数）、`ticketRenewal.ts`（续期时机）、`gatewayController.ts`（不依赖 React 和 atoms 的控制器：登记、取票、续期、断开与重连、路由变化、移除；对着假桥测试）、`gatewayStore.ts`（给 resolver 和各处读的轻量 store，含 `denied` 事件与标签页加载的序号）、`disabledStore.ts`（用户关闭）、`useLoopbackGatewayState.ts`（从 atoms 读输入）、`LoopbackGatewayManager.tsx`（挂在 `AppSidebarLayout`，每个环境一个子组件）、`LoopbackGatewayBadge.tsx`、`LoopbackGatewayCard.tsx`、`gatewayCard.ts`、`useLoopbackGatewayTab.tsx`（给 `PreviewView` 一个入口）、`ticketCommand.ts`、`bridge.ts`。
- 权限用 `issueTicket` 命令的 `permissionAtom`（`preview:operate` 与 `terminal:operate`），另读一次会话状态区分"还没加载"和"没有权限"。能力位 `readEnvironmentSupportsLoopbackGateway` 没有单独写成函数：状态机要区分"配置还没加载"（`null`）和"没有能力"（`false`），读取直接放在 `useLoopbackGatewayState` 里，不改上游的 `entities.ts`。
- 控制器不轮询：取票由登记、`ticket-needed`、重连、一次性续期定时器触发；任何来源的取票之间至少隔 3 秒，失败后 10 秒内不再取，被挡住的取票会在窗口结束时重新排上。路由变了（`httpBaseUrl` 变了）重新登记、作废在途的票据并取新的。
- 修复轮（GPT 审查）：① 续期全部按本机时钟（§7.3）；② 没有 `webContentsId` 的 `CONNECT` 拒绝只用来解释**本标签页自己加载失败**时的卡片，不会盖住已经加载成功的页面，也不会串到同环境同端口的其他标签页；③ 上次是 `active` 的环境，重启后连不上时标签页不挂 webview，显示\"连不上\"卡片和退路（§2.3）；④ `PreviewUnreachable` 传了 `gateway` 时不再渲染「详情」按钮；⑤ `reachesEnvironmentLoopback` 的 `export` 行上方加了 `// fork:` 注释行。
- 上游改动（非测试，`git diff` 新增行 / 删除行）：`PreviewView.tsx` +12（设计 §13 没有列这一项：标识和卡片要的数据都在它里面，没有别的办法交给 fork 组件）、`ElectronBrowserHost.tsx` +2（门，替代原计划的 `HostedBrowserWebview` +3）、`browserTargetResolver.ts` +9 −2、`PreviewUnreachable.tsx` +11 −6、`PreviewChromeRow.tsx` +3、`AppSidebarLayout.tsx` +2、`ThreadServersPanel.tsx` +3 −1（一行被格式化器折成三行）、`zh-Hans/index.ts` +2；合计新增 44、删除 9，净增 35（fork 自己的 `FooterPorts.tsx` 另有 +3 −1）。

### 9.4 两台电脑的端到端、连接方式矩阵与文档（M+）

场景：B 的 T3 终端起 Vite，A 打开 `localhost:5173`，热更新可用，非 T3 起的端口被拒。

1. **无界面部分**加进 `vp run fork:selfhost:e2e` 作为新场景：A、B 是现有 harness 起的两台真实 server；B 的终端经 RPC 打开并写入命令起一个带 SSE 和 WebSocket 的小服务；A 端用桌面代理模块（纯 Node，不 import electron）经自建隧道取页面、收 SSE、说 WebSocket；一个**不是**终端起的服务（harness 直接 spawn 的）被拒；移除 B 上 A 的设备后隧道两端关闭。
2. **界面部分**在 Electron 里做一次（`test-t3-app`，用 `--use-mock-keychain`、`--host-resolver-rules="MAP *.t3.localhost 127.0.0.1"`、定向信任 Caddy CA）：Vite 示例，输入 `localhost:5173`，地址栏不变、标识出现、改文件热更新生效、`https://localhost` 自签名、端口列表点击、终端链接点击、重启应用后恢复标签页；非 T3 起的端口出卡片；停止转发后回到旧行为，标识仍在、可恢复。
3. **连接方式矩阵（GPT P1-7，主控第 9 条）：** 对 §3.5 里每一种"待验证"的方式，各测：打开 WS 隧道；长连接（至少 30 分钟空闲后 HMR 仍可用）；重连（重启 B、断网再通）；证书（公共 CA 的有效证书通过；过期、自签名、主机名不符都失败并给出"证书不受信任"；私有 CA 是已知限制，只确认报错正确）；`Authorization` 头原样到达 B；并发（几十条隧道同时升级）。测完把表里的"待验证"改成"已验证"，或写明限制。
4. **基础设施测试（复核 P0-2，实测通过才能把它标为解决）：** `Caddyfile` 没有未加过滤的 `log`；在本地试用栈里临时打开 Caddy 的访问日志，用哨兵票据发一条隧道升级，实测 `Authorization` 被遮蔽；grep frps 与 Caddy 的全部日志输出，frps 不打印请求头；README 说明。
   4a. **威胁模型用例（§6.7，在真实 Electron 里）：** Vite 夹具的 `/@fs/`、source map，外部来源页面读不到；`--inspect=0` 和 9229 被拒；`*.localhost`；映射 IPv6；DNS rebinding。
   4b. **Linux：** 在容器里跑 9.1 的真实进程核对测试和排除测试，通过后才能让 Linux 的 B 广告能力。**结果见本节末尾的"9.4 无头部分的结果"：全过，广告函数没有改。**
5. 按 §11.1 测模块图抓取时间（含 50 毫秒和 100 毫秒往返的延迟注入，无浏览器）。
6. 文档：`docs/user/remote-access.md` 的 "Browser on a remote environment" 旁加一节（写明语义变化：B 的标签页里 `localhost` 永远指 B；按环境生效；只在加密或本机连接上启用；别在转发的标签页里打开不信任的网站；私有 CA 不支持；只列已验证的连接方式；哪些 provider 因此转发不了脱离父进程的后台作业）；FORK.md 加一节；本文档写入结果。

验收：以上全部通过；`fork:selfhost:e2e` 连续两遍全绿；官方基线不变（不碰 `~/.t3`、fork 真实 home）。

**9.4 无头部分的结果（`t3/loopback-gateway-e2e`，2026-11-07，这台 Mac，不起 Electron）：**

1. **场景 15（转发）和场景 16（日志脱敏）进了 `fork:selfhost:e2e`**（现在 16 个场景；场景 17 是 §11.1 的测量，只在 `--only` 点名时跑）。15：第三台电脑 D 扮演桌面，用桌面自己的代理、隧道客户端和环境状态（纯 Node），经 Caddy 和 frps 读到 B 的终端起的服务的页面、SSE、WebSocket，请求头里没有票据和代理口令；一个脱离父进程的监听被拒，原因 `not-owned`（HTTP 和 `CONNECT` 都是）；在 B 上移除 D 之后，打开的隧道两端都关闭，D 再请求得到 `unauthorized`。16：见 §4.3 的实测——开着访问日志时 `Authorization` 是 `REDACTED`，Caddy、frps、registry 的全部输出里都没有票据；加 `log_credentials` 时场景会失败。顺带发现：重载 Caddy 会断开所有 frpc 的控制连接（它们经 Caddy 的 WebSocket），所以场景在重载前后都等两台电脑的 frpc 重新登录，否则重载之后的第一个请求会撞上"没有路由"（完整一遍里出现过，短的几次没碰上）。`fork:selfhost:e2e` 的 16 个场景连续两遍全绿。
2. **测的过程中发现并修了一个产品缺陷（9.1 遗留）：** 隧道路由在 WebSocket 升级之后、接上字节管道之前隔着几个 `await`（会话复查加纤程切换），客户端在这段时间里发来的第一帧被丢掉，请求挂到服务那头超时。桌面代理在隧道一打开就写请求，六条冷隧道同时开时，对真实 server 几乎每轮丢一条；场景 15 一次开一两条，侥幸没碰上。修法：升级完成时 `ws.pause()`，`createWebSocketStream` 在管道接上时恢复；`TunnelRoute.test.ts` 里加了"客户端在 `open` 回调里立刻发帧"的用例（在 main 上挂住，修后通过）。这是单独的一个提交，可以单独撤回。
3. **`TunnelRevocation.test.ts` 高负载下超时：** 根因不是读进程表（这个文件用假的端口核对）。两条用例把测试时钟拨进一小时，而隧道心跳每 30 秒（测试时钟）发一次 ping，三次没回 pong 就终止隧道；拨钟时 120 个心跳在一个紧循环里跑完，pong 要真实的 I/O，负载高时一个都等不到，隧道被心跳终止，DPoP 续期那条用例等的回显永远不来。会话寿命改成 20 秒（小于 30 秒），心跳不再触发；在 32 个 `yes` 压着的机器上（负载 30 到 46），原用例 40 次里挂 1 次，修后 150 次全过。
4. **§11.1 模块图抓取时间（无浏览器）：** 见 §11.1。判据改成"同样往返下比直连服务多出多少"：50 ms 往返多出约 0.77 秒，100 ms 约 0.90 秒；阶段 9 不做预开隧道。
5. **Linux（`vp run fork:loopback-gateway:linux-check`）：** 在 `node:24-bookworm` 容器里（Docker Desktop 的 LinuxKit 内核 6.12，镜像是 x86_64，在 Apple Silicon 上模拟运行），以容器里的普通用户（uid 1000）跑 7 个测试文件共 91 条：`ProcessInspector`（`/proc` 的真实读取，含 `SO_REUSEPORT`）、`PortAuthorizer`（真实进程：终端、agent 作业、孤儿、`--inspect`、完整 server 自检）、`PortAuthorizerBatch`、`GatewayExclusions`、`ExclusionsInventory`、`RuntimeSignatures`、`TerminalShellRegistry`，**全部通过，连跑两遍**。这些真实进程测试以前只在 macOS 上跑（`describe.runIf(darwin)`）；现在 macOS 和 Linux 都跑，选平台的两个小函数在 `processFixtures.testkit.ts`。容器里要装 `lsof`（自检用例用它列监听），依赖只装 `t3` 包及其依赖（`--ignore-scripts`）。**Linux 的广告函数没有改。** 没测：Linux 上核对耗时（模拟运行，数字没有意义）；原生的 aarch64 容器；`rpcHandlers.test.ts` 里依赖"平台是 macOS"的两条用例在 Linux 上本来就失败（广告函数的预期行为，不在范围内）。

### 以后再做（不在 9）

- 多路复用 / 预开隧道（§11.1 的结论是阶段 9 不做；Electron 真实网络走查时用户觉得慢再看）。
- 为每次升级签一个 DPoP 证明，让明文局域网也能用（主控第 2 条）：渲染进程为每条隧道的升级请求签证明，经 IPC 交给主进程；需要把票据改成绑 `jkt` 并在网关路由里验证证明和 jti 防重放。
- 按线程精确归属（要改 contracts）。
- 网页版（附录 C）。

## 13. 上游改动预算

**M2 更新（主控的设计变更：运行时不在 adapter 文件里登记）：** 下面的表里"各 adapter 启动点登记"（+19）、设备 hub 登记子树（+1）、`forkRuntimeRegistry` 共享模块的 exports 入口（+1）、`ManagedEndpointRuntime`/`provider-*` 各文件的行都**不再有**。9.1 完成时的实际上游非测试改动是 **10 个文件、+31 行 −2 行**（`environment.ts` +1、`index.ts` +1、`auth.ts` +5 −2、`clientRpcPermissions.ts` +8、`rpc.ts` +2、`shared/package.json` +4、`ServerEnvironment.ts` +2、`RpcInstrumentation.ts` +2、`server.ts` +3、`ws.ts` +3），比第三版预算的 9.1 部分少约 35 行。删减方案第 1 条已经被这次变更实现。

新代码全部放 `apps/*/src/fork/` 和 `packages/*/src/fork*`。第二版约 +70 行、23 个文件。第三版把主控这一轮的决定都算进去，**约 +91 行、30 个文件**，停止线仍是 130 行。

| 这一轮的决定                                      | 放在哪里                                                                                              | 上游行数变化 |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------ |
| N3：用上游 `isTailnetHost`                        | fork 的传输检查直接 import，不改上游                                                                  | 0            |
| 显式脱敏、守卫测试                                | fork 路由里（`Redacted`）、测试文件                                                                   | 0            |
| 每条隧道现场核对、无缓存、`TerminalShellRegistry` | fork 文件；订阅 `TerminalManager.subscribeMetadata`（公开接口）；不改 `PortScanner` 的记录（N4 维持） | 0            |
| 各 adapter 启动点登记运行时 pid + 启动时间（5a）  | 7 个上游文件各 +2 到 +3 行：`trackRuntimeProcess(pid, kind)` 加一个释放调用                           | **+19**      |
| 设备 hub 登记子树                                 | `LocalDeviceHost.ts`（第二版 +2，现在 +3）                                                            | +1           |
| 登记表和特征声明的共享模块                        | `packages/shared/package.json` 的 exports 多一个入口                                                  | +1           |
| Windows 不广告、Linux 条件广告                    | fork 的广告函数，`ServerEnvironment.ts` 那 2 行不变                                                   | 0            |
| N7：不并入系统根证书                              | 不做就不改                                                                                            | 0            |
| 主进程 `ws` 不跟随重定向、连接目标固定            | fork 文件                                                                                             | 0            |

逐文件：

| 上游文件                                                       | 预计行数                                                                      | 内容                                                                                         |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/contracts/src/environment.ts`                        | +2                                                                            | 能力位 `loopbackGateway`                                                                     |
| `packages/contracts/src/rpc.ts`                                | +2                                                                            | 展开 fork RPC（同 `FORK_DEVICE_KEYS_RPCS`）                                                  |
| `packages/contracts/src/index.ts`                              | +1                                                                            | 导出 fork 契约                                                                               |
| `packages/contracts/src/clientRpcPermissions.ts`               | +4                                                                            | 展开受保护 scope、`clientRpcRequiredScopes` 里为该方法返回两个 scope                         |
| `packages/contracts/src/auth.ts`                               | +1                                                                            | `AuthWebSocketTicketUse` 加 `"loopback-gateway"`                                             |
| `packages/shared/package.json`                                 | +4                                                                            | exports：`forkLoopbackGateway` 下的几个文件，加 `forkRuntimeRegistry`                        |
| `apps/server/src/ws.ts`                                        | +3                                                                            | 注册 RPC 处理器（同 `makePushRpcHandlers`）                                                  |
| `apps/server/src/server.ts`                                    | +5                                                                            | 路由层、服务层、脱敏层、排除登记层                                                           |
| `apps/server/src/environment/ServerEnvironment.ts`             | +2                                                                            | 广告能力                                                                                     |
| `apps/server/src/preview/PortScanner.ts`                       | +1                                                                            | 导出 `PORT_DISCOVERY_ENV`                                                                    |
| `apps/server/src/device/LocalDeviceHost.ts`                    | +3                                                                            | 登记 hub 子树                                                                                |
| `apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts` | +2                                                                            | `spawnClaudeProcessGroup` 登记 `child.pid`，`exit` 时释放                                    |
| `apps/server/src/orchestration-v2/Adapters/CodexAdapterV2.ts`  | +3                                                                            | `open` 里 `spawner.spawn` 之后登记 `handle.pid`，scope 关闭时释放                            |
| `packages/provider-opencode/src/server/OpenCodeRuntime.ts`     | +2                                                                            | 紧挨着 `serverLedger.track` 登记 pid 和已知端口                                              |
| `packages/provider-acp/src/server/AcpSessionRuntime.ts`        | +3                                                                            | `spawner.spawn` 之后登记 `child.pid`（ACP 系共用）                                           |
| `packages/provider-pi/src/server/rpc.ts`                       | +3                                                                            | 登记 `child.pid`                                                                             |
| `packages/provider-muse/src/server/sdk.ts`                     | +3                                                                            | SDK 能给出 pid 才登记，否则落到 E3 和 E5                                                     |
| `apps/server/src/cloud/ManagedEndpointRuntime.ts`              | +3                                                                            | 连接器子进程登记                                                                             |
| `apps/desktop/src/preload.ts`                                  | +8                                                                            | 桥                                                                                           |
| `apps/desktop/src/ipc/DesktopIpcHandlers.ts`                   | +2                                                                            | 安装 IPC                                                                                     |
| `apps/desktop/src/main.ts`                                     | +2                                                                            | 层                                                                                           |
| `apps/desktop/src/ipc/methods/preview.ts`                      | +3                                                                            | `getPreviewConfig` 里调用安装钩子                                                            |
| `apps/desktop/package.json`                                    | +1                                                                            | `ws` 依赖（当前没有任何工作区包直接依赖它，它只作为 `@effect/platform-node` 的传递依赖存在） |
| `apps/web/src/browser/browserTargetResolver.ts`                | +8                                                                            | `active` 时放行、`systemBrowser` 选项                                                        |
| `apps/web/src/browser/HostedBrowserWebview.tsx`                | +3                                                                            | 等"网关已登记"                                                                               |
| `apps/web/src/components/preview/PreviewUnreachable.tsx`       | +8                                                                            | reason 卡片钩子（含 `insecure-transport` 的 Tailscale 地址提示、`tls-untrusted`）            |
| `apps/web/src/components/preview/PreviewChromeRow.tsx`         | +4                                                                            | 标识（含 `disabled-by-user`）                                                                |
| `apps/web/src/components/AppSidebarLayout.tsx`                 | +2                                                                            | 挂载取票据与续期（同 `KeepAwakeReporter`）                                                   |
| `apps/web/src/components/chat/ThreadServersPanel.tsx`          | +1                                                                            | `{ systemBrowser: true }`（`FooterPorts.tsx` 是 fork 自己的文件，另有一行）                  |
| `packages/client-runtime/src/i18n/catalogs/zh-Hans/index.ts`   | +2                                                                            | 注册 catalog                                                                                 |
| **合计（不含文档）**                                           | **约 +91**，30 个上游文件                                                     | 停止线 130 行                                                                                |
| 文档                                                           | `docs/user/remote-access.md` +30、`FORK.md` +50、`infra/self-host/README` +10 |                                                                                              |

**风险比行数更大的地方：** 新增的 7 个 adapter 启动点都是上游改动最频繁的文件。上游这 26 个提交（`322f6544df..8b44f42b14`）里，`ClaudeAdapterV2.ts` 和 `CodexAdapterV2.ts` 就各被改过（增加 8 行；增加 2 行、删除 3 行），其余（`OpenCodeRuntime`、`AcpSessionRuntime`、`provider-pi`、`provider-muse`、`ManagedEndpointRuntime`、`hostClassification.ts`、`observability`、`terminal`、`builtInDrivers.ts`）零改动。每次同步上游，这几处最可能冲突。冲突时的原则：登记点是单行调用，保持原位，不重构上游代码。

**超过 130 行时的削减方案**（按顺序，每步省的行数）：

1. 去掉直接子进程运行时的显式登记（Claude、Codex、OpenCode、ACP、Pi、连接器，共 −16），改由 E3（默认拒绝直接子进程）加 E4（特征）加 E5 兜底。代价：有包装层且不 `exec` 的启动方式失去 pid + 启动时间的精确绑定；**这与主控第 5 条 a 不同，需要主控同意。**
2. Muse 的登记（−3，本来就取决于 SDK 能不能给出 pid）。
3. `PreviewUnreachable` 的细分 reason 改成一条通用说明加按钮（−6）。
4. `PreviewChromeRow` 的标识菜单改成只有图标（−3），菜单挪进 fork 组件。
5. `ThreadServersPanel` 的 `systemBrowser` 选项：Cmd-click 也保持转发行为（−1，行为变化，需要主控同意）。
6. 再不行：把安全基础设施（严格认证、显式脱敏、排除登记、运行时登记）拆成独立的阶段先合入，网关路由本身后合。

上游 26 个新提交（`322f6544df..8b44f42b14`）预判（用 `git diff --stat 322f6544df 8b44f42b14` 逐个核对过）：

- 这四个目录**零改动**：`apps/web/src/browser`、`apps/web/src/components/preview`、`apps/desktop/src/preview`、`apps/server/src/preview`。
- 第二版表里的文件在这个区间都零改动；本版新增的文件里只有 `ClaudeAdapterV2.ts`（+8）和 `CodexAdapterV2.ts`（+2/−3）被改过，见上面的风险。
- 上游 main 仍然没有网关（`Gateway.ts` 不存在）。

预估新代码规模：server 约 1,150（含运行时登记表、特征声明、身份读取、`TerminalShellRegistry`、现场核对）、desktop 约 1,100、web 约 600、契约与共享约 250，共约 3,100；测试另约 2,200（含各 provider 的假运行时、socket harness、Linux 容器里的真实进程测试）。

## 14. 决定与实现阶段才能回答的问题

### 14.1 已定

主控拍板的问题（第一轮）：

| #   | 问题                            | 决定                                                                                                                                                                                                           | 写在哪里         |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Q1  | 明文局域网是否启用              | **不启用。** 只在 `https:`/`wss:`、回环（含 SSH 转发口和本机）、Tailscale 上启用；明文局域网为 `unsupported-route` / `insecure-transport`，走旧行为，错误卡片给「在 B 的浏览器中打开」。判定是纯函数加表格测试 | §4.6、§8、§7.2   |
| Q2  | Preview URL 是否算许可          | 不算                                                                                                                                                                                                           | §5.2             |
| Q3  | 是否屏蔽调试端口                | 屏蔽，最终 8 个：9222、9229、5858、5859、2375、2376、5005、5678（N5）                                                                                                                                          | §5.7             |
| Q4  | 是否改 `PortScanner` 记绑定地址 | 目的达成，做法是现场核对读出绑定地址，不改 `PortScanner` 的记录（N4 维持）                                                                                                                                     | §5.3、§5.5       |
| Q5  | 权限是否两个 scope              | 两个：`preview:operate` + `terminal:operate`                                                                                                                                                                   | §4.5             |
| Q6  | 命令面板是否加开关              | 不加。`disabled-by-user` 时标识保留，菜单项「恢复转发」                                                                                                                                                        | §7.1、§10        |
| Q7  | 是否按环境生效                  | 按环境生效；UI 和文档明说                                                                                                                                                                                      | §7.1、§10        |
| Q8  | `0.0.0.0` / `[::]`              | 不转发；规范化只用于显示和已知 Preview URL，不参与安全判断；判定和规范化放 `packages/shared`，UI 和主进程共用                                                                                                  | §1.2、§12（9.2） |
| Q9  | 是否有独立的 9.0                | 没有。9.1 先过监听点与运行时的关口，再做 B 端技术前提；A 端的前提是 9.2 第一步；失败就停下回报；严格 audience、票据不进日志、`login` 条件、撤销竞速、TOCTOU 是验收项                                           | §12              |

第二轮提出、第三轮由主控定下的 N1–N7：

| #   | 问题                                | 决定                                                                                                                                                                                 | 写在哪里         |
| --- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| N1  | 票据的 `jkt` 作续期链的键           | **接受，并写明这是可接受的 bearer 延长**：偷来的票据开出的隧道最多活到这台设备的会话链结束或被撤销。补三个测试（续期期间被盗的票据、撤销与升级同时发生、设备移除后整条会话链被撤销） | §4.2、§4.8       |
| N2  | 票据头 `Authorization: T3X-Gateway` | **维持。** 但"默认遮蔽"不再当作安全前提：入口立刻 `Redacted`，每个 sink 有测试，守卫测试，Caddy 与 frps 在 9.4 实测                                                                  | §4.3             |
| N3  | Tailscale 的判定范围                | **用上游 `isTailnetHost`**：只认 `*.ts.net` 和 `fd7a:115c:a1e0::/48`，不单独认 `100.64.0.0/10`。明文 `100.x` 是 `insecure-transport`，卡片提示改用 MagicDNS 名字或 HTTPS             | §3.5、§4.6、§7.2 |
| N4  | 不改 `PortScanner` 的记录           | **维持。** 现场核对读出绑定地址；"和快照里的实例比启动时间"的字面要求用"现场重新证明有主 + 同一实例的两次身份读取"达成（§5.3 里说明了差别和回退方案）                                | §5.3             |
| N5  | 屏蔽表再加 5005、5678               | 维持，最终 8 个端口                                                                                                                                                                  | §5.7             |
| N6  | Windows 的 B                        | **第一版不广告这个能力。** 删掉"只做 C1"的写法。Linux 在容器里的真实进程测试通过前同样不广告（这一条是我加的，理由是同一个"未验证不放行"的原则）                                     | §5.3、§5.6.5、§8 |
| N7  | 是否并入系统根证书                  | **第一版不并入。** 写进已知限制：私有 CA 不支持。TLS 校验失败就是失败，不因为 scheme 是 `https:` 放行；错误卡片说"证书不受信任"                                                      | §3.6、§7.2       |

第三轮主控的其他决定：

- 日志：显式脱敏，不依赖默认遮蔽（§4.3）；Caddy 和 frps 的日志在 9.4 实测。
- TOCTOU：去掉 2 秒缓存，每条新隧道现场核对一次，身份 = pid + 启动时间（§5.3）；9.1 实测耗时写进 §11。
- 监听点清单和 provider 运行时进程树是 9.1 的第一道关，网关路由要等它过了才开始写，拿不准的一律排除（§5.6.0、§12）。
- provider 运行时：显式登记 pid + 启动时间，声明运行时特征（测试保证每个驱动都声明），认不出特征且寿命不受 server 约束的归"只放行已登记运行时的后代"（§5.6.3）。
- 复核 P2 各项写进验收：自定义 `Authorization` 方案的中间件测试、frp/Caddy 保留请求头（9.4）、Linux 和 Windows 的命令/`SO_REUSEPORT`/双栈/启动时间核对进 socket harness、主进程 `ws` 不跟随重定向且连接目标在安装票据时固定、Vite `/@fs/`、source map、`*.localhost`、映射 IPv6、DNS rebinding 放进 9.4。

### 14.2 只有实现阶段才能回答的问题

这些不需要现在拍板，每一条都有默认做法和回答它的阶段：

1. **macOS 上 `ps -E` 能不能和 `lstart` 合成一次调用。** （M2 结论）进程表用 `ps -A -ww -o pid=,ppid=,lstart=,args=`（`LC_ALL=C TZ=UTC`）一次读全，`lstart` 与 `args` 同一次调用；需要环境变量标记和调试参数的那一个 pid 另用一次 `ps -E -ww -o command=`。没有拆成更多次调用以外的开销。
2. **单条核对的耗时。** （M2 结论，修复轮更新）改前并发 6 的 p95 是 415 毫秒，超过 300 毫秒的判据，所以做了批量核对（§5.3）：改后并发 1、6、32 的 p95 分别是 223、230、197 毫秒（§11）。Linux 容器的耗时没有测（模拟运行，数字没有意义）。
3. **`TerminalManager.subscribeMetadata` 是否覆盖 shell 退出、终端重启和关闭。** （M2 结论）覆盖：先给快照，之后每次启动、重启、退出、关闭、出错都带 `pid` 和 `status`，`TerminalShellRegistry` 的折叠函数用单元测试验证；不需要回退。
4. **Codex app-server 在 server 被 `SIGKILL` 后会不会因 stdin 的 EOF 退出；ACP 系各家 agent 同理；Muse 的 SDK 能不能给出 pid。** （M2 结论）没有验证（不能起真实 provider），也不再影响安全结论：遗留运行时被收养后不在 server 的子树里，整棵被拒；不再需要 pid（§5.6.0.1）。
5. **frp 与 Caddy 是否原样保留 `Authorization` 头；frps 的日志是否打印请求头；Caddy 开启访问日志后 `Authorization` 是否被遮蔽。** 9.4 在本地试用栈上实测，不通过不能把 P0-2 标为解决。
6. **Node 对 TLS 校验失败的错误码集合**（过期、自签名、主机名不符、链不完整）。9.2 用真实 TLS 服务端逐个测出。
7. **是否要把 `PortScanner` 内部记启动时间。** （M2 结论）不需要：启动时间由 fork 的 `ProcessInspector` 现读，`PortScanner` 没改。

### 14.3 我没有核实的前提（汇总）

- frp 在几十条并发升级连接、长时间空闲连接下的行为；Tailscale Serve 对 WS 升级和 `Authorization` 头的转发；SSH 转发口上的长连接。§3.5 标“待验证”，9.4 没有测（本地试用栈只测了 6 条并发和短连接，frp 与 Caddy 原样保留 `Authorization` 头已实测）。
- B 端的背压：已验证，用的是 `ws` 的流接口加 Node 流，不是 `Socket.writer`（§3.3）。
- A 端 `http.Agent` 的 `createConnection` 对自定义 `Duplex` 的兼容（9.2 第一步）。
- Caddy 的 `log` 开启后 `Authorization` 是否被遮蔽，frps 的日志内容：9.4 已实测，`Authorization` 是 `REDACTED`，全部日志里没有票据（§4.3，`fork:selfhost:e2e` 场景 16）。
- 经 T3 Connect 中继的行为（明确不支持，没测）。
- `protocol.handle`、`webRequest` 的否决只依据文档，没有实测。
- Linux 上的核对命令（`/proc` 的 fd、`/proc/net/tcp{,6}`、`stat` 的 `starttime`）只依据文档和上游 `OpenCodeServerLedger` 的写法，9.4 在 Linux 容器里跑过了（§12 9.4，全过）；macOS 的 `lsof -a -p`、`ps -E` 在 macOS 26 上实测过（附录 A），`ps` 的 `lstart` 用法照上游，组合调用没测。
- Windows 不支持，所以不存在 Windows 的核对命令。
- Local Network Access 在 Chromium 152 的实际拦截行为：设计不依赖它（§6.8）。
- "B 的 agent 不会驱动 A 的桌面标签页"是读代码得出的，没有启动应用验证（9.3 手动检查）。
- §5.6.2 的 provider 进程树是读启动代码和本机已安装的启动器得到的，没有起真实的 provider CLI；Muse 的 SDK 内部、Cursor、Antigravity 和 ACP 注册表的形态没有核实（均按 E2 排除，§5.6.0.1）。各家 CLI 的 shell 工具是不是一次性的 shell，因而后台作业会不会被 launchd 收养，也没有验证。
- 上游代码里除 §5.6.1 列出的监听点之外是否还有动态创建的：关口 A 逐项落实，防漂移的源码扫描测试负责以后（§5.6.4）。

## 附录 A：Electron spike 的方法与结果

**环境**：Electron 44.10.1（Chromium 152.0.7977.169，Node 24.22.1），来自 worktree 的 `apps/desktop/node_modules/electron`（二进制从本机已有的下载缓存解出，没有联网），`--user-data-dir` 在 `/tmp` 下，`--use-mock-keychain`，窗口 `show: false`，`app.dock.hide()`。

**设计**：真实服务（HTTP + SSE + WebSocket、自签名 HTTPS、一个 `direct.test` 直连服务）都只监听 `127.0.0.1` 随机端口；假代理（`http.createServer`，处理绝对 URI 请求和 `CONNECT`）也在回环随机端口。页面请求的是**从不监听的"虚拟端口"**（先绑后关得到的空闲端口号），由代理映射到真实服务。因此页面能拿到内容就证明一定经过了代理，直连只会 `ERR_CONNECTION_REFUSED`。`direct.test` 用 `--host-resolver-rules="MAP direct.test 127.0.0.1"` 解析到回环，但名字不是回环名，用来证明"其他地址直连"。

**进程**：每次运行都记录 PID，按 PID 停止；第一次和第二次中途卡住的两个进程（PID 77771、81431）按 PID 终止。最终没有残留进程；`/tmp` 下的用户数据目录和临时私钥已删除。

**文件**（在 `/tmp/t3x-gateway-design/spike/`，不进仓库）：

| 文件                                                | 内容                                                                                        |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `main.cjs`                                          | 第一版：三种代理规则串、三种 PAC、`WebContentsView`、直连对照、可逆性                       |
| `main2.cjs`                                         | 第二版：PAC 对照（证明 PAC 本身生效）、直连对照、可逆性、连接复用计数、未许可端口、代理认证 |
| `main4.cjs`                                         | 第四版：主机写法对照（`hosts.json`）                                                        |
| `info.cjs`                                          | 运行时版本信息                                                                              |
| `out-run1/stdout.txt`                               | 第一轮原始输出（直连对照的"真实端口"一步卡住，已改）                                        |
| `out/results.json`、`out/stdout.txt`、`out/log.txt` | **第二轮完整结果**（给本文引用的就是它）                                                    |
| `out/hosts.json`                                    | 主机写法                                                                                    |
| `out/info.txt`                                      | 版本信息                                                                                    |

重现需要的证书：`openssl req -x509 -newkey rsa:2048 -nodes -keyout key.pem -out cert.pem -days 2 -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost,IP:127.0.0.1,IP:::1"`。

**用户要求的五项，逐项结果：**

| 项                                                                                                                                          | 结果                                                                                                                                                                                                                                               | 证据                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. 一个 partition 设代理加 `<-loopback>` 后，`http://127.0.0.1:P`、`http://localhost:P`、`ws://localhost:P`、`https://localhost:P` 都过代理 | **通过**（规则串 `*;<-loopback>`）。代理日志依次看到 `HTTP …127.0.0.1…`、`HTTP …localhost…`、`CONNECT localhost:Pw`、`CONNECT localhost:Ps`                                                                                                        | `out/results.json` 的 `reverse:before(proxied)` 项                                                                                                |
| 2. 另一个 partition 保持直连                                                                                                                | **通过**。`direct-control(virtual ports)`：`ERR_CONNECTION_REFUSED`，代理日志空；`direct-control(real ports)`：直接可达                                                                                                                            | `results.json`                                                                                                                                    |
| 3. `location.origin` 不变                                                                                                                   | **通过**。每一项的 `origin` 都是 `http://localhost:<虚拟端口>`                                                                                                                                                                                     | `results.json`                                                                                                                                    |
| 4. PAC 能按主机分流                                                                                                                         | **部分**：PAC 对非回环主机生效（`pac-control/direct.test-page`：代理收到 `http://direct.test:P/page`），但**抓不到回环地址**（`pac-control/loopback-page`：`ERR_CONNECTION_REFUSED`），`proxyBypassRules` 在 PAC 模式下无效。三种 PAC 写法结果一致 | `results.json` 的 `pac-control/*`；`out-run1/stdout.txt` 的 `pac_plain/pac_negloop/pac_data_url`                                                  |
| 5. 桌面预览用 webview 还是 WebContentsView，都遵守代理                                                                                      | **通过**。预览实际用 `<webview>`；`WebContentsView` 同一规则串下结果完全相同                                                                                                                                                                       | `out-run1/stdout.txt` 的 `webview/fixed_star_negloop` 与 `webcontentsview/fixed_star_negloop`（第二轮没有重测 WebContentsView，第一轮的结果完整） |

**额外项：**

| 项                          | 结果                                                                                                                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 规则串 `<-loopback>` 单独用 | 回环过代理，**但 `direct.test` 也被拖进代理**（`out-run1`，`webview/fixed_negloop_only`），不可用                                                                                         |
| 不设 bypass                 | 回环直连，`ERR_CONNECTION_REFUSED`                                                                                                                                                        |
| 运行时可逆                  | 通过：`reverse:after-direct` 失败且代理日志空，`reverse:after-reproxy` 恢复                                                                                                               |
| 连接复用                    | 顺序 30 个请求新代理连接 0；并发 40 个 5；10 个 WebSocket 10                                                                                                                              |
| 未许可端口                  | 主框架：代理回的 403 HTML 显示（`blocked-port-main-frame`）；子资源：`Failed to fetch`                                                                                                    |
| 代理认证                    | 通过（`proxy-auth`）：两个分区各自口令；`loginEvents` 两条，`webContentsType: "webview"`；`externalClientWithoutSecret`：`407 Proxy Authentication Required`                              |
| 主机写法                    | 见 §1.2 和 `out/hosts.json`：`0.0.0.0`、`[::]`、`localhost.localdomain` 不过代理；`[::ffff:127.0.0.1]` 过代理且写法变成 `[::ffff:7f00:1]`                                                 |
| 第一轮卡住                  | 直连对照的"真实端口"一步没返回。第二轮给页面里每个子测试加了 3 秒超时后完整跑完，在直连对照里 `127.0.0.2` 超时、`[::1]` 失败（macOS 的 lo0 只有 127.0.0.1；服务也没绑 `::1`），与网关无关 |

### 第二轮追加的实测（2026-11-04）

全部在 `/tmp/t3x-gateway-design/spike/` 下，不进仓库；进程都按记录的 PID 停止，没有残留。

| 项                               | 结果                                                                                                                                                                                                                                                     | 证据                                                                                                    |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 按 PID 复核监听（macOS 26）      | `lsof -a -p <pid> -iTCP:<port> -sTCP:LISTEN -nP` 对真正的监听者输出一行，含绑定地址（`127.0.0.1:55005`）；对别的 PID（这个 shell）退出码 1、无输出；监听者退出后同一命令退出码 1。三种情形足以区分"还是它""换了人""已退出"                               | `spike/out/pid-verify.txt`、`listener.cjs`                                                              |
| 按 PID 读 agent 标记             | `ps -E -p <pid> -ww -o command=` 能看到该进程启动环境里的 `T3CODE_THREAD_ID=spike-thread`（测试进程是带这个环境变量启动的）。这证明复核时可以重新读标记，不必信快照                                                                                      | 同上                                                                                                    |
| `node --inspect=0` 的额外监听    | 进程只有 `-e` 一行代码、没有任何自己的监听，却在随机端口 `127.0.0.1:55021` 上有一个 LISTEN（调试器），启动时在 stderr 打印 `Debugger listening on ws://127.0.0.1:55021/…`。结论：带 `--inspect*` 的进程，它**所有**监听都要排除，不能只屏蔽 9229（§5.7） | `spike/out/pid-verify.txt` 末段、`out/inspect-stdout.txt`                                               |
| Local Network Access（预览分区） | 见 §6.8：`loopback-network` 授予、`local-network*` 拒绝；权限处理器只收到 `check` 没有收到 `request`；标成公网地址空间的页面访问回环地址有无代理都成功；把处理器改成拒绝后查询变 `denied` 但请求仍成功。**无法确认** Chromium 把测试页当成了公网地址空间 | `spike/main5.cjs`、`out/lna.json`、`out/lna-deny.json`、`out/lna-stdout.txt`、`out/lna-deny-stdout.txt` |
| 没有做的                         | 没有测 `setProxy` 对 Service Worker、prefetch、`sendBeacon`、无痕分区、新 profile 的覆盖（GPT P2-1）：这一轮是设计修订，这些列进 9.2 的真实 Electron 冒烟验收（§2.3、§12）。没有测 Linux `/proc` 和 Windows `netstat` 的复核                             |                                                                                                         |

## 附录 B：对 PR #8841 的评价

材料：`gh pr view/diff 8841 -R pingdotgg/t3code`，保存在 `/tmp/t3x-gateway-design/pr8841/`。

**它是什么**：`feat(preview): route remote ports through t3 connect`，作者 maria-rcks，2026-08-31 开，**2026-09-21 由作者自己关闭**，未合并，+2447/−43，39 个文件，标签 `vouch:trusted`、`size:XXL`。没有维护者评论；只有机器人：CodeRabbit 跳过审查，Macroscope 判"不可批准，涉及认证的代理、签名票据、授权逻辑，需要人工审查"并给出若干 UI 一致性和 Effect 约定发现，Cursor Bugbot 报 2 个问题。关闭原因查不到。

**机制放在哪一层**（三层）：

1. server：`apps/server/src/preview/Gateway.ts` 在 `/api/preview-gateway/http` 和 `/ws` 两条路由上做**逐请求的 L7 转发**：请求头 `x-t3-preview-gateway-target` 给出完整回环 URL，`x-t3-preview-gateway-ticket` 给票据；用 Effect `HttpClient` 重发请求、流式回写；WebSocket 用 `Socket.makeWebSocket` 对接。票据 `GatewayTicket.ts`：HMAC，载荷只有 `{ version, kind, port, expiresAt }`，5 分钟，签名密钥是 `ServerSecretStore` 里一个专用密钥。
2. 桌面：`PreviewGatewayProxy.ts`（429 行）在主进程起 `127.0.0.1` 的 `node:http` 代理，普通请求转成对网关 HTTP 路由的请求，`CONNECT` 对 WebSocket 做隧道，再升级到网关的 WS 路由；`BrowserSession.ts` 里 `configureGateway` 用 `setProxy({ mode: "fixed_servers", proxyRules: "http=http://127.0.0.1:P;https=direct://;socks=http://127.0.0.1:P", proxyBypassRules: "*;<-loopback>;169.254.0.0/16;fe80::/10;loopback" })`。
3. web：`usePreparePreviewGatewayNavigation` 在导航前取票据并配置代理；`HostedBrowserWebview` 里读文档里的 `t3-preview-gateway-error` meta 标签来识别网关错误；`browserTargetResolver` 把原来抛的 "planned authenticated preview gateway" 换成 `environment-gateway` 解析结果。

**可以借鉴**：

- `fixed_servers` + `*;<-loopback>` 这条规则串（我们独立实测确认）。
- WebSocket 走 `CONNECT` 再升级的思路（实测 Chromium 就是这样发的）。
- 响应头与逐跳头的清理清单、`Host` 的处理。
- 它的测试覆盖面：HTTP、流式、重定向、cookie、WebSocket、HMR、过期票据、跨环境票据、无 operate 权限。
- 导航前准备、失败要解封 webview 并提示（Macroscope 指出的两个失败路径回归，我们的"网关已登记"门和错误卡片要避免）。

**不借鉴**：

- 票据只含端口和过期时间，不绑会话，**撤销不了**，也没有"只许可 T3 起的服务"：任何有 operate 权限的会话请求任意回环端口都发票。
- 逐请求 L7 转发：每个请求都在 server 上走一遍 `HttpClient`，Header 改写和 cookie 处理（`replaceCookies`）是 bug 面；字节隧道没有这些。
- `https=direct://`：`https://localhost` 不转发，自签名 HTTPS 的 dev server 用不了。
- 每个端口单独配置代理（`configure(port)`）并在导航时才配：页面里发往另一个端口的请求（前端调后端）要先有人配置才通。我们按"端口许可"在 B 端决定。
- 我读到的主进程代理部分（diff 的中段有约 4,800 字符被输出截断，没读到）里没有看到对本机其他进程的认证；我们要求 `Proxy-Authorization`。
- 它面向 T3 Connect（"通过中继"）场景，我们不用中继。
- 体量 2,447 行，上游文件 39 个，对合并不友好。

**为什么没合**：查得到的只有：作者自行关闭，无说明；机器人给出了未处理的发现；体量 XXL；核心授权问题（票据绑定、许可范围）没有被讨论过。之后上游在 10 月合并了 #15328（服务端浏览器）和 #17316（桌面本地渲染远程标签页），反而制造了本地渲染的缺口：#26890、#27625（维护者 10 月 30 日确认"Forwarding remote loopback ports to locally rendered tabs isn't implemented yet. The code refers to it as a planned authenticated preview gateway."，临时办法是「在 X 的浏览器中打开」、`ssh -L`、或让服务监听 A 能访问的地址）。#26469（SSH 自动端口转发）也已关闭未合并。

**对我们的价值**：它证明了"session 级代理 + 本地渲染"这条路线在 Chromium 上可行，我们的 spike 独立验证了它的核心规则串；差别在服务端的授权模型和传输层，这两处是我们按 fork 的需求（自建隧道、撤销、只许可 T3 起的服务）重新设计的。

## 附录 C：网页版这次不做

用户问过要不要做网页版。建议这次不做，理由：

1. 普通浏览器拦不住页面发往 `127.0.0.1` 的请求，没有 `setProxy` 可用。要让页面连到 B，只能把页面换到真实的代理地址（例如 `https://<某个站点>/…` 里的 iframe），页面的 origin 就不再是 `localhost`。前端调另一个本机端口、OAuth 回调到 `localhost`、按 `location.hostname` 判断环境的代码这类用法会坏。这与"地址栏保持原样、origin 是 localhost"的要求冲突。
2. 安全隔离需要给代理单独一个站点（与 T3 的应用 origin 不同），否则代理出来的页面和 T3 的页面同源，能读 T3 的会话。在 VPS 上这意味着多配 DNS（通配子域）、证书（通配或按需）和 frps 路由。
3. agent 控制不了 iframe 里的页面（跨域、没有 CDP）。

将来要做，需要：独立的、不与应用同源的代理站点和证书；一个 Service Worker 或 iframe 代理方案；接受 origin 变化的用法损坏；agent 工具对这种标签页不可用的说明。这里不展开。手机保持上游现状：在 B 上运行浏览器，画面以截图流传来。

## 附录 D：GPT 评审发现与主控决定的对应表

D.1–D.3 是第二轮：评审文件 `/tmp/t3x-gateway-design-review/findings.md`，结论"改完下列项再实现"，下表每一项列出改在哪一节，以及有没有没完全采纳的地方（及理由）。D.4 是第三轮：GPT 对第二版的复核。D.1–D.3 记录第二轮当时的处理，其中后来被第三轮修订的部分（2 秒缓存、`100.x` 的 Tailscale 判定、E2 的写法、Windows 只做 C1、N1–N7 的待确认）以 D.4 和 §14.1 为准。

### D.1 GPT 发现

| 发现 | 内容                                                | 改在哪里                                                                                                                                                            | 采纳情况                                                                                                                                                                                                                                                   |
| ---- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1 | 票据 audience 不严格（`EnvironmentAuth.ts:1256`）   | §4.4（fork 自己的 `authenticateGatewayTicket`，严格 `audience === "loopback-gateway"`，保留 MCP 拒绝）、§4.2、§12 9.1 验收                                          | **采纳。** 不复用 `authenticateWebSocketUpgrade`，不改上游认证函数；反向（网关票据打 `/ws`、媒体路由）也有测试                                                                                                                                             |
| P0-2 | 票据进入请求日志/遥测（`serverLogger.ts:14`）       | §4.3（票据移到 `Authorization: T3X-Gateway` 头；query 里有 `wsTicket` 返回 400；日志、span、诊断的不泄露测试）、§3.4（Caddy/frp）、§12                              | **采纳，做法有一处与主控指令不同（N2）**：头用 `Authorization` 的自定义方案而不是自造头名，理由是 Effect 与 Caddy 的默认日志都遮蔽 `Authorization`；已逐处查证没有认证代码把这个方案当会话凭据，并有测试。主控要自造头名的话改动很小（N2）                 |
| P1-1 | 端口许可的快照 TOCTOU                               | §5.3（拨号前按 PID 定点复核，各平台命令，缓存 ≤2 秒，窗口大小分析，PID 复用，SO_REUSEPORT）、§5.5、§12 9.1 验收                                                     | **采纳**，并且让 Q4 的"记录绑定地址"不再需要（N4）。残余窗口写明在 §5.3                                                                                                                                                                                    |
| P1-2 | A 端 `login` 处理的前置条件                         | §4.7（四个条件；与上游已有 `login` 处理的共存分析：`apps/desktop/src` 里没有）、§12 9.2 验收                                                                        | **采纳**                                                                                                                                                                                                                                                   |
| P1-3 | 本机其他用户的威胁边界                              | §4.7（口令只在主进程内存、不进 URL/日志/渲染进程）、§3.7（代理层连接数与速率上限）、§12 9.2 验收（外部客户端只得到 407）                                            | **部分采纳。** 口令、限制、验收都采纳。**不采纳：** "Unix domain socket 或校验 peer credentials 作为增强项"：Chromium 的代理设置不支持 Unix socket（已在 §4.7 写明），Node 对 TCP 连接没有取 peer 凭据的接口；只能留在"以后再做"的思路里，等 Chromium 支持 |
| P1-4 | 排除清单有未核实的监听口                            | §5.6（5.6.1 所有监听点的源码扫描清单；5.6.2 所有长期子进程；5.6.3 规则 E1–E5；5.6.4 完整 server 自检与防漂移测试；回答了 provider 运行时是否带 `T3CODE_THREAD_ID`） | **采纳，规则有取舍：** 带 `T3CODE_THREAD_ID` 的 provider 运行时（实际有，Claude CLI）按 PID/祖先/直接子进程排除，**但只排除 server 直接子进程里属于 agent 归属的项**（E2），否则会把 agent 的作业一起排除掉；理由见 §5.6.3                                 |
| P1-5 | 撤销"立即关闭"证据不足                              | §4.8（三条路径的表：会话撤销、自然过期、设备移除经 8.2 对账；续期链 N1）、§12 9.1 验收（真实 server 层 + 真实 `ws` 客户端，两端都验证，四个竞速场景）               | **采纳**                                                                                                                                                                                                                                                   |
| P1-6 | 威胁模型缺页面对 dev server 特殊路由的约束          | §6.7（完整网络接口权限，五个验收用例）、§6.8（LNA 实测）、§5.7（调试进程整进程排除的结论）                                                                          | **采纳。** 调试进程"整进程排除"的结论：做，因为 `--inspect=0` 会开随机的第二个监听（附录 A 实测）。LNA：设计不依赖它，不改 `ALLOWED_PREVIEW_PERMISSIONS`                                                                                                   |
| P1-7 | 支持矩阵结论过早                                    | §3.5（未验证项降为"待验证"）、§4.6（明文局域网不启用）、§12 9.4（每种连接方式的 WS、长连接、重连、证书、并发）、§14.3                                               | **采纳**                                                                                                                                                                                                                                                   |
| P1-8 | 上游改动预算偏乐观                                  | §13（重算：约 +70 行、23 个文件；停止线 130；超线的削减方案）、§12 各阶段结束时按实际 diff 重估                                                                     | **采纳。** 结果比上一版（+85）小，因为不再改 `PortScanner` 记录（N4）；GPT 担心的几项大多在 fork 文件里，上游行数是 0                                                                                                                                      |
| P2-1 | `setProxy` 对 service worker 等的真实 Electron 验收 | §2.3（`getPreviewConfig` 钩子保证新 profile 首次导航前有代理；覆盖清单）、§12 9.2                                                                                   | **采纳为验收项**；这一轮没有实测（附录 A "没有做的"）                                                                                                                                                                                                      |
| P2-2 | `disabled-by-user` 的标识和恢复入口                 | §7.1、§10、§12 9.3                                                                                                                                                  | **采纳**                                                                                                                                                                                                                                                   |
| P2-3 | 回环判定和规范化共用一个函数                        | §12 9.2（放在 `packages/shared/src/forkLoopbackGateway/`）、§1.2                                                                                                    | **采纳**                                                                                                                                                                                                                                                   |
| P2-4 | 资源上限在最低层 socket harness 测                  | §3.7（上限表）、§12 9.1/9.2 验收                                                                                                                                    | **采纳**                                                                                                                                                                                                                                                   |

### D.2 GPT 对主控拍板问题的意见

| 问题 | GPT 意见                                   | 结果                                                                                  |
| ---- | ------------------------------------------ | ------------------------------------------------------------------------------------- |
| Q1   | 反对默认启用明文局域网                     | 采纳，主控改为只在加密或本机连接上启用（§4.6）。DPoP 逐次签证明留作以后加固（§12 末） |
| Q2   | 同意不算                                   | 不变（§5.2）                                                                          |
| Q3   | 同意屏蔽                                   | 不变，N5 建议再加两个端口                                                             |
| Q4   | 同意，但还要拨号前复核                     | 复核采纳；记录绑定类别改由复核给出（N4）                                              |
| Q5   | 同意两个 scope                             | 不变                                                                                  |
| Q6   | 同意不加开关，要补 `disabled-by-user` 标识 | 采纳（§7.1）                                                                          |
| Q7   | 同意，要在 UI/文档明说"按环境生效"         | 采纳（§7.1、§10、§12 9.4 文档）                                                       |
| Q8   | 同意，规范化只用于显示/已知 Preview URL    | 采纳，规范化不参与安全判断（§12 9.2）                                                 |
| Q9   | 同意分阶段，但 9.0 必须加入五项最小验证    | 主控改为没有独立 9.0；这五项成为 9.1/9.2 的验收项，两个技术前提是第一步（§12）        |

### D.3 没有完全采纳或做法不同的汇总

1. **P1-3 的 Unix socket / peer credentials：** 技术上做不到（Chromium 代理不支持，Node 无 TCP peer 凭据）。
2. **P0-2 的头名（N2）：** 用 `Authorization: T3X-Gateway`，与主控"专用请求头"的默认不同；是否改见 N2。
3. **P0-1/N1 的 `jkt`：** 与主控"不绑 jkt"字面不同：写入 `jkt` 仅作续期链的键，路由不要求出示证明；是否改见 N1。
4. **Q4（N4）：** 目的达成，做法不同。
5. **P1-4 的 E2：** 只排除 server 直接子进程里 agent 归属的项，避免误杀 agent 作业。
6. **Windows（N6）：** 评审没有提；我们发现 Windows 没有 E2/E5 的读取路径，建议第一版不广告能力。

### D.4 第三轮：GPT 对第二版的复核（`/tmp/t3x-gateway-design-review/recheck.md`）与主控决定

复核结论仍是「改完下列项再实现」。主控的处理：复核里的其余内容，有的转成 9.1 开工的关口，有的写进验收项；这一轮改完后主控审一遍 diff 就合入，不再送复审，实现阶段每一步都过 GPT review。

| 复核项 | 内容                                                                   | 改在哪里                                                                                                                                                | 处理结果                                                                                                                                                                                                                                                             |
| ------ | ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P0-1   | N3 传输矩阵自相矛盾，明文 `100.x` 可能被启用                           | §3.5 的表、§4.6 的表和判定说明、§8 的状态与门、§7.2 的卡片、§12 9.3 的表格测试和性质测试、§0                                                            | **采纳。** 删掉三行 `100.x` 的 `tailnet` 结果；判定直接调用上游 `isTailnetHost`；明文 `100.x` 是 `insecure-transport`，带 `hint: "tailscale-address"` 让卡片提示改用 MagicDNS 名字或 HTTPS；性质测试加"任何 `100.64.0.0/10` 的 `http:` 一定不通过"                   |
| P0-2   | 日志安全没有形成可验证机制，"默认遮蔽"不是依据                         | §4.3（显式脱敏、引用依据、守卫测试、sink 全覆盖）、§3.4（Caddy 与 frps）、§12 9.1/9.4、§14.2                                                            | **采纳。** 入口立刻 `Redacted`，错误、诊断、span 属性不带请求头；每个失败路径和 `--log-ws-events` 开关都有 sink 测试；守卫测试（`CurrentRedactedNames`、`TracerHeaderFilter`、赋值点扫描）；Caddy、frps 在 9.4 逐项实测之后才能把 P0-2 标为解决                      |
| P1-1   | 2 秒复核缓存仍允许真实的 owner 交换                                    | §5.3（无缓存、身份 = pid + 启动时间、各平台读法、成本和实测、剩余窗口）、§11、§12 9.1                                                                   | **采纳，字面要求处有一处调整。** 缓存去掉，每条隧道现场核对。"和快照比启动时间"做不到（快照没有启动时间，改 `PortScanner` 与 N4 冲突），改为现场重新证明有主 + C0/C3 同一实例的两次身份读取，结论更强；差别和回退方案写在 §5.3                                       |
| P1-2   | 监听点清单仍有"未核实"项                                               | §5.6.0（9.1 第一道关）、§5.6.1（补第二版漏掉的 cloudflared 指标监听、`CodexManagedTokenBroker` 的非 TCP 依据、`antigravityCallback` 是客户端）、§12 9.1 | **采纳。** 变成 9.1 关口 A，网关路由要等它过了才开始写；拿不准的一律排除；`tasks/todo.md` 里是排在路由之前的勾选项。本轮已先读码得到能得到的部分                                                                                                                     |
| P1-3   | E2 对 provider 运行时的假设不成立，孤儿运行时可获许可                  | §5.6.2（每个 provider 的实际进程树）、§5.6.3（E2 登记、E3 默认拒绝、E4 特征、E5 后代限定）、§12 9.1 关口 B                                              | **采纳（主控第 5 条 a/b/c）。** 逐个读代码画了进程树（Claude 的看守脚本、Codex 的 Effect spawner、OpenCode 的账本、ACP 的 `AcpSessionRuntime`、Pi、Muse）；孤儿靠特征排除；认不出特征且寿命不受 server 约束的归 E5；写明了哪些 provider 转发不了脱离父进程的后台作业 |
| P1-4   | Windows 只做 C1 与所有平台的安全边界不匹配                             | §5.3 的平台表、§5.6.5、§8、§12 9.1                                                                                                                      | **采纳（N6）。** Windows 的 B 不广告能力，删掉"只做 C1"的写法。另加：Linux 在容器里的真实进程测试通过前同样不广告                                                                                                                                                    |
| P1-5   | N1 的续期链语义要写成可接受的 bearer 延长                              | §4.8（接受的取舍、三个新增测试、顺序测试）、§4.2、§12 9.1 验收                                                                                          | **采纳。** 写明"最多活到设备会话链结束或被撤销"；补三个测试；保留 `EnvironmentAuth.ts:1256` 先于 `:1261` 的顺序测试                                                                                                                                                  |
| P2-1   | 自定义 `Authorization` 方案的中间件测试、frp/Caddy 保留头              | §4.3（中间件测试）、§4.9（限流器）、§12 9.1 验收、9.4                                                                                                   | **采纳为验收项**                                                                                                                                                                                                                                                     |
| P2-2   | Linux/Windows 命令、`SO_REUSEPORT`、双栈、启动时间进 harness           | §5.3 末尾的测试清单、§12 9.1                                                                                                                            | **采纳。** 解析函数用记录的真实输出做夹具（所有平台）；真实进程测试 macOS 本机、Linux 在容器里；Windows 不支持                                                                                                                                                       |
| P2-3   | 固定禁止重定向、连接建立后不换 base URL；TLS 失败保持失败              | §3.6、§10（路由切换）、§12 9.2                                                                                                                          | **采纳。** `followRedirects: false`；`{ baseUrl, ticket }` 一对在安装时固定；路由换了重新判加密与否并换新票据；N7 不并入系统根证书                                                                                                                                   |
| P2-4   | Vite `/@fs/`、source map、`*.localhost`、映射 IPv6、DNS rebinding 用例 | §6.7（改为 9.4 的端到端验收，加 source map 用例）、§12 9.4                                                                                              | **采纳。** 放进 9.4                                                                                                                                                                                                                                                  |

复核对 N1–N7 的意见：

| 项  | 复核意见                                          | 结果               |
| --- | ------------------------------------------------- | ------------------ |
| N1  | 同意，但必须以链撤销/设备移除的真实关闭测试为前提 | 三个新测试（§4.8） |
| N2  | 有条件同意，必须显式脱敏并实测 Caddy/frp          | §4.3、§12 9.4      |
| N3  | 同意主控决定，当前表格错误                        | 已改（P0-1）       |
| N4  | 同意，2 秒缓存需主控接受或去掉                    | 去掉               |
| N5  | 同意                                              | 8 个端口           |
| N6  | 同意；若仍支持 Windows 必须 fail-closed           | 不广告             |
| N7  | 同意；TLS scheme 不能当作已建立的安全连接         | §3.6               |

复核里"上一轮发现的处理情况"一节标为**部分解决**的几项，这一轮后的状态：

- P0-2、P1-1、P1-4（排除清单）、P1-7（支持矩阵）：上面已处理，实现与实测后才能关闭。
- P1-3（本机其他用户）：持有口令的本机进程仍可使用代理，peer credentials/Unix socket 因 Chromium 代理不支持而做不到（D.3 第 1 条），这是明确保留的限制，不是遗漏。
- P1-5（撤销关闭传播）：实际代码是否会在 loopback 路由里调用 `awaitInvalidation` 并关闭两端，要实现之后用 §4.8 的测试证明。
- P1-6（dev server 特殊路由）：Vite `/@fs/`、source map 等具体用例已写入 9.4 的验收（§6.7）。

D.3 里两条"是否改见 N1/N2"的待确认项已由主控定下（保持），见 §14.1。
