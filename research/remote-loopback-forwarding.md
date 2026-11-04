# 远程环境的本机服务转发（桌面版）设计

2026-11-04。基线：fork `8328902b94`，上游同步点 `322f6544df`，上游 main `8b44f42b14`。只做设计，没有实现代码。

场景：A 的 T3 Extend 桌面版打开 B 上的对话，B 的 T3 终端或 agent 起了只监听回环地址的服务（例如 `127.0.0.1:5173` 的 Vite）。用户在内置浏览器输入 `http://localhost:5173`，地址栏不变，页面在 A 本地渲染，请求在后台经 A 到 B 的现有连接转到 B 的回环地址。

## 0. 结论与推荐方案

第二轮修订（2026-11-04）：按 GPT 的安全审查（`/tmp/t3x-gateway-design-review/findings.md`，结论「改完再实现」）和主控的决定修改。每条发现改在哪一节见附录 D。

**一句话：** 在 A 的桌面主进程里为每个远程环境起一个只绑 `127.0.0.1` 的 HTTP 代理，用 `session.setProxy` 把该环境所有分区的回环流量导给它；代理为每条 TCP 连接开一个到 B 的 WebSocket 隧道；B 的网关只在目标端口属于"T3 终端或 agent 起的服务"、拨号前经过按 PID 的定点复核、且不在排除清单里时，才拨 B 的回环地址。**只在加密或本机的连接上启用**；明文局域网不启用。

```
A 渲染进程                         A 主进程                            B (server)
 <webview partition=env B>  ──►  127.0.0.1:随机口 (代理, Proxy-Authorization)
   localhost:5173                  │ HTTP: 每个请求按目标端口选隧道 (keep-alive 池)
   ws://localhost:5173 (CONNECT)   │ CONNECT: 一条隧道 = 一条 Chromium 连接
   https://localhost:5173 (CONNECT)│ 先过传输检查：https / 回环 / Tailscale 才继续
                                   └─ wss://<B 的地址>/api/loopback-gateway/tunnel?port=5173
                                        Authorization: T3X-Gateway <票据>  ──►  同一 router，
                                                                          主监听口和隧道监听口都有
                                                                          ① 严格 audience 的票据 → 会话 → 两个 scope
                                                                          ② 端口许可（端口发现快照）
                                                                          ③ 按 PID 定点复核 + 排除清单
                                                                          ④ 拨复核得到的那个回环地址
```

关键决定（每条的理由在对应章节）：

| 问题             | 决定                                                                                                                                                                                                                | 依据                     |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| A 端怎样改走转发 | `setProxy({ mode: "fixed_servers", proxyRules: "http://127.0.0.1:<端口>", proxyBypassRules: "*;<-loopback>" })`                                                                                                     | spike 实测（§1、附录 A） |
| 分区             | **上游已经按环境分区**；代理装在 `getPreviewConfig` 的处理里，保证任何分区（含新建的 profile、无痕）在首次导航前就有代理                                                                                            | §2                       |
| 传输             | 每条 TCP 连接一个 WebSocket，不多路复用；B 端是纯 TCP 通道，不解析 HTTP                                                                                                                                             | §3                       |
| 启用条件         | 只在 `https:`、回环（含 SSH 转发端口和本机）、Tailscale 地址上启用；明文局域网为 `unsupported-route`（`insecure-transport`），走旧行为                                                                              | §4.6                     |
| 认证             | RPC 取会话级 WS 票据（新 audience，5 分钟，可复用），经 IPC 交给主进程；主进程用 `ws` 自己带 `Authorization: T3X-Gateway <票据>` 头；网关路由用 fork 自己的认证函数，**严格**要求 `audience === "loopback-gateway"` | §4.2–§4.4                |
| 票据不进 URL     | query 里出现 `wsTicket` 直接 400；日志、span、错误诊断里找不到票据由测试保证                                                                                                                                        | §4.3                     |
| 权限             | 要求 `preview:operate` **和** `terminal:operate`                                                                                                                                                                    | §4.5                     |
| 端口许可         | 快照里"有主" + **拨号前按 PID 的定点复核**（PID 还活着、仍在这个端口和地址上 LISTEN）；Preview URL 配置项不算                                                                                                       | §5                       |
| 排除             | T3 server 进程自己、它的祖先、它的直接子进程里的 agent 归属项、设备 hub 子树、T3 自己的端口、调试端口表、带调试参数的进程；实现前逐项列出所有监听点和长期子进程                                                     | §5.6、§5.7               |
| 退路             | B 不支持、端口不允许、明文链路、中继、用户关闭：保持现有行为，错误卡片给「在 B 的浏览器中打开」                                                                                                                     | §8                       |
| 支持矩阵         | 没验证过的连接方式一律标"待验证"，9.4 逐种测 WS、长连接、重连、证书                                                                                                                                                 | §3.5                     |
| 阶段             | 没有独立的 9.0：B 端的两个技术前提是 9.1 第一步，A 端的是 9.2 第一步，失败就停下回报                                                                                                                                | §12                      |
| 网页版           | 这次不做                                                                                                                                                                                                            | 附录 C                   |

规模：新代码在 `apps/*/src/fork/`、`packages/*/src/fork*` 约 2,800 行（含测试约 4,800），上游文件约 +70 行、23 个文件（§13），低于 130 行停止线；审查要求的安全基础设施（严格认证、日志脱敏、`login` 条件、定点复核、排除登记）全部在 fork 文件里。

和主控指令不同或需要主控确认的几点集中在 §14 的 N1–N7，最重要的两条：N1，票据为了活过 DPoP 会话的每小时续期，需要把会话的密钥指纹作为"续期链的键"写进票据（路由不要求出示 DPoP 证明，仍是 bearer）；N2，票据头用 `Authorization` 的自定义方案 `T3X-Gateway`，而不是自造请求头名（理由：Effect 和 Caddy 的默认日志都会遮蔽 `Authorization`，我查过 server 里没有任何东西会把这个方案当会话凭据解析）。

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

渲染端 `HostedBrowserWebview` 在 `config` 之外多等一个"网关已登记"的 promise（上游 +3 行，§13）。如果不等，应用刚启动恢复标签页时，第一个回环请求可能在 `register` 到达主进程之前就发出，直连 A 自己的 `localhost`，可能连到 A 上同端口的无关服务。`register` 是本机 IPC，不等网络，所以等待不会让页面变慢。

真实 Electron 冒烟（9.2）要覆盖 `setProxy` 之外的网络路径（GPT P2-1）：Service Worker 发起的请求、`<link rel=prefetch>`/`preconnect`、`navigator.sendBeacon`、WebSocket、无痕分区（非 `persist:`）、新 profile 第一次导航之前、`webContents.session.fetch`（favicon）、下载。每一项断言代理日志里看到了请求，或者明确记录它不经过代理。

### 2.4 分区之后会坏什么

- **没有新的破坏。** 分区本来就是这样分的，外部网站登录、passkey 都已经是"每个环境一份"。
- 语义变化：环境 B 的分区里，`localhost`、`127.x`、`[::1]` 永远指 B。想在 B 的对话里打开 A 自己的 `localhost:3000`，只能用系统浏览器，或者用本机环境对话里的标签页。要写进用户文档和徽标的提示里。
- OAuth 回调到 `http://localhost:<随机口>/callback` 的登录流程：回调的接收方如果是 A 上的 CLI，在 B 的分区里会连到 B。这是已知限制，写进文档。
- WSL 等 `isDesktopLocalConnectionTarget` 的环境，回环地址与 A 共享，**不装代理**（沿用 `reachesEnvironmentLoopback`）。

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

**A 端的第一步（9.2 开头）要验证的实现细节：** `http.Agent` 的 `createConnection` 返回自定义 `Duplex` 时缺少 `setKeepAlive/setNoDelay/setTimeout/ref/unref`，要补空实现；SSE、分块、`100-continue`、大上传、keep-alive 复用都要有测试；`ws` 的 `createWebSocketStream` 到 B 的通路；是否并入系统根证书（§3.6）。任何一项做不成就停下回报。

### 3.3 B 端网关路由

`GET /api/loopback-gateway/tunnel?port=<n>`，WebSocket 升级，**票据在 `Authorization` 头里，不在 URL 里**。挂在 **共享的 `HttpRouter`** 上，所以 `TunnelListener.withTunnel` 的第二个监听口（frpc 的 `localPort`）自动也有这条路由：`TunnelListener.ts` 的注释写明它"serves the application a second time"，复用同一个 router。主监听口（局域网、Tailscale、SSH 转发）和自建隧道因此用同一份代码，不需要为隧道口写任何特别逻辑。

处理顺序（全部在升级之前，失败返回带 JSON 的 HTTP 状态，Node 的 `ws` 客户端能从 `unexpected-response` 读到）：

1. fork 自己的认证函数 `authenticateGatewayTicket`（§4.4）：query 里有 `wsTicket` → 400；带 `Origin` → 403；`Authorization` 方案不是 `T3X-Gateway` → 401；票据验证；**严格** audience；两个 scope。
2. 并发与速率上限（§3.7）。
3. 端口许可、定点复核、排除（§5.3）。
4. 在**开始等待会话失效之后**才拨号：先启动 `sessions.awaitInvalidation`，再拨 §5.3 复核得到的那个地址，超时 3 秒；拨号期间会话被撤销就放弃拨号。失败 → `502 { code: "upstream-refused" }`。
5. 接受升级，建立双向管道：二进制帧 = TCP 字节，不用文本帧；B 每 30 秒发 WS ping，90 秒收不到 pong 就关；有任一端关闭就关另一端（TCP 和 WS 两端都要销毁，§4.8 逐条测）。
6. 与会话的失效竞速：和 `ws.ts` 里 `/ws` 路由一样用 `raceFirst`。**不调用** `markConnected`（隧道不是"一个已连接的客户端"，不应出现在连接列表里；`revoke` 总会发布 `clientRemoved`，不依赖 `markConnected`，已核对 `SessionStore.ts:988-1006`）。

不设空闲超时。理由：Vite 的 HMR 客户端在 WebSocket 非正常关闭后会轮询并 `location.reload()`，空闲超时会让页面莫名重载；靠存活探测和两端关闭传播就够。

**B 端的第一步（9.1 开头）要验证的技术前提：** 共享 `HttpRouter` 上的升级路由，把 `request.upgrade` 的 Socket 对接到 `net.connect`，确认主监听口和 `TunnelListener` 口都能用；背压（写慢的一端会不会无限缓冲）；`awaitInvalidation` 竞速能关闭它。做不成就改用 `ws` 的流接口，再不行停下回报。

### 3.4 与 Caddy、frp 的关系

从仓库配置读到的，不是新测的：

- `infra/self-host/Caddyfile` 的 `reverse_proxy frps:8080` 有 `flush_interval -1`（流式响应立即发出）和 `stream_close_delay 5m`（Caddy 重载后，已升级的 WebSocket 最多再活 5 分钟）。Caddy 对已升级的连接没有空闲超时。
- frpc 到 frps 的控制连接心跳 30 秒、超时 90 秒（`frpcConfig.ts`）；frps 的 vhost HTTP 代理按 Host 路由，WebSocket 升级是 HTTP 反向代理的标准能力。我没有测过 frp 对"几十条并发升级连接"和"长时间空闲连接"的行为，列在 §14 的未验证项里，9.4 在本地试用栈上测。
- B 每 30 秒的 WS ping 同时防住中间设备（NAT、移动网络）因空闲回收映射。
- Caddy 重载或 frps 重启时隧道会断。Chromium 对 HTTP 会重试新连接；Vite HMR 会自己恢复；其他 WebSocket 由页面自己负责，与直连时 dev server 重启一样。
- 票据在 `Authorization` 头里：当前 `Caddyfile` 没有 `log` 指令，所以没有访问日志；就算运维者以后打开，Caddy 的默认日志编码器会遮蔽 `Authorization`（凭记忆，没在本机 Caddy 上验证，9.4 用本地试用栈开 `log` 实测）。不能只靠"默认不开"：9.4 加一条基础设施测试，断言 `Caddyfile` 里没有未加过滤的 `log`，并在 `infra/self-host/README` 里写明。

### 3.5 连接方式与支持矩阵

启用条件由 §4.6 的纯函数决定。"状态"列诚实标注：没有验证过的一律是**待验证**，不写"支持"。

| 连接方式                                                                       | 启用条件                                                                                    | 状态                                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 局域网 `http://`（明文）                                                       | **不启用**，`unsupported-route` / `insecure-transport`，走旧行为                            | 决定（主控 Q1）                                                                                                                                                                |
| 局域网 `https://`                                                              | 启用                                                                                        | 待验证（证书信任，§3.6）                                                                                                                                                       |
| Tailscale 直连 `http://`（`100.64.0.0/10`、`fd7a:115c:a1e0::/48`、`*.ts.net`） | 启用（WireGuard 加密）                                                                      | 待验证（WS 升级、并发、长连接）。注意 N3：上游的 `isTailnetHost` 刻意不把 `100.64.0.0/10` 单独认作 Tailscale                                                                   |
| Tailscale Serve（`https://*.ts.net`）                                          | 启用                                                                                        | 待验证（Serve 对 WS 升级和自定义 `Authorization` 头的转发）                                                                                                                    |
| SSH 环境                                                                       | 启用（`httpBaseUrl` 是 A 上的转发端口 `http://127.0.0.1:<本地口>`，回环；SSH 本身是加密的） | 待验证（经 `packages/ssh/src/tunnel.ts` 的转发口升级 WS、长连接）。这是对 #26890 的修复：现在 `resolveEnvironmentPortTarget` 把 `localhost:5173` 原样指到 A 自己的 `localhost` |
| 自建隧道（`t3x-device`，`https://<名字>.<域名>`）                              | 启用                                                                                        | 待验证（frp 并发升级、长连接、Caddy 重载、重连，§3.4）                                                                                                                         |
| 私有 CA 的 `https://`                                                          | 取决于 §3.6                                                                                 | 待验证                                                                                                                                                                         |
| T3 Connect 中继                                                                | 不启用，`unsupported-route` / `relay`                                                       | 决定：fork 默认没有官方 `.env`，T3 Connect 默认不可用；中继链路对 WebSocket 升级和并发数的限制我们既不拥有也不测试。检测依据是连接目标 `RelayConnectionTarget`                 |
| WSL / 桌面本地目标                                                             | 不需要                                                                                      | 回环共享，保持现状                                                                                                                                                             |

9.4 对每一种"待验证"的方式都要测：打开 WS 隧道、长连接（至少 30 分钟空闲后 HMR 仍能用）、重连（重启 B、断网再通）、证书（公共 CA、私有 CA、过期证书的报错）。验证完才能把这张表里的"待验证"改成"已验证"。

### 3.6 TLS 信任与代理

A 主进程用 Node 的 TLS 连 B。渲染进程（Chromium）信任系统根证书和用户装的私有 CA；Node 默认只信任自带的 Mozilla 根。自建隧道用 Let's Encrypt，Tailscale 的证书也是公共 CA，这两种没问题；若 B 的地址用的是用户系统里信任的私有 CA，主进程也得信任它：Node 24 有 `tls.setDefaultCACertificates()` 和 `tls.getCACertificates("system")`（只确认了函数存在，没有调用，读系统信任库会碰钥匙串相关接口）。**9.2 的第一步**决定是否在主进程启动时把系统根并入默认集合，并在一台装了私有 CA 的机器上验证；在此之前"私有 CA 的 B 地址"是待验证项。另外，主进程的 `ws` **不走系统代理**；A 必须经代理才能到达 B 的情形不支持，网关会报 `offline`。

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

| 属性             | 值                                                                                                                                                                                                                                                                                                                                                                            |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 形态             | `base64url(claims).hmac`，由 `SessionStore` 签发，签名密钥是这台 server 的 `server-signing-key`（别的环境的 server 验不过）                                                                                                                                                                                                                                                   |
| 签发             | RPC `loopbackGateway.issueTicket` 的处理器直接调用 `sessions.issueWebSocketToken(sessionId, { audience: "loopback-gateway", proofKeyThumbprint })`，TTL 用默认的 5 分钟（`DEFAULT_WEBSOCKET_TOKEN_TTL`）。`proofKeyThumbprint` 的含义和为什么要有它见下面的 N1；不采纳 N1 时改用 `EnvironmentAuth.issueWebSocketTicket(session, { use: "loopback-gateway" })`，它不会写入指纹 |
| 有效期内能否复用 | 能。每条隧道的升级请求都带同一张；每次升级都重新读库确认会话未撤销、未过期（`verifyWebSocketToken`）                                                                                                                                                                                                                                                                          |
| 刷新             | 渲染进程在剩余约 40% 时调 RPC 换新的，经 IPC 推给主进程；主进程在剩余不足 60 秒仍没收到新的时，发 `ticket-needed` 事件让渲染进程立刻换。这是一次性的定时器，没有轮询。过期期间新连接得到 401，卡片显示"正在重新连接"，换到票据后下一次加载恢复                                                                                                                                |
| 存放             | 只在主进程内存里；不写盘、不进 URL、不进渲染进程日志、不经 IPC 回传给任何页面                                                                                                                                                                                                                                                                                                 |

#### 签发时怎样不绑 DPoP（回答主控的提醒）

`authenticateWebSocketUpgrade` 里，**票据**带 `jkt`（`session.proofKeyThumbprint`）时才会要求每次使用都出示 DPoP 证明（`EnvironmentAuth.ts:1261`）；DPoP 绑定的**会话**本身并不让它签出的票据自动带 `jkt`。`EnvironmentAuth.issueWebSocketTicket`（`:1216`，条件在 `:1223`）只在 `input?.use === "rpc"` 时才把会话的指纹传给 `SessionStore.issueWebSocketToken`，所以经这个包装、用 `use: "loopback-gateway"` 签发的票据**不带 `jkt`**，即使会话是 DPoP 绑定的。我们的认证函数（§4.4）也从不要求 DPoP 证明：主进程没有私钥，这张票据是 bearer，仅在加密或本机的连接上使用（§4.6）。

「渲染进程为每次升级签一个 DPoP 证明」是将来要支持明文局域网时的方案，列在「以后再做的安全加固」（`tasks/todo.md`）。

#### 一个必须说明的后果：会话续期（N1）

DPoP 会话约每小时换成一个新的会话 id（设备会话 TTL 是 1 小时，`DeviceAssertionAuth.ts` 的 `SESSION_TTL`；续期由 `renewDpopBeforeExpiry` 触发，不替换旧会话）。`SessionStore.awaitInvalidation(sessionId, proofKeyThumbprint?)` 靠这个指纹把"旧会话到期但有继任会话"算作同一个连接（`latestSessionByProofKey`，`SessionStore.ts:711`；链式等待在 `:1082-1099`）。**不传指纹时，旧会话一到期它就返回**（`successorId === undefined`），隧道（包括 Vite 的 HMR WebSocket）每小时断一次；Vite 客户端在非正常断开后会轮询并 `location.reload()`，页面状态丢失。

而 `verifyWebSocketToken` 只会把票据 claims 里的 `jkt` 还给调用方，没有别的渠道知道会话的指纹。所以建议（N1）：**RPC 签发时把会话的指纹写进票据的 `jkt`，仅作续期链的键**。这和"不绑 jkt"在字面上不同，意图相同：

- 网关的认证函数**不**把它当作要出示 DPoP 证明的理由，也不去验证证明；票据仍是 bearer。
- 上游 `/ws` 和媒体路由对这张票据先在 audience 上被拒（`EnvironmentAuth.ts:1256` 在 `:1261` 的 DPoP 逻辑之前），所以带 `jkt` 的网关票据不可能在别处被当成要出示证明的票据，也不可能被当成 RPC 票据。测试覆盖：用这张票据去打 `/ws` 和一个媒体路由，必须得到 audience 拒绝。
- 签发方式相应是直接调用 `sessions.issueWebSocketToken(sessionId, { audience, proofKeyThumbprint })`，不经过 `issueWebSocketTicket` 包装。

如果主控坚持票据里完全没有 `jkt`：退路是隧道在会话到期时关闭，由 A 端代理对 HTTP 无感重连，WebSocket（HMR）每小时断一次。我不推荐。

### 4.3 票据放在哪里：`Authorization: T3X-Gateway <票据>`（N2）

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

#### 为什么选 `Authorization` 而不是自造请求头名

主控的默认是"专用请求头，不要用 `Authorization`，先查清再说"。查清之后我建议用 `Authorization` 的自定义方案，理由是**默认遮蔽**：

- Effect 的 `Headers.CurrentRedactedNames` 默认包含 `authorization`（`cookie`、`set-cookie`、`x-api-key`），日志和 span 里被遮蔽。自造的头名要靠我们登记，漏登记就泄露。
- Caddy 的默认日志编码器会遮蔽 `Authorization`、`Cookie`、`Set-Cookie`、`Proxy-Authorization`（凭记忆，9.4 实测）。自造的头名在运维者打开访问日志时会明文进日志。GPT 的 P0-2 明确说"不能以 Caddy 默认不开 access log 作为保证"。

代价和退路：中间设备如果对 `Authorization` 做特殊处理（企业代理剥掉、frp 的 `httpUser` 基本认证），请求会失败。我们的 frpc 配置没有 `httpUser`/`httpPassword`（`frpcConfig.ts`）；其余留给 9.4 的各连接方式实测。若发现问题，退路是自造头 `X-T3x-Gateway-Ticket`，并在下一条的登记里加上这个名字——实现里头名是一个常量，改动一处。

#### 不进日志的做法和验收

票据泄露的渠道有：console 日志、OTLP 日志、trace 落盘（`LocalFileSpan`）、span 属性、错误诊断（`ServerAuthInvalidCredentialError.diagnostic`）、`--log-ws-events` 打开时 HTTP 错误里的请求 URL（`serverLogger.ts:14` 的注释）、Caddy 和 frps、A 端主进程日志。

- 票据**不在 URL 里**，所以 `serverLogger.ts` 里"请求 URL 带连接票据"的问题（P0-2 的根因）对这条路由不存在。上游已经遮蔽了 query 里的 `wsTicket`（`httpObservability.ts` 的 `UrlParams.CurrentRedactedNames`，以及 `observability.ts:408` 对 cause 文本的正则），这是兜底。
- query 里出现 `wsTicket` 直接 `400 { code: "ticket-in-url" }`，**不读它**，也不把它当票据。
- Effect 的服务端 span 默认不记录任何请求头（`HttpMiddleware.TracerHeaderFilter` 默认 `constFalse`，server 没有打开）。即使将来打开，`authorization` 默认在遮蔽名单里。
- fork 的层把 `authorization` 保留在 `Headers.CurrentRedactedNames` 里：**追加，不替换**（Effect 文档写明自定义名单替换默认值；`packages/shared/src/httpObservability.ts` 已经是追加写法）。如果换用自造头名，同一层追加该名字。
- 认证函数和路由内部不把请求头对象、票据字符串放进任何错误、日志、span、诊断。错误诊断只写固定短语（"gateway ticket rejected: audience"）。
- A 端主进程：隧道客户端的日志和错误不含请求头；`ws` 的错误只带状态码和 URL（URL 不含票据）。

**验收（9.1、9.2）：** 用测试 logger 和测试 tracer 收集所有输出，走完整个请求周期，覆盖成功和每一种失败（错误方案、过期、已撤销、权限不足、端口被拒、拨号失败、处理器内部抛出缺陷），断言所有输出里找不到哨兵票据字符串，也找不到它的任何长度 ≥ 12 的子串。再加一条：`Headers.redact` 对 `authorization` 返回被遮蔽的值。基础设施测试：`Caddyfile` 不含未加过滤的 `log`。

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

### 4.6 只在加密或本机的连接上启用（主控 Q1，已定）

票据是 bearer、不绑 DPoP，所以只在票据不会被同网段嗅探的链路上使用。判定是**一个纯函数**，放在 `packages/shared/src/forkLoopbackGateway/transport.ts`，web 的状态机和桌面主进程共用；主进程在开隧道前自己再调用一次（渲染进程说"启用"也不够）。

输入：环境的 `httpBaseUrl`（`readPreparedConnection(envId).httpBaseUrl`，即**实际会用的那条路由**；路由切换后重新判定）。输出：`{ ok: true, via: "tls" | "loopback" | "tailnet" }` 或 `{ ok: false, reason: "insecure-transport" | "invalid-url" }`。隧道的 scheme 由此推出：`https:` → `wss:`，`http:` → `ws:`。

| `httpBaseUrl`                                                                                                                                                                                 | 结果                                                |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `https://x.t3.example.com`、`https://192.168.1.5:3873`、`https://[2001:db8::1]`                                                                                                               | `tls`（任何 https，证书由 TLS 栈校验）              |
| `http://127.0.0.1:3999`、`http://localhost:3999`、`http://LOCALHOST.:3999`、`http://app.localhost:3999`、`http://127.255.255.254:3999`、`http://[::1]:3999`、`http://[::ffff:127.0.0.1]:3999` | `loopback`（含 SSH 转发端口和本机）                 |
| `http://100.64.0.1`、`http://100.101.102.103:3873`、`http://100.127.255.255`                                                                                                                  | `tailnet`（`100.64.0.0/10`，见 N3）                 |
| `http://100.63.255.255`、`http://100.128.0.1`                                                                                                                                                 | `insecure-transport`（刚好在范围外）                |
| `http://[fd7a:115c:a1e0::1234]:3873`                                                                                                                                                          | `tailnet`                                           |
| `http://[fd7a:115c:a1e1::1]`、`http://[fd7a:115c:a1df::1]`                                                                                                                                    | `insecure-transport`（`/48` 之外）                  |
| `http://mac.tail1234.ts.net:3873`                                                                                                                                                             | `tailnet`                                           |
| `http://evil.ts.net.example.com`、`http://ts.net`、`http://notts.net`                                                                                                                         | `insecure-transport`（必须是 `.ts.net` 后缀的子域） |
| `http://192.168.1.10:3873`、`http://10.0.0.5`、`http://172.16.0.1`、`http://169.254.1.1`                                                                                                      | `insecure-transport`                                |
| `http://mac-mini:3873`、`http://mac-mini.local:3873`、`http://home.arpa`                                                                                                                      | `insecure-transport`（局域网名字）                  |
| `http://example.com`、`http://127.0.0.1.evil.com`、`http://localhost@evil.com`                                                                                                                | `insecure-transport`（按真正的 host 判定）          |
| `http://0.0.0.0:3999`、`http://[::]:3999`                                                                                                                                                     | `insecure-transport`（不是回环）                    |
| `ftp://x`、`not a url`、空字符串                                                                                                                                                              | `invalid-url`                                       |

规则写在一处：测试是这张表的逐行表格测试，再加一组随机化性质测试（任何 `https:` 一定 `tls`；任何 `http:` 且 host 不在三类里一定不通过）。

明文局域网的状态是 `unsupported-route`，原因 `insecure-transport`：走现有行为（私网改写成环境 IP，公网回退），错误卡片说明原因并提供「在 {environment} 的浏览器中打开」（§7.2）。

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
4. `webContents.session` 属于该环境已登记的 session（`partition → environmentId` 登记表）。

满足才调用 `event.preventDefault()` 和 `callback("t3x", 口令)`，并且只对自己的请求这样做。不满足的一律不动：不 `preventDefault`、不调用 `callback`，让 Electron 的默认行为和其他处理器照常运行。这样口令不会交给用户的系统代理、其他本机代理、页面自己的 HTTP 认证框（`isProxy === false`）、或另一个环境的代理（端口、session 都不对）。

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

### 4.9 重放与限速

- 票据是 bearer，窃取者在剩余有效期内可以开隧道，但仍受端口许可、复核、排除清单、并发上限、速率上限、撤销约束，**不能**调用 RPC（RPC 需要 DPoP）、不能读文件、不能用终端。只在加密或本机的连接上使用（§4.6），所以同网段嗅探不构成风险。
- 隧道升级失败（401/403/404/429）不进 `AuthAttemptLimiter`：票据是 256 位 HMAC，暴力猜测没有意义，不为它改上游文件。
- 浏览器不能直接用这个端点：必须带 `Authorization` 自定义方案（浏览器的 `WebSocket` API 设置不了任意请求头），且带 `Origin` 就拒绝。

## 5. 端口许可

### 5.1 "T3 终端和 agent 起的服务"的精确定义

照 `apps/server/src/preview/PortScanner.ts` 的实现。一个端口"有主"（`isOwned`），当且仅当扫描结果里它的 `terminal !== null` 或 `agent != null`：

- **终端有主**：监听该端口的进程 PID 属于某个 T3 终端的进程集合。集合由 `terminal/Manager.ts` 的 `subprocessInspector` 产生（终端 shell 的 PID 加它的全部后代，`Manager.ts:755-770`），经 `registerTerminalProcesses` 登记。
- **agent 有主**：监听进程的启动环境里有 `T3CODE_THREAD_ID=<线程>`（`AGENT_THREAD_ENV`）。macOS 用 `ps -E`，Linux 读 `/proc/<pid>/environ`；agent 起的任何作业都继承这个变量，所以 agent 退出后留下的服务仍算。Windows 没有这一档（`hostPlatform !== "win32"`），只有终端有主。
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

### 5.3 连接时怎样核对：快照 + 拨号前的定点复核

端口发现有两档节奏：面板打开时 3 秒（live），只有后台订阅时至少间隔 15 秒（`BACKGROUND_POLL_INTERVAL_MS`）。**只用快照会有 TOCTOU（GPT P1-1）**：T3 的服务退出后，别的无主进程可以在快照窗口里抢占同一端口，网关还会拨给它，直接违反"其他程序打不开"。所以拨号前必须再做一次针对那个监听的定点复核。

```
authorize(port):
  A 快照   servers = PortDiscovery.scanBackground()     // 上次扫描不到 15 秒就直接用，不起新扫描
           找 port 对应的项，取 (pid, 有主类别 terminal | agent)
           找不到或无主：距上次"未命中重扫"不到 2 秒 → 拒绝 not-owned
                         否则 scan() 一次（复用 scanSemaphore，同时到达的合并），再找；仍没有 → 拒绝 not-owned
  B 快照级排除（不查进程）
           pid === 本 server 进程 → reserved；端口 ∈ 登记端口（主口、隧道口）∪ 屏蔽表 → reserved
  C 定点复核 verify(pid, port)，结果按 (port, pid) 缓存 ≤ 2 秒
     C1 监听核对   pid 还活着，并且仍在这个端口上 LISTEN；得到它在这个端口上的绑定地址
                   （127.0.0.1 / ::1 / 通配）。不一致 → 拒绝 owner-changed，并触发（同样受 2 秒限流的）重扫
     C2 进程信息   一次读取：祖先链、argv、环境（macOS 的 ps -E，Linux 的 /proc/<pid>/environ）
                   - 重新验证归属：agent 有主的项，环境里仍有 T3CODE_THREAD_ID
                   - 排除 E1–E5（§5.6）、调试参数（§5.7）
  D 拨号   拨 C1 得到的那个地址（通配 → 127.0.0.1）；不解析任何名字
```

- 命中路径的成本：读上次扫描的 `Ref`，加缓存未过期时零进程调用；缓存过期时 C1 和 C2 各一次进程调用。Vite 一次开五六条隧道，缓存 ≤ 2 秒把它们合成一次复核。
- 未命中路径最多每 2 秒触发一次扫描，不是每个请求一次；恶意页面扫端口，每 2 秒最多推动一次 `lsof`。
- 没有任何地方新增轮询。`scan()` 在"没有终端登记进程、没有 agent、没有配置 URL"时本来就直接返回空（`scanUnlocked` 的短路），不会白跑 `lsof`。
- 因为 C1 本来就要读出绑定地址，**不再需要改 `PortScanner.ts` 去记录绑定类别**（这是对主控 Q4 的实现方式的修改，目的不变：精确连到端口发现看到的那个地址；见 N4）。

#### 各平台的复核办法

| 平台    | C1 监听核对                                                                                                                                                                                                              | C2 进程信息                                                                                                                          | 状态                                                                                                       |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| macOS   | `lsof -a -p <pid> -iTCP:<port> -sTCP:LISTEN -P -n -F pn`。输出里 `n127.0.0.1:<port>`、`n[::1]:<port>` 或 `n*:<port>` 就是绑定地址；pid 不对时输出为空、退出码 1                                                          | 一次 `ps -A -o pid=,ppid=`（沿用 `PortScanner` 的 `readProcessTable` 写法）取祖先链；`ps -E -ww -o command= -p <pid>` 取 argv 和环境 | **已实测**（本机，一次约 50 毫秒，附录 A）                                                                 |
| Linux   | 读 `/proc/<pid>/fd/*` 的符号链接，取 `socket:[inode]`；在 `/proc/net/tcp`、`/proc/net/tcp6` 里找状态 `0A`（LISTEN）、inode 匹配、端口匹配的行，本地地址就是绑定地址。只读这一个 pid 的 fd 目录（设上限），不遍历 `/proc` | `/proc/<pid>/stat`（ppid，沿链走到本 server 或 init）、`/proc/<pid>/cmdline`、`/proc/<pid>/environ`                                  | 未验证（本机是 macOS）。`PortScanner` 的 `/proc` 回退用同样的文件，解析函数可复用其思路                    |
| Windows | `netstat -ano -p TCP`，按 pid 和端口过滤（输出整个表，只过滤）                                                                                                                                                           | 没有 agent 档（`PortScanner` 在 win32 上只有终端有主）；进程树需要 PowerShell `Get-CimInstance Win32_Process`，较慢                  | 未验证。没有 Windows 环境可测，9.1 如果也没有，就把 Windows 的复核降级为"只做 C1，不做 C2"，并在文档里明说 |

#### 剩下的窗口有多大

- 复核到 `connect()` 之间只有几毫秒。缓存期内（≤ 2 秒）是剩下的主要窗口：同一个 (端口, pid) 的复核结果被复用，如果 T3 的服务在这 2 秒内退出，同时另一个进程在同一个端口、同一个地址上绑定并且一条新隧道恰好在这个窗口里用了缓存，网关会拨给它。要同时满足这几件，而且攻击者得已经能在 B 上跑进程，所以这是残余风险，不是可远程利用的洞。比快照方案的 15 秒窗口小一个数量级。
- 要关掉缓存窗口只需把缓存 TTL 设为 0（每条隧道复核一次，每次约 2 次进程调用）。常量放在一处，测试断言它等于 2000 毫秒，不会悄悄变大。
- **PID 复用**：快照里的 pid 在复核时已经退出，且该 pid 号被另一个进程复用并监听同一端口。macOS 和 Linux 的 pid 顺序分配，一个快照间隔（最多 15 秒，面板打开时 3 秒）内转完一圈需要大量进程创建；C2 对 agent 归属项重读环境，复用的进程带不上 `T3CODE_THREAD_ID`。终端归属项没有等价的重新验证（`PortDiscovery` 没有公开终端登记表的查询接口），属于残余风险。
- **`SO_REUSEPORT`**：两个同用户进程可以在同一地址、同一端口上同时监听，内核负载均衡。C1 能看到同一端口上的多个 pid，发现不止一个 pid 就拒绝（`owner-changed`）。
- 另一种地址族：T3 的服务在 `127.0.0.1:5173`，别的进程在 `[::1]:5173`。网关拨 C1 为那个 pid 得到的具体地址，不会拨到另一个地址族。

**测试（真实进程）：** 有主进程退出，另一个进程绑定同一端口：缓存失效后必须被拒（`owner-changed`）；缓存 TTL 设 0 时立即被拒；同一 pid 在 `[::1]` 上而另一个进程在 `127.0.0.1` 上，拨号目标是前者；同一端口上有两个 pid：被拒；agent 归属项的环境被清掉标记：被拒；缓存期内的行为固定为"放行"并有注释说明。

### 5.4 `T3CODE_PORT_DISCOVERY=0`

这时 `scanUnlocked` 只探测配置的 URL，`discovered` 永远为空，网关没有任何可许可的端口。处理：

- server 启动时读同一个环境变量（上游需要把 `PORT_DISCOVERY_ENV` 常量 `export` 一下，1 个词），为 `0` 时不广告能力（`capabilities.loopbackGateway` 不出现）。客户端据此走"B 不支持"的路径，不会白取票据。
- 取票的 RPC 在这种状态下回 `LoopbackGatewayUnavailableError { reason: "discovery-disabled" }`，防止旧缓存的能力。
- 错误页文案专门说"这台环境关闭了端口发现"。

### 5.5 绑定地址

见 §5.3 的 C1：复核时从那个 pid 在这个端口上的监听读出绑定地址，网关只拨这一个地址。通配绑定（`*`、`0.0.0.0`、`::`）拨 `127.0.0.1`。Windows 的 `netstat -ano` 同样给出本地地址。

### 5.6 排除清单（即使端口发现里出现也不行）

**规则：** T3 server 进程自己的监听，以及 T3 自己启动的运行时进程（不是 agent 工具调用或终端命令起的作业）的监听，一律排除。排除优先于许可，在 §5.3 的 B 和 C2 两处检查。

#### 5.6.1 所有监听点（源码扫描，排除测试、脚本、fixture）

我 grep 了 `apps/server`、`apps/desktop`、`packages/*`、`scripts` 里的 `.listen(`、`createServer(`、`NodeHttpServer.make`、`NodeSocketServer.make`、`HttpServer.serve`、`WebSocketServer(`：

| 位置                                                                                                                    | 是什么                                                               | 谁的进程                                                                                        | 处理                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/server/src/server.ts:363`                                                                                         | 主 HTTP/WS 监听口                                                    | server                                                                                          | E1，另登记端口                                                                                  |
| `apps/server/src/fork/deviceKeys/TunnelListener.ts:90-94`                                                               | frpc 的隧道监听口，`127.0.0.1` 随机口                                | server                                                                                          | E1，另登记端口                                                                                  |
| `apps/server/src/preview/DesktopBrowserChannel.ts:140`                                                                  | 桌面 CDP 中继的 WS，回环随机口                                       | server                                                                                          | E1                                                                                              |
| `apps/server/src/provider/CodexChatGptAuth.ts:486,500`                                                                  | Codex 登录的 OAuth 回调，`127.0.0.1` 随机口，登录期间存在            | server                                                                                          | E1                                                                                              |
| `packages/shared/src/codexAuthCallback.ts:39,86`                                                                        | OAuth 回调，端口取自 redirectUri，`127.0.0.1`                        | 调用者：server（`CodexChatGptAuth`）和桌面主进程（`apps/desktop/src/app/CodexAuthCallback.ts`） | E1 / E1 祖先                                                                                    |
| `apps/server/src/htmlRender/publicProxy.ts:129,191`                                                                     | HTML 渲染的公网代理，`127.0.0.1` 随机口                              | server                                                                                          | E1                                                                                              |
| `apps/server/src/provider/CodexManagedTokenBroker.ts:129,201`                                                           | 令牌代理，`server.listen(owned.endpoint)`，路径型端点                | server                                                                                          | 非 TCP（Unix socket 或命名管道）；具体类型我没有核实，9.1 核实并让测试断言它不出现在 TCP 监听里 |
| `apps/server/src/cli/sshHelper.ts:13,16`                                                                                | `pick-port` 命令：试绑一个端口，成功就立即关闭（SSH 主机上选端口用） | CLI 进程（不是 server）                                                                         | 瞬时，不是长期监听                                                                              |
| `packages/ssh/src/tunnel.ts:240,243`                                                                                    | SSH 本地转发监听 `127.0.0.1`                                         | 托管 SSH 环境的进程：桌面主进程或 server                                                        | E1 / E1 祖先                                                                                    |
| `packages/shared/src/Net.ts:49,78,135,148`                                                                              | 找空闲端口的探测（立即关闭）和通用监听工具                           | 调用者                                                                                          | 瞬时                                                                                            |
| `apps/desktop/src/app/DesktopAppActivation.ts:178,189`                                                                  | 桌面单实例/激活控制 socket                                           | 桌面主进程                                                                                      | 路径型（FORK.md 记为 `/tmp/t3code-<uid>/<哈希>.sock`），非 TCP                                  |
| 桌面 `T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT`                                                                             | Chromium 调试端口，用户显式设置才开                                  | 桌面主进程（B 是桌面内置 server 时是 server 的父进程）                                          | E1 祖先 + 屏蔽表 + 调试参数                                                                     |
| `mcp/McpHttpServer.ts`                                                                                                  | T3 自己的 `/mcp`，挂在主路由上                                       | server                                                                                          | 没有独立监听，随主口                                                                            |
| 测试、脚本、fixture（`*.test.ts`、`testkit`、`testUtils`、`scripts/`、`apps/server/scripts`、`apps/web/test/fixtures`） | 不进产品                                                             | —                                                                                               | 不适用                                                                                          |

#### 5.6.2 server 启动的长期子进程

| 进程                                         | 启动处                                                                                             | 会不会监听                                                                         | 环境里有没有 `T3CODE_THREAD_ID`                                                                                         | 处理        |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- | ----------- |
| Claude Code CLI                              | `ClaudeAdapterV2.ts:1000-1004`（SDK 的 `query` 选项里 `env`）                                      | 可能有 IDE 桥或登录回调口（未核实）                                                | **有**：显式设置（`[PortScanner.AGENT_THREAD_ENV]: input.threadId`），进程本身就带，端口发现会把它的监听列为 agent 有主 | E2          |
| Codex app-server                             | `CodexAdapterV2.ts`（`effect-codex-app-server`）                                                   | 未见监听（走标准输入输出）                                                         | 进程本身**没有**；只有它的 shell 带（`shell_environment_policy.set.T3CODE_THREAD_ID`，`CodexAdapterV2.ts:1410`）        | E2          |
| OpenCode `serve`                             | `packages/provider-opencode/src/server/OpenCodeRuntime.ts:510`（`--hostname=… --port=…`）          | **回环 TCP 口**                                                                    | 不显式设置；继承 server 的环境                                                                                          | E2          |
| Muse `serve`                                 | `packages/provider-muse/src/server/sdk.ts:133`（SDK 的 `spawnMspConnection`）                      | 传输方式未核实                                                                     | 不显式设置                                                                                                              | E2          |
| ACP 运行时（Cursor、Grok、Kiro、Pi 等）      | `provider-acp`、`provider-fx/src/server/acpSupport.ts:230`                                         | 未见监听（标准输入输出）                                                           | 不显式设置                                                                                                              | E2          |
| ACP 的 MCP 桥                                | `mcp/AcpMcpStdioBridge.ts`、`cli/acpMcpBridge.ts`                                                  | 标准输入输出                                                                       | —                                                                                                                       | E2          |
| 设备 hub                                     | `device/LocalDeviceHost.ts` `spawnHub`（`--port`、`--host 127.0.0.1`，端口 `reserveLoopbackPort`） | **回环 TCP 口**；hub 再起的 agent-device 守护进程也监听回环（`--daemon-base-url`） | 继承                                                                                                                    | E2 + **E3** |
| 无头 Chrome                                  | `htmlRender/headlessChrome.ts:188`、`preview/PreviewBrowserHost.ts`                                | `--remote-debugging-pipe`，没有 TCP                                                | 继承                                                                                                                    | E2          |
| frpc                                         | `fork/deviceKeys/frpcProcess.ts`                                                                   | `frpcConfig.ts` 写明"opens no admin web server"                                    | 继承                                                                                                                    | E2          |
| 资源监视器                                   | `resourceTelemetry/NativeTelemetryClient.ts`                                                       | 命令走标准输入输出（未核实 TCP）                                                   | 继承                                                                                                                    | E2          |
| 短命令（git、gh、ps、lsof、文本生成 CLI 等） | `vcs/`、`textGeneration/`、`processRunner.ts` 等                                                   | 无                                                                                 | —                                                                                                                       | 瞬时        |
| provider 侧的 MCP 进程                       | 由各家 CLI 自己启动                                                                                | 取决于 MCP 服务                                                                    | 继承 CLI 的环境（Claude 的带标记）                                                                                      | 见残余风险  |

**回答"provider 运行时进程环境里带不带 `T3CODE_THREAD_ID`"：** Claude Code CLI **带**（显式设置在进程环境里）；Codex app-server 本身不带，它启动的 shell 带；其余 provider T3 不设置，但它们继承 server 自己的环境，而在这个仓库的日常工作流里 server 是 agent 终端里启动的：我自己这个会话的 shell 环境里就有这个变量（附录 A 的 `ps -E` 输出里能看到）。所以不能指望"没标记就不会被列出"。

#### 5.6.3 规则

| 编号 | 排除                                                                            | 适用于                     |
| ---- | ------------------------------------------------------------------------------- | -------------------------- |
| E1   | 监听者的 pid 等于本 server 进程，或是它的**祖先**（桌面主进程等）               | 所有归属                   |
| E2   | 监听者的 pid 是本 server 的**直接子进程**，且是**agent 归属**（环境标记）       | agent 归属。终端归属不适用 |
| E3   | 监听者在一个已登记的"非作业运行时子树"里（设备 hub 及其守护进程）               | 所有归属                   |
| E4   | 端口 ∈ 已登记端口（`ServerConfig.port`、`TunnelListener.port`）∪ 屏蔽表（§5.7） | 所有归属                   |
| E5   | argv 或 `NODE_OPTIONS` 带调试参数（§5.7）                                       | 所有归属                   |

为什么 E2 只对 agent 归属生效：agent 的作业（Claude 的 Bash 工具、Codex 的 shell）是 CLI 的**孙进程或更深**，直接子进程一定是 T3 自己启动的运行时；而终端归属的进程是 shell 的后代，shell 在 `exec` 之后可能就是那个 dev server 本身（pid 相同，是 server 的直接子进程），所以终端归属不能套用 E2。T3 的运行时进程不会出现在终端的进程树里。

为什么要 E3：设备 hub 是 server 的直接子进程（E2 覆盖），但它再启动的 agent-device 守护进程是孙进程（E2 不覆盖）。hub 是唯一这样的长期运行时，所以在 `LocalDeviceHost.spawnHub` 登记子树（上游 +2 行）。其余运行时的作业子进程（OpenCode 的工具、Codex 的 shell）是 agent 的作业，**应当**被许可，所以不登记它们的子树。

**登记服务 `GatewayExclusions`**（fork 文件）：`registerRuntimeTree(pid)`、`registerPort(port)`，加上静态屏蔽表和调试参数匹配。

#### 5.6.4 验收

- **完整 server 的自检：** 起一台完整的 server（带隧道监听口、`DesktopBrowserChannel`、设备 hub、`T3CODE_THREAD_ID` 在自己的环境里，覆盖最坏情形），用 `lsof -p` 列出 server 进程和它的直接子进程的全部 TCP 监听，断言每一个都被网关拒绝。
- **假运行时：** 一个直接子进程，带标记、在回环上监听：被拒（E2）。它的孙进程带标记、监听：放行。终端 shell `exec` 成监听者：放行（终端归属不受 E2 约束）。设备 hub 的孙进程（守护进程）：被拒（E3）。
- **防漂移测试：** 一个源码扫描测试，列出产品代码（排除测试、脚本、fixture）里所有 `.listen(`、`createServer(`、`NodeHttpServer.make`、`NodeSocketServer.make`、`HttpServer.serve`、`WebSocketServer(` 以及 `--port`/`--listen` 参数的位置，与 fork 目录里提交的清单（`listenSites.json`）逐项比较。新增监听点会让测试失败，直到有人在清单里给它写上处理方式。这样"新增一个回环管理口会自动落入有主许可"不会静默发生。

#### 5.6.5 残余风险

- server 重启后留下的**孤儿运行时进程**：被重新挂到 init 下，不再是 server 的直接子进程，E2 排除不到它们；如果它们带标记并监听，会被当作 agent 作业。缓解：E4（屏蔽表）、E5（调试参数）仍然适用；`AgentScope` 的孤儿回收（`survivesRestart` 以外的 agent 进程"remain eligible for orphan cleanup"）本来就在清理它们。不另做处理，记在文档里。
- provider 侧由 CLI 启动的 MCP HTTP 服务：它们是 agent 的作业，按"有主服务"对待，暴露面与 dev server 同类（§6.7）。
- 用户自己在 B 上以终端归属启动的、本意不想暴露的服务：这是功能的前提；用户要避免就不要在 T3 终端里起它。

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
- Windows 没有 argv 和环境的读取路径（见 §5.3 的表）：只靠端口屏蔽表，文档写明。
- 名单可扩展，但不做通用的"调试器检测"。其他语言的调试器（`debugpy --listen`、`dlv --listen`）这次不列；用户反馈再加（N5 里建议把 `5005`、`5678` 加进屏蔽表）。

端口屏蔽表（Q3，已定）：`9222`、`9229`、`5858`、`5859`、`2375`、`2376`。

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

### 6.7 页面对 dev server "完整网络接口"的访问（GPT P1-6）

转发的是原始 TCP 字节，Host、Origin、路径都原样到 B。所以网关给标签页里的页面的不只是"一个网页"，而是**有主服务的完整网络接口**：

- Vite 的 `/@fs/`（读 `server.fs.allow` 范围内的任意文件）、`/@id/`、`/@vite/`、source map、`/__open-in-editor` 一类开发端点；Next、webpack-dev-server 的类似开发端点；用户自己的开发 API（带副作用的 POST、管理接口）。
- 暴露程度**等同于本机 dev server 对本机浏览器里的页面**：同样的 Host、同样的 Origin、同样的服务自己的 CORS 和 `allowedHosts` 策略。网关不放宽也不收紧这些策略；具体能不能读到，取决于该 dev server 版本的默认值（早期 Vite 默认对所有来源开放 CORS，较新的版本限制 `Host` 和跨源读取）。这是 dev server 本身的属性，不是网关引入的。
- 网关引入的变化是**页面所在的位置**：本来在 A 上的页面现在能碰到 B 上的服务。所以"这个标签页里加载了什么"变成了安全问题：用户在 B 的对话标签页里导航到外部网站，那个网站的脚本能对 B 上有主的 dev server 发请求。缓解见 6.1：许可范围、调试端口、整进程排除；文档要明说"别在转发的标签页里打开不信任的网站"。

**验收用例（9.2 的真实 Electron 冒烟 + 9.1 的路由层）：**

1. **外部来源的页面读不到 `/@fs/`：** 一个夹具服务模拟 Vite 的 `/@fs/…` 路由，按 Host 和 Origin 决定是否返回 CORS 头（拒绝外部 Origin、`Host` 不是 `localhost`）。断言：从 `localhost` 同源页面请求成功；从外部 Origin 的页面（`direct.test`）的跨源 `fetch` 读不到内容（无 `Access-Control-Allow-Origin`）；并断言网关**没有改写** Host 和 Origin（夹具记录请求头，与直连时逐字节一致）。这测的是"网关不改变 dev server 能看到的头"，不是 Vite 本身。
2. **默认端口上的 Node inspect 被拒：** 一个监听在 9229 的进程，在有主的前提下仍被拒（屏蔽表）；一个 `--inspect=0` 的进程，它的 web 端口和随机检查器端口都被拒（整进程排除）。
3. **`*.localhost`：** `http://app.localhost:P` 过代理、到达同一个有主端口；代理的主机判定接受；`http://localhost.localdomain:P` 不过代理（直连 A，页面自己的问题）。
4. **IPv4-mapped IPv6：** `http://[::ffff:127.0.0.1]:P` 过代理（实测写法变成 `[::ffff:7f00:1]`），代理判定接受，B 端拨的是复核得到的地址，不是页面写的地址。
5. **DNS rebinding：** 解析到 127.0.0.1 的非回环名（测试里用 `--host-resolver-rules` 映射）的请求**不过代理**，直连 A；代理收到的任何非回环主机请求得到 403，B 端收到 0 次开隧道请求。

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

「按环境生效」要明说（主控 Q7）：悬停提示和菜单项的说明里写"对 {environment} 的所有标签页生效"；用户文档里同样写明，不支持单个标签页关闭。

### 7.2 错误卡片

加载失败时上游画 `PreviewUnreachable`（带「在 X 的浏览器中打开」，来自 #17316）。我们给它加一个 `reason`，根据主进程发来的 `gatewayDenied` 事件（以及 B 离线、旧版、明文链路等状态）换文案，不新做页面：

| 情形                                                         | 标题 / 说明                                                                                                       | 操作                            |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 端口不是 T3 起的（`not-owned`）                              | 「这个端口不是 T3 起的服务」「{environment} 只转发它的终端和 agent 启动的服务。」                                 | 在 {environment} 的浏览器中打开 |
| 端口被保留（`reserved`，T3 自己的或屏蔽的调试端口）          | 「这个端口不能转发」                                                                                              | 同上                            |
| 进程带调试参数（`debug-process`）                            | 「这个服务带着调试参数运行，不能转发」「去掉 `--inspect` 一类参数后重启，或者在 {environment} 的浏览器中打开。」  | 同上                            |
| 监听者变了（`owner-changed`）                                | 「这个端口的服务刚刚变了」「重试。」                                                                              | 重试                            |
| 没有程序在监听（`upstream-refused`）                         | 「{environment} 上没有程序监听 {port}」「服务启动后重试。」                                                       | 重试                            |
| B 离线 / 不可达（`offline`）                                 | 「连不上 {environment}」                                                                                          | 重试                            |
| 权限不够（`forbidden`）                                      | 「这个连接没有转发权限」「需要预览和终端权限。」                                                                  | —                               |
| B 是不支持网关的旧版或上游版（`unsupported-server`）         | 「{environment} 的 T3 版本不支持转发 localhost」「更新它，或者在它的浏览器中打开。」                              | 在 {environment} 的浏览器中打开 |
| 明文局域网链路（`unsupported-route` / `insecure-transport`） | 「这个连接没有加密，不转发 localhost」「用 https、Tailscale 或 SSH 连接 {environment}，或者在它的浏览器中打开。」 | 在 {environment} 的浏览器中打开 |
| 经 T3 Connect 中继（`unsupported-route` / `relay`）          | 「通过 T3 Connect 的连接不支持转发 localhost」                                                                    | 同上                            |
| 端口发现关闭（`discovery-disabled`）                         | 「{environment} 关闭了端口发现」                                                                                  | 同上                            |
| 达到上限（`limit-reached` / `rate-limited`）                 | 「转发的连接太多」                                                                                                | 重试                            |

"不支持"和"明文"这几行没有主进程事件（没装代理，Chromium 直接连 A 的 `localhost` 被拒）。这时 `PreviewUnreachable` 的 fork 钩子看"远程环境 + 回环主机 + 网关状态不是 active"，按状态换成对应的说明。

### 7.3 票据自动续期

用户感觉不到：续期在渲染进程里提前做（§4.2）；刚过期的短窗口里，新连接的错误卡片显示"正在重新连接…"并在拿到票据后自动重载一次主框架（只在卡片是因为 401 出现时）。

### 7.4 i18n 工作量

约 25 条新文案，一个 catalog 文件，`vp run i18n:report` 必须 0 missing / 0 stale，`i18n.test.ts` 通过。需要截图验收：中英文各一张的转发标识和三种错误卡片，守住上游风格（见记忆：UI 审美要求）。

## 8. 能力探测与退路

五道门，全部满足才启用，任何一道不满足都**保持现有行为**：

1. **运行时**：`window.desktopBridge?.preview` 存在（桌面版）。网页和手机不进入。
2. **环境**：非主环境，且不满足 `reachesEnvironmentLoopback`（WSL 等不需要）。
3. **能力**：`environment.capabilities.loopbackGateway === true`。读取方式照 `readEnvironmentSupportsServerBrowser`（`apps/web/src/state/entities.ts:349`），在 `apps/web/src/fork/loopbackGateway/capability.ts` 里写一个同样的读取函数，不改上游。服务端在 `ServerEnvironment.ts:279` 旁加一行（`T3CODE_PORT_DISCOVERY=0` 时不加）；契约在 `environment.ts:156` 旁加一行 `optionalKey`，老服务端不发这个字段，客户端读到 `false`。
4. **连接**：连接目标不是中继；`httpBaseUrl` 通过 §4.6 的传输检查（`https:`、回环、Tailscale）。
5. **权限与用户意愿**：会话有两个 scope（`permissionAtom`）；用户没有在这个环境上关闭转发（§10）。

这些组合成状态：`active | unsupported-server | unsupported-route(relay | insecure-transport) | no-permission | disabled-by-user | not-applicable`。`resolveDiscoveredServerUrl` 只在 `active` 时对回环 URL 原样放行；其他状态走原逻辑（私网改写成环境 IP、公网回退）。这样上游版本的 B、明文局域网和关闭转发的用户完全不受影响，「在 B 的浏览器中打开」始终存在。

状态是一个纯函数：输入（运行时、环境类别、能力位、连接目标、`httpBaseUrl`、scope、用户设置），输出状态。表格测试覆盖每道门单独失败和多道同时失败时的优先级。

## 9. 入口逐个决定

关键事实：拦截发生在**分区的网络层**，不在 URL 层。所以只要标签页是桌面运行时、环境是远程、网关 `active`，无论 URL 怎么进入，`localhost:5173` 都会被转发。URL 层要做的只有一件事：别把 `localhost` 改写掉。

| 入口                                                                                                          | 现状                                                                                          | 决定                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 地址栏输入                                                                                                    | `handleSubmitUrl` 直接导航，不经 resolver，今天连到 A 的 `localhost`                          | 不改。网关生效后自然可用                                                                                                                                                                                                                 |
| 端口列表（`ThreadServersPanel`、`PreviewLocalServerCard`、`useDiscoveredLocalServers`、`openDiscoveredPort`） | 经 `resolveDiscoveredServerUrl`，私网会被改写成环境 IP，公网回退                              | `resolveDiscoveredServerUrl` 在 `active` 时原样放行（上游 +8 行）。显示用的 URL 和导航用的 URL 都是 `http://localhost:5173`                                                                                                              |
| 终端链接（`openTerminalLinkInPreview`）                                                                       | Vite 打印的 `http://localhost:5173/` 直接作为 `url` 打开桌面标签页，不经 resolver，今天连不上 | 不改，自动可用                                                                                                                                                                                                                           |
| 「在这台电脑上打开」（`PreviewView` 的 `moveTarget === "desktop"`，约 386–410 行）                            | 调 `resolveDiscoveredServerUrl`                                                               | 同上，`active` 时得到 `localhost` URL，网关生效                                                                                                                                                                                          |
| 「在 {environment} 的浏览器中打开」                                                                           | 切到服务端运行时（B 上的无头 Chrome，推流）                                                   | 保留，作为不允许转发时的退路和所有错误卡片上的按钮                                                                                                                                                                                       |
| 系统浏览器（`FooterPorts.tsx:95`、`ThreadServersPanel.tsx:85` 的 Cmd-click）                                  | `shell.openExternal(resolveDiscoveredServerUrl(…))`                                           | **保持原行为**（系统浏览器不受网关影响）：`resolveDiscoveredServerUrl` 加一个 `{ systemBrowser: true }` 选项，这两处调用点各改一行，行为与今天完全相同。`PreviewView.handleOpenInBrowser` 直接用标签页当前 URL 打开，不经 resolver，不改 |
| 项目脚本的 `autoOpenPreview`（`useChatTerminalActions`）                                                      | 经 resolver                                                                                   | 同端口列表，`active` 时直接是 `localhost`                                                                                                                                                                                                |
| 命令面板                                                                                                      | 现有的打开链接和浏览器命令都落到上面这些路径                                                  | 不新增命令。转发开关放在标识的菜单里（§7.1）。如果主控想要面板里也有，是一条 fork 命令，成本很低但属于范围扩大，主控已定不加（Q6）；标识的「恢复转发」是必须有的反向入口，不是命令                                                       |
| 重启后恢复的标签页                                                                                            | 服务端保存会话，打开对话时重新挂 webview                                                      | 靠 §2.3 的"网关已登记"门；不持久化转发状态，只持久化"用户对哪些环境关闭了转发"                                                                                                                                                           |
| agent 用 `preview_open` / `preview_navigate` 打开标签页                                                       | 见下                                                                                          | **不涉及网关**                                                                                                                                                                                                                           |

关于最后一行，我查到的事实：远程环境上 agent 打开的标签页用**服务端运行时**（B 上的无头 Chrome，画面推流），`localhost` 本来就指 B。证据：`previewRuntimeFor` 对 `serverBrowser` 的环境返回 `"server"`；上游在 #16827 的关闭说明里写明"desktop now opens remote-environment browser tabs locally for user-opened tabs. Agent-opened tabs and web/mobile clients still stream."；`DesktopBrowserChannel` 是桌面应用和**它自己内置 server** 之间的 fd 通道（`ServerConfig.desktopBrowserFd`），不连别的环境；`apps/web/src` 里没有 B 的 agent 去驱动 A 桌面 webview 的 automation host 代码。所以"B 的 agent 在 A 桌面渲染的标签页里操作"在这个代码库里不存在，网关不需要也不应该处理它。我没有端到端验证这一点（没有启动应用），9.3 的手动检查里加一条：在远程对话让 agent 打开 `localhost:5173`，确认它是服务端标签页。

## 10. 反向状态

每个"进"都有"出"，也都有办法看到当前状态（AGENTS.md 的"反向状态"一条）。

| 想要                              | 办法                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 这个环境不再转发                  | 标识菜单「停止转发，使用这台电脑的 localhost」。写入本机设备级 store（`apps/web/src/fork/loopbackGatewayStore.ts`，localStorage，键名沿用 `sidebarViewStore.ts` 的方式，不进 `ClientSettings`、不改 contracts）。主进程把该环境所有已登记分区改回 `{ mode: "direct" }`，`closeAllConnections()`，并**关闭该环境所有已建立的隧道**（不是等它们自然结束）。标识**留在原处**变成灰色（`disabled-by-user`，§7.1） |
| 恢复转发                          | 灰色标识的菜单只有一项「恢复转发」，清掉 store 里的关闭记录，状态回到 `active`（若其他门仍满足），主进程重新装代理。入口和出口对称                                                                                                                                                                                                                                                                            |
| 作用范围                          | **按环境生效**（主控 Q7）：这个环境的所有标签页、所有 profile 一起。标识的悬停提示、菜单项说明、用户文档都写明这一点                                                                                                                                                                                                                                                                                          |
| 某个标签页单独不转发              | **做不到，也不做**：代理是 session 级的，一个环境的所有标签页共用。需要 A 的 `localhost` 时：系统浏览器，或本机环境对话里的标签页。写进用户文档                                                                                                                                                                                                                                                               |
| 环境断开                          | 渲染进程把状态置 `offline` 推给主进程；之后的新请求得到 `offline` 错误页。**已建立的隧道不受 RPC 连接影响**（它们是独立的 WebSocket），只在 B 或网络真断、或会话失效（§4.8）时才断                                                                                                                                                                                                                            |
| 环境重连                          | 渲染进程重新取票据、推给主进程、状态回 `active`。页面可能需要手动刷新；Vite HMR 会自己恢复                                                                                                                                                                                                                                                                                                                    |
| 票据过期                          | 票据只在**升级那一刻**检查。已建立的隧道不受影响；新隧道在续期失败时得到 401，错误卡片显示"正在重新连接…"（§7.3）。会话被撤销时才会断已建立的隧道（§4.8）                                                                                                                                                                                                                                                     |
| 路由切换（局域网 → 隧道）         | 渲染进程订阅连接的 `httpBaseUrl`，变化时推新地址；每次都**重跑传输检查**（§4.6）。新地址通过：旧隧道自然结束，新连接走新地址。新地址不通过（例如切到明文局域网）：状态变 `unsupported-route`，主进程拆代理、改回直连，并关闭该环境所有已建立的隧道，不让旧加密链路上的隧道继续用                                                                                                                              |
| 设备被移除 / 会话被撤销           | 服务端关闭隧道（§4.8）；A 端看到隧道断开，之后的升级得到 401，状态变 `no-permission`；用户重新配对后恢复                                                                                                                                                                                                                                                                                                      |
| 应用重启                          | 代理、口令、票据都不持久化。启动后恢复标签页，webview 等"网关已登记"（本地 IPC，不等网络）；主进程以 `pending` 状态先装好代理，没有票据时回 503，非回环流量不受影响；渲染进程连上 B 后取票据变 `active`。持久化的只有"用户对哪些环境关闭了转发"                                                                                                                                                               |
| B 升级成支持的版本 / 降级成不支持 | 能力来自服务器配置，随连接更新；`active` 与否变化时安装器装上或拆掉代理                                                                                                                                                                                                                                                                                                                                       |

## 11. 性能

- **不轮询。** 票据续期是一次性定时器；端口许可靠现有快照，未命中至多每 2 秒触发一次扫描；没有新增订阅。
- **不按请求扫描整机。** 每条新隧道做一次按 PID 的定点复核（一个 `lsof -p` 或读 `/proc/<pid>/fd`，§5.3），同一 (端口, PID) 通过后 2 秒内缓存，所以一个页面冷启动并发的 5–6 条隧道只复核一次。这次复核的耗时没测，9.1 度量，9.4 的首屏测量把它算进去。
- **连接复用。** A→B 每个端口有 keep-alive 池；实测 Chromium→代理本身复用良好。
- **B 端零 HTTP 解析。** 隧道是字节管道，没有逐请求的 Effect `HttpClient` 开销（#8841 的路径是逐请求）。
- 没有持续重绘的动画；标识是静态图标。

### 11.1 经隧道首屏耗时的测量办法（9.4 做）

在本地试用栈上（`vp run fork:selfhost:e2e` 用的 Docker 栈：Caddy + frps + registry，发布在回环地址）：

1. B：一台 server，终端里起 Vite 示例项目（至少 300 个模块），或用仓库里的 `apps/web`。A：桌面 dev 应用，加入这台 B（经隧道地址）。
2. 基线 1：同一个 Vite 直接在 A 本机跑，A 本机环境标签页打开（无代理）。
3. 基线 2：B 与 A 同机，经局域网/回环地址直连环境（无隧道，有网关）。
4. 经隧道：环境经 `https://<名字>.t3.localhost`（有网关，经 Caddy 和 frp）。
5. 本地栈延迟几乎为零，会掩盖往返开销。给 A 到 Caddy 之间插一个只监听回环的 Node TCP 中继，每个方向加 25 毫秒（共 50 毫秒往返），再测一组；100 毫秒往返再测一组。
6. 度量：用 `wc.executeJavaScript` 读 `performance.getEntriesByType("navigation")[0]` 的 `domContentLoadedEventEnd`/`loadEventEnd`，加一个 `PerformanceObserver` 取 LCP；统计隧道建立次数（B 端日志）和每条隧道从发起到升级完成的时间；再测一次保存文件到 HMR 更新（`vite:afterUpdate`）的延迟。每组 5 次取中位数。
7. 判据：50 毫秒往返时首屏比基线 2 慢超过 1.5 秒，或每条新隧道建立超过 3 个往返，才进入"预开空闲隧道"，再不行才考虑多路复用。结果写进 FORK.md。

## 12. 分阶段计划

流程同前几阶段：独立 worktree 实现 → 测试与 review 并行 → 修复 → `--no-ff` 合入。每阶段的验收都包含它自己的安全验收。测试放在"在 main 上会失败的最低一层"，遵守 AGENTS.md：不用 sleep/超时/轮询，用 `Deferred`、`Queue`、`drain`、`TestClock`。

**没有独立的 9.0（主控第 13 条）：** B 端的两个技术前提是 9.1 的第一步，A 端的是 9.2 的第一步，失败就停下回报，不继续往下做。严格 audience、票据不进日志、`login` 条件、撤销竞速、TOCTOU 是 9.1 和 9.2 的**验收项**，不是 spike。

### 9.1 server 网关（M+）

**第一步（前提，失败就停下回报）：** 在共享 `HttpRouter` 上加一条 `GET /api/loopback-gateway/tunnel` 升级路由，把 `request.upgrade` 的 Socket 对接到 `net.connect`。确认：主监听口和 `TunnelListener` 口都能用；背压（写慢的一端不会无限缓冲）；`awaitInvalidation` 竞速能关闭它，且 TCP 和 WS 两端都销毁。不行就改用 `ws` 的流接口，再不行回到本文重新设计传输层。第一步的原始输出放 `/tmp`，结论回写 §3.3。

范围（`apps/server/src/fork/loopbackGateway/`、`packages/contracts/src/forkLoopbackGateway.ts`、`packages/shared/src/forkLoopbackGateway/`）：

- 契约：RPC `loopbackGateway.issueTicket`、错误类型、能力位 `loopbackGateway`（`T3CODE_PORT_DISCOVERY=0` 时不广告）；`AuthWebSocketTicketUse` 加 `"loopback-gateway"`。
- 权限：`CLIENT_GUARDED_RPC_SCOPES` 展开 + `clientRpcRequiredScopes` 返回两个 scope；扩展权限行为测试。
- 隧道路由与认证函数 `authenticateGatewayTicket`（§4.4）、日志脱敏层（§4.3）。
- 端口许可、定点复核、`GatewayExclusions`、监听点清单与防漂移测试（§5）。
- 上限（§3.7 的 B 端项）。

验收：

- **严格 audience：** 没有 audience、`rpc`、`media`、其他值、篡改、过期、已撤销、MCP 客户端会话、缺 scope、错误方案（`Bearer`/`DPoP`）、query 里的 `wsTicket`、带 `Origin`：全部被拒；反向：网关票据打 `/ws` 和媒体路由被 audience 拒绝，没有 audience 的票据仍能打 `/ws`。
- **票据不进日志：** 测试 logger 和测试 tracer 收集全部输出，覆盖成功和每种失败，找不到哨兵票据及其长度 ≥ 12 的子串。
- 两个 scope 缺一不可；只读会话被拒。
- **定点复核（TOCTOU）：** 有主进程退出后另一个进程绑到同一端口，被拒；绑定地址正确（只绑 `::1` 和只绑 `127.0.0.1` 的服务各自连得上，拨号目标是复核得到的地址）；同端口两个 pid 被拒；agent 项标记被清被拒；缓存 TTL 常量等于 2000 毫秒；未命中重扫的 2 秒限流。
- **排除：** §5.6.4 的完整 server 自检、假运行时（E2、E3 的正反例）、防漂移测试；带 `--inspect=0` 的进程的两个端口都被拒；屏蔽表端口被拒。
- `T3CODE_PORT_DISCOVERY=0` 不广告能力、RPC 报 `discovery-disabled`。
- **撤销（§4.8）：** 会话被撤销、会话自然过期、设备移除后经 8.2 对账撤销，三条路径都验证已建立隧道的 TCP 和 WS 两端关闭；续期链（N1）；升级与撤销同时发生的四个竞速场景。
- 上限、速率、超大帧、背压、关闭传播：在 socket 层测。
- 主监听口和隧道监听口行为一致。
- 阶段结束时按实际 diff 重估上游改动行数（§13）；超过 130 行停下回报。

测试层：许可、排除、拨号选择、传输检查是纯函数 → 单元测试；路由、撤销、上限 → 起真实 server 层加真实 `ws` 客户端和真实回环服务（沿用 `TunnelListener.test.ts` 的 harness）；设备移除 → 8.2 的 `registryFake.testkit.ts` / `deviceHarness.testkit.ts`；权限表 → 契约行为测试。

### 9.2 桌面代理与分区（M+）

**第一步（前提，失败就停下回报）：** `http.Agent` 的 `createConnection` 返回自定义 `Duplex`，对着本地 SSE、分块、大上传、`100-continue`、keep-alive 复用的服务跑通；`ws` 的 `createWebSocketStream` 到 B 的通路；决定主进程是否并入系统根证书（`tls.setDefaultCACertificates`），在装了私有 CA 的机器上验证。结论回写 §3.2、§3.6。

范围（`apps/desktop/src/fork/loopbackGateway/`）：每环境代理、隧道客户端、环境注册表、会话安装器与 `getPreviewConfig` 钩子、`app.on("login")`、错误页和 `webRequest` 事件、IPC 与 preload 桥（`preloadSandbox.test.ts` 比对）、票据续期请求、传输检查（调用 `packages/shared` 的同一个函数）。

**回环主机的判定和规范化放在 `packages/shared/src/forkLoopbackGateway/` 里**（GPT P2-3），界面（web 的状态机、地址规范化）和主进程（代理的主机校验）共用一个函数，不各写一份。它包含：判定（`localhost` 含尾点、`*.localhost`、`127.0.0.0/8`、`::1`、`::ffff:127.x`）、以及**仅用于显示和已知 Preview URL** 的规范化（`0.0.0.0`、`[::]` → `localhost`）。**规范化不参与任何安全判断**（主控 Q8，GPT 同意）：代理和 B 端的判定只用判定函数，不接受"规范化之后才算回环"；页面自己写死的 `0.0.0.0` 不转发。

验收：

- **`login` 处理的四个条件**（§4.7）：错误的 host、port、session、`isProxy === false`、属于另一个环境的 session，都不回应；与假的上游处理器并存。
- **口令与限制：** 口令只在内存（测试里扫描 IPC 消息、日志、传给渲染进程的任何数据，找不到口令）；本机另一个客户端不带口令或带错口令，只能得到 407，假隧道工厂计数为 0；并发与速率限制（§3.7）。
- 主机判定表（§1.2）逐项；非回环一律 403；`0.0.0.0`、`[::]` 不转发。
- HTTP：流式/SSE、分块、`Connection: close`、大请求体、中途取消；同一条 Chromium 连接上不同端口的请求各自选对隧道；keep-alive 复用。
- CONNECT（https、ws）：数据双向、一端关闭另一端关闭。
- 主进程自己的传输检查：`httpBaseUrl` 不通过时不发出任何连接。
- 票据过期的行为；`pending` 状态回 503。
- 会话安装器：`setProxy` 的参数就是 §1.1 的规则串；改回直连时 `closeAllConnections`；**新 profile 的第一次导航之前代理已装好**（钩子在 `getPreviewConfig` 里，测试用 mock `Session` 断言 `setProxy` 先于返回）。
- **真实 Electron 冒烟**（附录 A 的 spike 整理成 `vp run fork:loopback-gateway:electron-smoke`，不进 CI，9.4 人工验收时跑）：普通 HTTP、SSE、WebSocket、`https://localhost`，加上 §2.3 末尾列的路径：Service Worker、prefetch、`sendBeacon`、无痕分区、新 profile 首次导航、favicon 的 `session.fetch`、下载。
- 关闭传播、背压、帧和连接上限：在 socket 层测（真实 TCP + 真实 `ws`）。
- 阶段结束时按实际 diff 重估上游改动行数；超过 130 行停下回报。

测试层：代理逻辑用假隧道（一对 `Duplex`）做单元测试，不碰 Electron；安装器用 mock 的 `Session`；Chromium 实际行为只能在真 Electron 里证明，所以放在脚本里。

### 9.3 web 接线、界面与中文（M）

范围：`apps/web/src/fork/loopbackGateway/`（能力读取、状态机、取票据与续期的挂载组件、store、标识、错误卡片）、`resolveDiscoveredServerUrl` 的改动、`HostedBrowserWebview` 的等待门、`PreviewUnreachable` 的 reason、zh-Hans catalog。

验收：

- 传输检查的表格测试（§4.6 的整张表）加性质测试。
- 状态机的表格测试：每道门单独失败、多道同时失败的优先级，含 `insecure-transport` 与 `relay`。
- `resolveDiscoveredServerUrl` 表测试：`active` 时放行；各非 active 状态走原逻辑；`systemBrowser` 选项行为不变。
- 续期调度是纯函数（输入现在时间和过期时间，输出下一次动作），不用定时器测。
- **`disabled-by-user` 的标识和「恢复转发」入口**（浏览器测试，`render` from `apps/web/test/render.tsx`），再加错误卡片按 reason 换文案的浏览器测试。
- `vp run i18n:report` 0 missing / 0 stale；`i18n.test.ts` 通过。
- 中英文对照截图（标识的两种状态和各种卡片）。
- `vp run fork:guard`、`vp run check:changed`。
- 手动检查：在远程对话让 agent 打开 `localhost:5173`，确认它是服务端标签页（§9）。

### 9.4 两台电脑的端到端、连接方式矩阵与文档（M+）

场景：B 的 T3 终端起 Vite，A 打开 `localhost:5173`，热更新可用，非 T3 起的端口被拒。

1. **无界面部分**加进 `vp run fork:selfhost:e2e` 作为新场景：A、B 是现有 harness 起的两台真实 server；B 的终端经 RPC 打开并写入命令起一个带 SSE 和 WebSocket 的小服务；A 端用桌面代理模块（纯 Node，不 import electron）经自建隧道取页面、收 SSE、说 WebSocket；一个**不是**终端起的服务（harness 直接 spawn 的）被拒；移除 B 上 A 的设备后隧道两端关闭。
2. **界面部分**在 Electron 里做一次（`test-t3-app`，用 `--use-mock-keychain`、`--host-resolver-rules="MAP *.t3.localhost 127.0.0.1"`、定向信任 Caddy CA）：Vite 示例，输入 `localhost:5173`，地址栏不变、标识出现、改文件热更新生效、`https://localhost` 自签名、端口列表点击、终端链接点击、重启应用后恢复标签页；非 T3 起的端口出卡片；停止转发后回到旧行为，标识仍在、可恢复。
3. **连接方式矩阵（GPT P1-7，主控第 9 条）：** 对 §3.5 里每一种"待验证"的方式，各测：打开 WS 隧道；长连接（至少 30 分钟空闲后 HMR 仍可用）；重连（重启 B、断网再通）；证书（公共 CA、私有 CA、过期证书的报错）；并发（几十条隧道同时升级）。测完把表里的"待验证"改成"已验证"，或写明限制。
4. **基础设施测试：** `Caddyfile` 没有未加过滤的 `log`；在本地试用栈里临时打开 `log`，实测 `Authorization` 被遮蔽；README 说明。
5. 按 §11.1 测首屏（含 50 毫秒和 100 毫秒往返的延迟注入）。
6. 文档：`docs/user/remote-access.md` 的 "Browser on a remote environment" 旁加一节（写明语义变化：B 的标签页里 `localhost` 永远指 B；按环境生效；只在加密或本机连接上启用；别在转发的标签页里打开不信任的网站）；FORK.md 加一节；本文档写入结果。

验收：以上全部通过；`fork:selfhost:e2e` 连续两遍全绿；官方基线不变（不碰 `~/.t3`、fork 真实 home）。

### 以后再做（不在 9）

- 多路复用 / 预开隧道（视 §11.1 结果）。
- 为每次升级签一个 DPoP 证明，让明文局域网也能用（主控第 2 条）：渲染进程为每条隧道的升级请求签证明，经 IPC 交给主进程；需要把票据改成绑 `jkt` 并在网关路由里验证证明和 jti 防重放。
- 按线程精确归属（要改 contracts）。
- 网页版（附录 C）。

## 13. 上游改动预算

新代码全部放 `apps/*/src/fork/` 和 `packages/*/src/fork*`。GPT 的 P1-8 指出上一版（约 +85）只算了显式接线点。这一版把审查要求的每一项都过一遍：

| 审查要求的能力                   | 放在哪里                                                                        | 上游行数            |
| -------------------------------- | ------------------------------------------------------------------------------- | ------------------- |
| 严格 audience                    | fork 认证函数 + `auth.ts` 加一个字面量                                          | 1                   |
| 日志脱敏                         | fork 层（追加 `Headers.CurrentRedactedNames`），随路由层一起挂载                | 含在 `server.ts` 里 |
| `login` 处理与共存               | fork 文件，随桌面层安装                                                         | 0                   |
| 定点复核                         | fork 文件（`lsof`、`/proc`、`netstat` 封装）；只需要 `PortScanner` 导出一个常量 | 1                   |
| 分区生命周期钩子（含新 profile） | `getPreviewConfig` 处理里调用 fork 钩子                                         | 3                   |
| 排除登记                         | fork 服务；设备 hub 子树登记                                                    | 2                   |
| 权限与安全测试                   | 新测试文件                                                                      | 0                   |

逐文件：

| 上游文件                                                     | 预计行数                                                                     | 内容                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/contracts/src/environment.ts`                      | +2                                                                           | 能力位 `loopbackGateway`                                                                     |
| `packages/contracts/src/rpc.ts`                              | +2                                                                           | 展开 fork RPC（同 `FORK_DEVICE_KEYS_RPCS`）                                                  |
| `packages/contracts/src/index.ts`                            | +1                                                                           | 导出 fork 契约                                                                               |
| `packages/contracts/src/clientRpcPermissions.ts`             | +4                                                                           | 展开受保护 scope、`clientRpcRequiredScopes` 里为该方法返回两个 scope                         |
| `packages/contracts/src/auth.ts`                             | +1                                                                           | `AuthWebSocketTicketUse` 加 `"loopback-gateway"`                                             |
| `packages/shared/package.json`                               | +3                                                                           | exports：`forkLoopbackGateway` 下的几个文件                                                  |
| `apps/server/src/ws.ts`                                      | +3                                                                           | 注册 RPC 处理器（同 `makePushRpcHandlers`）                                                  |
| `apps/server/src/server.ts`                                  | +5                                                                           | 路由层、服务层、日志脱敏层、排除登记层                                                       |
| `apps/server/src/environment/ServerEnvironment.ts`           | +2                                                                           | 广告能力（受 `PORT_DISCOVERY` 影响）                                                         |
| `apps/server/src/preview/PortScanner.ts`                     | +1                                                                           | 导出 `PORT_DISCOVERY_ENV`                                                                    |
| `apps/server/src/device/LocalDeviceHost.ts`                  | +2                                                                           | 登记 hub 子树（E3）                                                                          |
| `apps/desktop/src/preload.ts`                                | +8                                                                           | 桥                                                                                           |
| `apps/desktop/src/ipc/DesktopIpcHandlers.ts`                 | +2                                                                           | 安装 IPC                                                                                     |
| `apps/desktop/src/main.ts`                                   | +2                                                                           | 层                                                                                           |
| `apps/desktop/src/ipc/methods/preview.ts`                    | +3                                                                           | `getPreviewConfig` 里调用安装钩子                                                            |
| `apps/desktop/package.json`                                  | +1                                                                           | `ws` 依赖（当前没有任何工作区包直接依赖它，它只作为 `@effect/platform-node` 的传递依赖存在） |
| `apps/web/src/browser/browserTargetResolver.ts`              | +8                                                                           | `active` 时放行、`systemBrowser` 选项                                                        |
| `apps/web/src/browser/HostedBrowserWebview.tsx`              | +3                                                                           | 等"网关已登记"                                                                               |
| `apps/web/src/components/preview/PreviewUnreachable.tsx`     | +8                                                                           | reason 卡片钩子                                                                              |
| `apps/web/src/components/preview/PreviewChromeRow.tsx`       | +4                                                                           | 标识（含 `disabled-by-user`）                                                                |
| `apps/web/src/components/AppSidebarLayout.tsx`               | +2                                                                           | 挂载取票据与续期（同 `KeepAwakeReporter`）                                                   |
| `apps/web/src/components/chat/ThreadServersPanel.tsx`        | +1                                                                           | `{ systemBrowser: true }`（`FooterPorts.tsx` 是 fork 自己的文件，另有一行）                  |
| `packages/client-runtime/src/i18n/catalogs/zh-Hans/index.ts` | +2                                                                           | 注册 catalog                                                                                 |
| **合计（不含文档）**                                         | **约 +70**，23 个上游文件                                                    | 停止线 130 行                                                                                |
| 文档                                                         | `docs/user/remote-access.md` +25、`FORK.md` +40、`infra/self-host/README` +8 |                                                                                              |

和上一版的差：去掉 `PortScanner.ts` 的 +25（定点复核取得绑定地址，不再需要在扫描器里记录绑定类别），新增 hub 登记 +2、`getPreviewConfig` 钩子 +3、`shared/package.json` exports +3、日志脱敏层并入 `server.ts`、标识的禁用状态 +1。

**不再算低估的地方：** 审查指出的"严格 audience、日志脱敏、`login` 冲突处理、PortScanner 即时复核、所有分区首次导航前的钩子、权限和安全测试"都已经在上表里，其中 `login` 冲突处理、复核、日志脱敏、排除登记、严格认证是 **0 行**上游改动（全在 fork 文件里）。这个估算仍是设计时的估算：9.1 和 9.2 结束时各按实际 diff 重估一次。

**超过 130 行时的削减方案**（按顺序，每步省的行数）：

1. `PreviewUnreachable` 的细分 reason 改成一条通用说明加按钮（−6）。
2. `PreviewChromeRow` 的标识菜单改成只有图标（−3），菜单挪进 fork 组件。
3. `LocalDeviceHost` 的 hub 子树登记改成按 argv 匹配 agent-device 守护进程（−2，换来更脆）。
4. `ThreadServersPanel` 的 `systemBrowser` 选项：Cmd-click 也保持转发行为（−1，行为变化，需要主控同意）。
5. 再不行：把安全基础设施（严格认证、日志脱敏、排除登记）拆成独立的阶段先合入，网关路由本身后合。

上游 26 个新提交（`322f6544df..8b44f42b14`）预判：

- 这四个目录**零改动**：`apps/web/src/browser`、`apps/web/src/components/preview`、`apps/desktop/src/preview`、`apps/server/src/preview`（`git diff --stat` 为空）。
- 上表里每个文件在这 26 个提交里都**零改动**；整个区间对 `apps/desktop`、`apps/server/src/ws.ts`、`packages/contracts` 只改了 3 个文件（两个 `package.json` 的版本号、`contracts/src/review.ts` +5 行）。第二轮新加的 `LocalDeviceHost.ts`、`ipc/methods/preview.ts`、`packages/shared/package.json`、`ServerEnvironment.ts`、`PortScanner.ts` 也用 `git diff --stat 322f6544df 8b44f42b14` 逐个核对过：零改动。
- 上游 main 仍然没有网关（`Gateway.ts` 不存在）。

预估新代码规模：server 约 900、desktop 约 1,100、web 约 600、契约与共享约 250，共约 2,850；测试另约 2,000。

## 14. 决定与待主控确认的问题

### 14.1 已定（主控 + GPT 评审，写进本文）

| #   | 问题                            | 决定                                                                                                                                                                                                           | 写在哪里         |
| --- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Q1  | 明文局域网是否启用              | **不启用。** 只在 `https:`/`wss:`、回环（含 SSH 转发口和本机）、Tailscale 上启用；明文局域网为 `unsupported-route` / `insecure-transport`，走旧行为，错误卡片给「在 B 的浏览器中打开」。判定是纯函数加表格测试 | §4.6、§8、§7.2   |
| Q2  | Preview URL 是否算许可          | 不算                                                                                                                                                                                                           | §5.2             |
| Q3  | 是否屏蔽调试端口                | 屏蔽 9222、9229、5858、5859、2375、2376（N5 建议再加两个）                                                                                                                                                     | §5.7             |
| Q4  | 是否改 `PortScanner` 记绑定地址 | 目的达成，**做法变了**：改为拨号前按 PID 定点复核，从复核结果读绑定地址，不改 `PortScanner` 的记录（N4）                                                                                                       | §5.3、§5.5       |
| Q5  | 权限是否两个 scope              | 两个：`preview:operate` + `terminal:operate`                                                                                                                                                                   | §4.5             |
| Q6  | 命令面板是否加开关              | 不加。`disabled-by-user` 时标识保留，菜单项「恢复转发」                                                                                                                                                        | §7.1、§10        |
| Q7  | 是否按环境生效                  | 按环境生效；UI 和文档明说                                                                                                                                                                                      | §7.1、§10        |
| Q8  | `0.0.0.0` / `[::]`              | 不转发；规范化只用于显示和已知 Preview URL，**不参与任何安全判断**；判定和规范化放 `packages/shared`，UI 和主进程共用                                                                                          | §1.2、§12（9.2） |
| Q9  | 是否有独立的 9.0                | 没有。B 端技术前提是 9.1 的第一步，A 端的是 9.2 的第一步，失败就停下回报；严格 audience、票据不进日志、`login` 条件、撤销竞速、TOCTOU 是 9.1/9.2 的验收项                                                      | §12              |

### 14.2 需要主控确认的几点（N1–N7）

这些是我在落实主控的决定时遇到的、需要你点头或改的地方。每条我都给了默认做法，不回复就按默认做。

**N1. 票据写会话的 `jkt`，仅作续期链的键。** 主控第 2 条要求"不绑 `jkt`"。问题：DPoP 会话每小时续期、换新的会话 id；`SessionStore.awaitInvalidation(sessionId, proofKeyThumbprint)` 靠指纹沿 `latestSessionByProofKey` 追到继任会话，不给指纹时隧道每小时被断一次。做法：RPC 签发时把会话的指纹写进票据的 `jkt`，**网关路由读它只用来追续期链，不要求出示 DPoP 证明**，票据仍是 bearer；`/ws` 和媒体路由在 audience 检查处就拒绝网关票据，碰不到它们的 DPoP 逻辑（`EnvironmentAuth.ts:1256` 先于 `:1261`）。字面上不同于"不绑"，意图相同（仍是 bearer、不要求证明）。**默认：这样做。** 备选：不写指纹，接受隧道每小时重建（HMR WebSocket 每小时断一次）。见 §4.2。

**N2. 票据头用 `Authorization: T3X-Gateway <票据>`。** 主控说"专用请求头，不用 `Authorization`，除非查证没有 HTTP 认证中间件会解析它"。我查了：server 里所有读 `Authorization` 的地方（`parseBearerToken`、`parseDpopToken`、Cookie 回退）只认 `Bearer`/`DPoP` 方案，不认 `T3X-Gateway`（§4.3 有逐处表）；选它的原因是 Effect 的 `Headers.CurrentRedactedNames` 默认列表和 Caddy 默认日志编码器都会遮蔽 `Authorization`，自造的头名则会被原样写进日志。**默认：用 `Authorization` 加自定义方案，并加测试保证没有认证代码把它当会话凭据。** 备选：自造头名（例如 `X-T3X-Gateway-Ticket`），就必须在 server 和 Caddyfile 两处都把它加进遮蔽名单，Caddy 一侧漏配就会泄露。

**N3. Tailscale 的判定范围。** 主控写的是 `100.64.0.0/10`、`fd7a:115c:a1e0::/48`、`*.ts.net`。上游的 `isTailnetHost` 刻意**不**把 `100.64.0.0/10` 单独认作 Tailscale（运营商级 NAT 也用这个段），所以我们的传输检查要自己写一份范围判定，和上游的不同。结果：用运营商 CGNAT 地址直接明文连 B 的人，会被我们当作 Tailscale 放行；这种链路不一定加密。**默认：按主控的范围放行**（`*.ts.net` 必须是后缀匹配，`evil.ts.net.example.com` 不通过，表格测试覆盖）。备选：只认 `*.ts.net` 和 `fd7a:115c:a1e0::/48`，纯 IPv4 `100.64/10` 地址不认。

**N4. Q4 的目的用另一种方式达成。** 主控同意改 `PortScanner` 记录绑定类别；GPT 说还不够，要拨号前即时复核。按 PID 复核本身就能读出绑定地址（macOS `lsof -a -p <pid> -iTCP:<port> -sTCP:LISTEN` 实测给出 `127.0.0.1:55005`），所以不再需要改 `PortScanner` 的记录，省 24 行上游改动（预算 §13），只留 1 行导出常量。**默认：不改记录。** 如果主控仍想要上游扫描器记录绑定类别，说一声，预算加回约 25 行，仍在停止线内。

**N5. 屏蔽表再加 `5005` 和 `5678`。** `5005` 是 Java 调试（JDWP）常用端口，`5678` 是 Python `debugpy`、n8n 等的常用端口。它们和 9229 同类：协议能力远超网页预览。**默认：加。** 误伤的是恰好在这两个端口跑普通 web 服务的人，他们能用「在 B 的浏览器中打开」。

**N6. B 是 Windows 时怎么办。** Windows 没有 agent 归属档（`PortScanner` 在 win32 上只有终端有主），也没有读 argv 和环境的路径，所以 E2（agent 归属项排除）、E5（调试参数）都做不了，只剩端口屏蔽表。我没有 Windows 机器，复核命令 `netstat -ano` 的行为没有实测。**默认（推荐）：第一版 Windows 的 B 不广告 `loopbackGateway` 能力**，在 Windows 机器上验证后再开。**备选：** 照 §5.3 的表启用，只靠终端归属加屏蔽表，文档写明限制（§5.6.5 目前按这种写）。你选默认的话，我在 §5.6.5 把这句改成"不广告"。

**N7. 主进程是否并入系统根证书。** 渲染进程信任系统里装的私有 CA，Node 主进程默认不信。想让私有 CA 的 B 地址也能用，主进程要调 `tls.setDefaultCACertificates(tls.getCACertificates("system"))` 之类，这会读系统信任库（macOS 上碰钥匙串相关接口）。我这一轮没有调用它（你的规则禁止碰钥匙串）。**默认：9.2 第一步在一台装了私有 CA 的机器上评估后决定**，在此之前私有 CA 是"待验证"（§3.5、§3.6）。需要你确认可以在 9.2 里碰系统信任库的只读接口。

### 14.3 我没有核实的前提（汇总）

- frp 在几十条并发升级连接、长时间空闲连接下的行为；Tailscale Serve 对 WS 升级和 `Authorization` 头的转发；SSH 转发口上的长连接；私有 CA。这些全部在 §3.5 标"待验证"，9.4 逐种测。
- B 端 Effect `Socket.writer` 的背压是否足够（9.1 第一步）。
- A 端 `http.Agent` 的 `createConnection` 对自定义 `Duplex` 的兼容（9.2 第一步）。
- 主进程并入系统根证书是否可行（N7，9.2 第一步）。
- Caddy 的 `log` 开启后 `Authorization` 是否被遮蔽：依据 Caddy 文档，没有在本机栈上实测（9.4 基础设施测试）。
- 经 T3 Connect 中继的行为（明确不支持，没测）。
- `protocol.handle`、`webRequest` 的否决只依据文档，没有实测。
- Windows 上的端口归属、`netstat -ano` 的行为（N6），以及 `ps -E`、`lsof -p` 在其他 macOS 版本和 Linux `/proc` 的表现：macOS 26 上实测过（附录 A），Linux 和 Windows 只依据文档。
- Local Network Access 在 Chromium 152 的实际拦截行为：设计不依赖它（§6.8）。
- "B 的 agent 不会驱动 A 的桌面标签页"是读代码得出的，没有启动应用验证（9.3 手动检查）。
- 上游代码里除 §5.6.1 列出的监听点之外是否还有动态创建的：防漂移的源码扫描测试负责（§5.6.4）。

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

评审文件：`/tmp/t3x-gateway-design-review/findings.md`，结论"改完下列项再实现"。下表每一项列出改在哪一节，以及有没有没完全采纳的地方（及理由）。

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
