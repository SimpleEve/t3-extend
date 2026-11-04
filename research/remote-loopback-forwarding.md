# 远程环境的本机服务转发（桌面版）设计

2026-11-04。基线：fork `8328902b94`，上游同步点 `322f6544df`，上游 main `8b44f42b14`。只做设计，没有实现代码。

场景：A 的 T3 Extend 桌面版打开 B 上的对话，B 的 T3 终端或 agent 起了只监听回环地址的服务（例如 `127.0.0.1:5173` 的 Vite）。用户在内置浏览器输入 `http://localhost:5173`，地址栏不变，页面在 A 本地渲染，请求在后台经 A 到 B 的现有连接转到 B 的回环地址。

## 0. 结论与推荐方案

**一句话：** 在 A 的桌面主进程里为每个远程环境起一个只绑 `127.0.0.1` 的 HTTP 代理，用 `session.setProxy` 把该环境所有分区的回环流量导给它；代理为每条 TCP 连接开一个到 B 的 WebSocket 隧道；B 的网关只在目标端口属于"T3 终端或 agent 起的服务"时才拨 B 的回环地址。

```
A 渲染进程                         A 主进程                            B (server)
 <webview partition=env B>  ──►  127.0.0.1:随机口 (代理, Proxy-Authorization)
   localhost:5173                  │ HTTP: 每个请求按目标端口选隧道 (keep-alive 池)
   ws://localhost:5173 (CONNECT)   │ CONNECT: 一条隧道 = 一条 Chromium 连接
   https://localhost:5173 (CONNECT)│
                                   └─ wss://<B 的地址>/api/loopback-gateway/tunnel
                                        ?port=5173&wsTicket=<票据>   ──►  同一 router，
                                                                        主监听口和隧道监听口都有
                                                                        ① 票据 → 会话 → 两个 scope
                                                                        ② 端口许可(端口发现快照)
                                                                        ③ 拨 127.0.0.1 / ::1
```

关键决定（每条的理由在对应章节）：

| 问题             | 决定                                                                                                                        | 依据                                                                                                                               |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| A 端怎样改走转发 | `setProxy({ mode: "fixed_servers", proxyRules: "http://127.0.0.1:<端口>", proxyBypassRules: "*;<-loopback>" })`             | spike 实测：回环名和 IP、`ws://`、`https://`（CONNECT）、SSE 都过代理，origin 不变，其他地址直连；PAC 抓不到回环地址（§1、附录 A） |
| 分区             | **上游已经按环境分区，一行不用改**                                                                                          | 分区的 scope 就是 `environmentId`（§2）                                                                                            |
| 传输             | 每条 TCP 连接一个 WebSocket，不多路复用；B 端是纯 TCP 通道，不解析 HTTP                                                     | 连接数小、背压和失败都隔离、B 的信任边界最小（§3）                                                                                 |
| 认证             | RPC 取票据（会话级 WS 票据，新 audience，5 分钟，可复用），经 IPC 交给主进程；主进程升级 WebSocket 时带票据                 | 主进程没有 DPoP 私钥；复用 `SessionStore` 的现成机制，撤销自动生效（§4）                                                           |
| 权限             | 要求 `preview:operate` **和** `terminal:operate`                                                                            | 先例 `previewStopLocalServer`（§4）                                                                                                |
| 端口许可         | 复用端口发现的"有主"判定（终端进程树，或环境里有 `T3CODE_THREAD_ID` 的进程）；Preview URL 配置项不算；T3 自己的监听一律排除 | §5                                                                                                                                 |
| 退路             | B 不支持、端口不允许、中继、用户关闭：保持现有行为，加「在 B 的浏览器中打开」                                               | §8                                                                                                                                 |
| 网页版           | 这次不做，理由见附录 C                                                                                                      |                                                                                                                                    |

规模：新代码在 `apps/*/src/fork/`、`packages/*/src/fork*` 约 2,300 行（含测试约 3,800），上游文件约 85 行改动、20 个文件（§13），低于 130 行停止线。

分阶段（§12）：9.0 先用最小骨架验证两个技术前提（半天）；9.1 server 网关；9.2 桌面代理；9.3 web 接线与界面；9.4 两台电脑端到端和文档。

需要主控拍板的问题见 §14，其中最需要先定的是：局域网明文 http 连接是否也启用（Q1）、Preview URL 是否算许可（Q2，我建议不算）、是否额外屏蔽调试端口（Q3，我建议屏蔽）。

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

- A 端代理的主机判定要和 Chromium 的回环集合一致：`localhost`（含尾点）、`*.localhost`、`127.0.0.0/8`、`::1`、`::ffff:127.x.x.x`（写成 `::ffff:7f00:1`）。**其余一律 403**，即使 Chromium 不会发来。
- `0.0.0.0` 和 `[::]` 不会被转发。dev server 的启动日志有时会打印 `http://0.0.0.0:5173`。对策：web 的地址规范化把这两个 host 换成 `localhost`（`packages/shared/src/preview.ts` 的 `LOOPBACK_HOSTS` 已经把 `0.0.0.0` 当回环名，需要实现时核对 `normalizePreviewUrl` 是否已换）；页面自己写死的 `0.0.0.0` 不管，写进已知限制。
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

### 2.3 把代理装到环境的所有分区

渲染进程在创建该环境的第一个 `<webview>` 之前，通过新的 fork 桥 `window.t3xLoopbackGatewayBridge`（模式同 `t3xSelfHostBridge` 和 `keepAwake`：独立的 channels 文件、preload 里一小段 `exposeInMainWorld`、只给主窗口，内置浏览器页面拿不到）调用 `register(environmentId, { baseUrl, enabled, profileIds })`。主进程：

1. 为该环境建一个代理（见 §3.2），状态为 `pending`（没有票据时对请求回 503，非回环请求不受影响）。
2. 对 `profileIds` 里每个 profile 用上游导出的 `resolvePartitionScope` + `PreviewManager.getBrowserSession` 取 session，装 `setProxy`。登记 `partition → environmentId`，以后新建 profile 或分区再次被取到时（`getPreviewConfig` 5 分钟重取一次，幂等）补装。
3. `enabled: false`（B 不支持、用户关闭、中继）→ 对已装的 session 改回 `{ mode: "direct" }` 并 `closeAllConnections()`，这就是反向状态（§10）。

渲染端 `HostedBrowserWebview` 在 `config` 之外多等一个"网关已登记"的 promise（上游 3 行，§13）。如果不等，应用刚启动恢复标签页时，第一个回环请求会在代理装好之前直连 A 自己的 `localhost`，可能连到 A 上同端口的无关服务。

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

按环境一个实例：`http.createServer` 绑 `127.0.0.1:0`，随机 256 位口令，要求 `Proxy-Authorization: Basic`（见 §4.4）。

- 普通 HTTP 请求（绝对 URI）：校验主机是回环名、取出端口，用 `http.Agent`（`keepAlive`，每端口 `maxSockets` 16，空闲 30 秒）转成源站形式的请求，agent 的 `createConnection` 返回一条到 B 的隧道（`ws` 的 `createWebSocketStream`，自带背压）。`Host` 头原样保留（页面发 `Host: localhost:5173`，B 上的程序也看到这个）。剥掉 `Proxy-*` 和逐跳头。Chromium 对 HTTP 代理的连接池按代理分组而不是按目标（凭记忆，没有专门实测），同一条 Chromium 连接上可能先后出现不同端口的请求，所以设计上**不能**把一条 Chromium 连接固定绑给一条隧道；必须在请求层选隧道。
- `CONNECT host:port`：校验后回 `200`，把这条 Chromium 连接和一条新隧道对接（字节管道）。`ws://`、`wss://`、`https://` 都走这条。
- 不支持的：明文 HTTP 的 `Upgrade`（Chromium 对 `ws://` 用 CONNECT，实测，所以不会出现）→ 501。
- 错误响应是自带样式、已翻译的 HTML，带 `X-T3x-Gateway-Error: <code>` 响应头；主进程用该 session 的 `webRequest.onHeadersReceived` 看到主框架上的这个头，就给渲染进程发事件，由 `PreviewUnreachable` 画卡片（§7）。CONNECT 被拒时回 `403`，同时发同样的事件。

需要在 9.0 验证的实现细节：`http.Agent` 的 `createConnection` 返回自定义 `Duplex` 时缺少 `setKeepAlive/setNoDelay/setTimeout/ref/unref`，要补空实现；SSE、分块、`100-continue`、大上传、keep-alive 复用都要有测试。

### 3.3 B 端网关路由

`GET /api/loopback-gateway/tunnel?port=<n>&wsTicket=<票据>`，WebSocket 升级。挂在 **共享的 `HttpRouter`** 上，所以 `TunnelListener.withTunnel` 的第二个监听口（frpc 的 `localPort`）自动也有这条路由：`TunnelListener.ts` 的注释写明它"serves the application a second time"，复用同一个 router。主监听口（局域网、Tailscale、SSH 转发）和自建隧道因此用同一份代码，不需要为隧道口写任何特别逻辑。

处理顺序（全部在升级之前，失败返回带 JSON 的 HTTP 状态，Node 的 `ws` 客户端能从 `unexpected-response` 读到）：

1. 必须带 `wsTicket`；带 `Origin` 头一律 403（浏览器一定带 `Origin`，我们的客户端不带；这样网页不可能直接用这个端点）；不接受 Cookie/Bearer 回退。
2. `authenticateWebSocketUpgrade(request, "loopback-gateway")` → 会话。检查 `preview:operate` 与 `terminal:operate` 都在 `session.scopes`。
3. 并发与速率上限（§4.5）。
4. 端口许可（§5）。
5. 拨 `127.0.0.1` 或 `::1`（§5.3），超时 3 秒；失败 → `502 { code: "upstream-refused" }`。
6. 接受升级，建立双向管道：二进制帧 = TCP 字节，不用文本帧；B 每 30 秒发 WS ping，90 秒收不到 pong 就关；有任一端关闭就关另一端。
7. 与会话的失效竞速：`sessions.awaitInvalidation(session.sessionId)`，和 `ws.ts` 里 `/ws` 路由完全一样（`raceFirst`），会话被撤销时这条隧道立刻关闭。**不调用** `markConnected`（隧道不是"一个已连接的客户端"，不应出现在连接列表里）。

不设空闲超时。理由：Vite 的 HMR 客户端在 WebSocket 非正常关闭后会轮询并 `location.reload()`，空闲超时会让页面莫名重载；靠存活探测和两端关闭传播就够。

### 3.4 与 Caddy、frp 的关系

从仓库配置读到的，不是新测的：

- `infra/self-host/Caddyfile` 的 `reverse_proxy frps:8080` 有 `flush_interval -1`（流式响应立即发出）和 `stream_close_delay 5m`（Caddy 重载后，已升级的 WebSocket 最多再活 5 分钟）。Caddy 对已升级的连接没有空闲超时。
- frpc 到 frps 的控制连接心跳 30 秒、超时 90 秒（`frpcConfig.ts`）；frps 的 vhost HTTP 代理按 Host 路由，WebSocket 升级是 HTTP 反向代理的标准能力。我没有测过 frp 对"几十条并发升级连接"和"长时间空闲连接"的行为，列在 §14 的未验证项里，9.4 在本地试用栈上测。
- B 每 30 秒的 WS ping 同时防住中间设备（NAT、移动网络）因空闲回收映射。
- Caddy 重载或 frps 重启时隧道会断。Chromium 对 HTTP 会重试新连接；Vite HMR 会自己恢复；其他 WebSocket 由页面自己负责，与直连时 dev server 重启一样。

### 3.5 支持的连接方式

| 连接方式                                          | 支持           | 说明                                                                                                                                                                                                                                   |
| ------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 局域网直连                                        | 是             | 网关路由在主监听口；`ws://` 明文，见 §4.3 和 Q1                                                                                                                                                                                        |
| Tailscale（直连或 Serve）                         | 是             | Tailscale Serve 把 HTTPS 转进本机主监听口，WebSocket 升级可通过（RPC 的 `/ws` 已经依赖这一点）                                                                                                                                         |
| SSH 环境                                          | 是，且是修复   | SSH 环境的 `httpBaseUrl` 是 A 上的转发端口（`http://127.0.0.1:<本地口>`）。现在 `resolveEnvironmentPortTarget` 把 `localhost:5173` 原样指到 A 自己的 `localhost`（连不通，上游 #26890）；网关走同一个 `httpBaseUrl`，连到 B 的网关路由 |
| 自建隧道（`t3x-device`，`https://<名字>.<域名>`） | 是             | 走隧道监听口（同一个 router）。现在 `resolveDiscoveredServerUrl` 对这类地址抛 "planned authenticated preview gateway" 并回退成 A 自己的 `localhost`                                                                                    |
| T3 Connect 中继                                   | **明确不支持** | fork 默认没有官方 `.env`，T3 Connect 默认不可用；中继链路对 WebSocket 升级和并发数的限制我们既不拥有也不测试。检测到连接目标是 `RelayConnectionTarget` 时网关状态为 `unsupported-route`，走旧行为并提示                                |
| WSL / 桌面本地目标                                | 不需要         | 回环共享，保持现状                                                                                                                                                                                                                     |

### 3.6 TLS 信任与代理

A 主进程用 Node 的 TLS 连 B。渲染进程（Chromium）信任系统根证书和用户装的私有 CA；Node 默认只信任自带的 Mozilla 根。自建隧道用 Let's Encrypt，没问题；Tailscale 的证书也是公共 CA。若用户的 B 地址用的是自己系统里信任的私有 CA，就需要主进程也信任它：Node 24 有 `tls.setDefaultCACertificates()` 和 `tls.getCACertificates("system")`（只确认了存在）。9.0 要决定是否在主进程启动时把系统根并入默认集合，并在一台装了私有 CA 的机器上验证；在此之前把"私有 CA 的 B 地址"列为已知限制。另外，主进程的 `ws` **不走系统代理**；A 必须经代理才能到达 B 的情形不支持，网关会报 `offline`。

### 3.7 背压与上限

| 项                   | 值                                                    |
| -------------------- | ----------------------------------------------------- |
| 每会话并发隧道       | 64                                                    |
| 每台 server 并发隧道 | 256                                                   |
| 每会话新建隧道速率   | 令牌桶，突发 60，每秒补 30，超了回 `429 rate-limited` |
| 每会话签发票据速率   | 每分钟 30 次                                          |
| A→B 每端口 HTTP 连接 | 16，空闲 30 秒回收                                    |
| 单条隧道发送缓冲     | 超过 1 MiB 暂停读对端（节点流背压）                   |
| 读块大小             | 64 KiB                                                |

数值是起点，9.1 的测试按这些数断言，调整时测试和文档一起改。B 端 Effect 的 `Socket.writer` 是否能给出足够的背压，是 9.0 要验证的第二个前提；不行就在 B 端用 `ws` 的流接口。

## 4. 认证、权限、撤销

### 4.1 为什么是票据

渲染进程有 DPoP 私钥和到 B 的认证连接，主进程没有。把私钥交给主进程违背现有设计（`research/self-host-device-keys.md` Q3 对设备密钥的结论同理）；让主进程代渲染进程发每个字节的请求太重。所以：**渲染进程换一张短期票据，交给主进程；主进程凭票据开隧道。**

#### 方案比较

| 方案                                                            | 评价                                                                                                                                                                            |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| #8841：自签 HMAC 票据，只含端口和过期时间                       | 不绑会话，撤销不了；任何持有者 5 分钟内可用；签名密钥单独管理                                                                                                                   |
| 复用现成的 `wsTicket`，**audience 用 `"media"`**                | 现成，但同一张票据也能打开预览推流等媒体路由，范围比需要的大                                                                                                                    |
| **复用 `wsTicket`，新增 audience `"loopback-gateway"`（推荐）** | `SessionStore.issueWebSocketToken(sessionId, { audience })` 已有；票据绑会话，`verifyWebSocketToken` 每次读库检查未撤销、未过期；上游只改 `AuthWebSocketTicketUse` 的一个字面量 |

### 4.2 票据

| 属性             | 值                                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 形态             | `base64url(claims).hmac`，由 `SessionStore.issueWebSocketToken` 签发，签名密钥是这台 server 的 `server-signing-key`（别的环境的 server 验不过）                                                                                                |
| 有效期           | 5 分钟（`DEFAULT_WEBSOCKET_TOKEN_TTL`，不另配）                                                                                                                                                                                                |
| 绑定             | 会话（`sid`）、用途（`aud: "loopback-gateway"`）；**不绑端口**（端口由连接时的许可检查决定）；**不带 `jkt`**（主进程没有私钥，因此是 bearer）                                                                                                  |
| 有效期内能否复用 | 能。每条隧道的升级请求都带同一张；每次升级都重新读库确认会话未撤销、未过期                                                                                                                                                                     |
| 刷新             | 渲染进程在剩余约 40% 时调 RPC 换新的，经 IPC 推给主进程；主进程在剩余不足 60 秒仍没收到新的时，发 `ticket-needed` 事件让渲染进程立刻换。这是一次性的定时器，没有轮询。过期期间新连接得到 401，卡片显示"正在重新连接"，换到票据后下一次加载恢复 |
| 存放             | 只在主进程内存里；不写盘、不进 URL 栏、不进渲染进程日志                                                                                                                                                                                        |

取票的 RPC：`loopbackGateway.issueTicket`（fork 契约文件 `packages/contracts/src/forkLoopbackGateway.ts`，仿照 `forkDeviceKeys.ts`），输入空，返回 `{ ticket, expiresAt, path, version, limits }`。客户端用 `createEnvironmentRpcCommand`，`permissionAtom` 决定 UI 是否可用。

### 4.3 权限：两个 scope 都要

默认要求 `preview:operate` **和** `terminal:operate`。理由：

1. 被转发的是终端和 agent 起的进程。网关给页面的能力是"以用户身份访问 B 上这些进程的网络接口"。这些接口常常没有认证（调试端点、管理界面、带副作用的开发 API），与在终端里运行命令的权限等价。上游已有先例：`previewStopLocalServer`（对列出的服务发信号）要求 `terminal:operate`（`CLIENT_GUARDED_RPC_SCOPES`）。
2. 只要 `preview:operate`，一个只能操作预览、不能操作终端的会话（例如以后给访客或 MCP 客户端的受限会话）就能借网关碰到终端里起的服务，这比它本来的权限大。
3. 我们自建连接的电脑会话和手机会话两项都有（`DeviceAssertionAuth.ts` 的 `scopesForDevice`：电脑是 `AuthStandardClientScopes`，手机只去掉 `access:write` 和 `relay:write`）；只读会话两项都没有。所以对实际用户没有额外限制。

实现：

- RPC 方法放进 `CLIENT_GUARDED_RPC_SCOPES`（用 fork 的展开 `FORK_LOOPBACK_GATEWAY_GUARDED_RPC_SCOPES`，值写 `preview:operate`，让 `permissionAtom` 可用）。`CLIENT_GUARDED_RPC_SCOPES` 每个方法只能写一个 scope，所以在 `clientRpcRequiredScopes` 里为这个方法加一条分支返回 `[preview:operate, terminal:operate]`（该函数本来就返回数组，`RpcAuthorization.ts:279` 对数组全部强制）。上游 4 行。
- 隧道路由自己检查两个 scope（`session.scopes`），因为它不走 RPC 授权层。
- 按 AGENTS.md 的要求，在权限行为测试里加这个方法。

### 4.4 A 端代理的认证

主进程代理只绑 `127.0.0.1`，但同一台电脑上的任何进程都能连这个端口。所以要求 `Proxy-Authorization`：每个环境、每次应用启动一个随机 256 位口令，用常量时间比较；Chromium 通过 `app.on("login")`（`authInfo.isProxy`）取口令，按 `webContents.session` 找到环境（实测可行，附录 A）。不带口令的连接得到 `407` 且不会触及隧道。

### 4.5 撤销链

复用 8.2 的机制（`research/self-host-device-keys.md` §3.8）：

| 事件                                      | 结果                                                                                                                                                      |
| ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 用户在 Sharing & access 里撤销该会话      | `SessionStore` 发布变更 → 每条隧道的 `awaitInvalidation` 返回 → 隧道关闭；新升级请求在 `verifyWebSocketToken` 读到 `revokedAt` → 401                      |
| 设备被移除（`./t3x revoke` 或桌面里移除） | 8.2 的对账撤销 `t3x-device:*` 会话，同上。FORK.md 记载的时延：其他电脑和手机的会话在各自下一次同步时撤销（同步间隔 60 秒），已建立的连接约 20–30 秒内断开 |
| 会话自然过期                              | 同上，`awaitInvalidation` 把过期也算失效                                                                                                                  |
| server 重启、关机                         | 隧道随之断开                                                                                                                                              |
| 票据本身过期                              | 已建立的隧道不受影响（票据只用于升级时的认证）；新隧道需要新票据                                                                                          |

测试要沿用 8.2 的并发测试风格：用 `Deferred` 等"隧道已建立"和"隧道已关闭"事件，不用 sleep。

### 4.6 重放与限速

- 票据是 bearer，窃取者在剩余有效期内可以开隧道，但仍受端口许可、并发上限、速率上限、撤销约束，**不能**调用 RPC（RPC 需要 DPoP）、不能读文件、不能用终端。
- 明文 `http://` 的局域网连接上，票据在 URL 里明文可被同网段嗅探（和 RPC 的 `wsTicket`、媒体路由的现状一致）。DPoP 绑定只保护 RPC，不保护我们这条。这是 Q1。
- `Origin` 头存在即拒绝，网页不能直接调用隧道端点。
- 隧道升级失败（401/403/404/429）不进 `AuthAttemptLimiter`：票据是 256 位 HMAC，暴力猜测没有意义，不为它改上游文件。
- 日志：隧道路径的 query 里有票据，实现时要核对 server 的请求日志和遥测不记录 query（未核实，列入 §14）。Caddy 默认不开访问日志（`Caddyfile` 没有 `log` 指令）。

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

### 5.3 连接时怎样核对，不触发重扫

端口发现有两档节奏：面板打开时 3 秒（live），只有后台订阅时至少间隔 15 秒（`BACKGROUND_POLL_INTERVAL_MS`）。网关**只用现有公开接口**：

```
authorize(port):
  servers = PortDiscovery.scanBackground()          // 上次扫描不到 15 秒就直接用，不起新扫描
  if owned(servers, port) → allow
  if 距上次"未命中重扫"不到 2 秒 → deny("not-owned")
  servers = PortDiscovery.scan()                    // 一次扫描，复用 scanSemaphore，同时到达的合并
  owned(servers, port) ? allow : deny
```

- 命中路径（绝大多数）只是读上次扫描的 `Ref`，没有进程调用。
- 未命中路径（用户手输了一个刚起的端口，或页面乱试端口）最多每 2 秒触发一次扫描，不是每个请求一次。恶意页面扫端口，每 2 秒最多推动一次 `lsof`。
- 没有任何地方新增轮询。
- `scan()` 在"没有终端登记进程、没有 agent、没有配置 URL"时本来就直接返回空（`scanUnlocked` 的短路），不会白跑 `lsof`。

### 5.4 `T3CODE_PORT_DISCOVERY=0`

这时 `scanUnlocked` 只探测配置的 URL，`discovered` 永远为空，网关没有任何可许可的端口。处理：

- server 启动时读同一个环境变量（上游需要把 `PORT_DISCOVERY_ENV` 常量 `export` 一下，1 个词），为 `0` 时不广告能力（`capabilities.loopbackGateway` 不出现）。客户端据此走"B 不支持"的路径，不会白取票据。
- 取票的 RPC 在这种状态下回 `LoopbackGatewayUnavailableError { reason: "discovery-disabled" }`，防止旧缓存的能力。
- 错误页文案专门说"这台环境关闭了端口发现"。

### 5.5 绑定地址

服务只绑 `::1`（macOS 上 Vite 的 `localhost` 常解析成 `::1`，FORK.md 提过）或只绑 `127.0.0.1` 时，网关必须连端口发现看到的那个地址。现状：`DiscoveredLocalServer` 只有 `host: "localhost"`，不带绑定地址；`lsof` 输出里有（`n127.0.0.1:5173`、`n[::1]:5173`、`n*:5173`），`/proc/net/tcp{,6}` 也有，Windows 的 `netstat` 解析没有。

推荐：`PortScanner` 在合并时记下每个端口的绑定类别（`v4` / `v6` / `any`）和对应 PID，通过一个新的 `PortDiscovery.ownedListener(port)` 在现有的上次扫描快照里查，不新增扫描。网关拨号：`v4` → `127.0.0.1`，`v6` → `::1`，`any` → `127.0.0.1`，Windows 或未知 → 依次试 `127.0.0.1`、`::1`。同一端口 v4 和 v6 属于不同进程时，上游已经把它当无主，不会走到这里。

这是上游文件里最大的一处改动（`PortScanner.ts` 约 +25 行）。如果主控不愿意改，退路是"依次试两个地址"，残余风险是：T3 的服务只绑 `::1`，而另一个无关进程在两次扫描之间抢占了同端口的 `127.0.0.1`，网关会先连到后者。窗口至多一个扫描间隔，且两个进程都是用户自己的。这是 Q4。

### 5.6 排除清单（即使端口发现里出现也不行）

网关在许可检查之后、拨号之前再过一遍排除，**排除优先于许可**：

| 排除对象                                      | 办法                                                                                                                                                                                                                                                                                                                                                             |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 承载网关的 server 进程自己的全部监听          | `listener.pid === process.pid`。覆盖主端口、隧道监听口（`TunnelListener`）、`DesktopBrowserChannel` 的随机回环口、`CodexChatGptAuth` 的 OAuth 回调口、`htmlRender/publicProxy` 的回环口                                                                                                                                                                          |
| 同样的端口号（以防 pid 为空）                 | 明确登记：`ServerConfig.port`、`TunnelListener.port`；`DesktopBrowserChannel.endpoint` 的端口                                                                                                                                                                                                                                                                    |
| server 托管的子进程                           | 无头 Chrome 用 `--remote-debugging-pipe`（`headlessChrome.ts:188`，没有 TCP 端口）、frpc 配置里明确"opens no admin web server"、资源监视器是原生客户端没有 TCP 监听 —— 现状下这几个没有回环监听。仍要做成登记表（`GatewayExclusions`），谁以后加监听谁登记，并有测试：启动一台带隧道的 server，断言它自己的主口、隧道口都被拒                                    |
| 桌面的 `T3CODE_DESKTOP_REMOTE_DEBUGGING_PORT` | 用户显式设置才开，监听者是桌面主进程，不是 server 进程，`pid === process.pid` 排除不到它。只有桌面是从 agent 的终端里启动时才会被列为有主（这个仓库的日常工作流正是如此）。无法按 pid 枚举，列为残余风险：默认调试端口 9222 在 Q3 的屏蔽表里；Chromium 对带 `Origin` 的调试 WebSocket 握手默认拒绝（需要 `--remote-allow-origins`），我没有在 Electron 44 上验证 |

值得单独说的一个坑：用 agent 在 B 上跑 T3 自己的开发服务器（这个仓库的日常工作流）时，**外层**承载网关的 server 本身的环境也带 `T3CODE_THREAD_ID`，会被端口发现列成 agent 有主。这正是要用 `pid === process.pid` 排除而不是看有主与否的原因。**内层**被预览的 T3 实例是另一个进程，正常许可。

可选加固（Q3，我建议做）：额外屏蔽几个绝不会是网页的调试和管理端口：9222（Chrome DevTools）、9229 和 5858/5859（Node 调试器）、2375/2376（Docker）。理由见 §6。

## 6. 威胁模型

### 6.1 恶意页面借转发能多做什么

页面指：标签页里加载的任何内容，包括被 agent 改过的开发页面，或用户在这个标签页里导航到的外部网站。

| 能做的                        | 说明                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 访问 B 上所有"有主"的回环服务 | 这是功能本身。比"在 B 的浏览器中打开"（现有功能，页面能访问 B 的全部回环端口，没有许可）窄                                                                                                                                                                                                           |
| 对有主端口说调试协议          | 页面只能通过浏览器 API 发 HTTP、WebSocket、TLS，不是任意 TCP。但 WebSocket 握手不受 CORS 约束：只检查 `Host` 的调试协议服务（例如 Node 的 `--inspect`）会接受 `Host: localhost`，页面能直接说调试协议，等于在 B 上执行代码（这是我对这类服务行为的了解，没有实测）。**这是屏蔽调试端口的理由**（Q3） |
| 访问 A 的回环服务             | **不能**。同一分区里回环流量全部去了 B。相对现状（B 的标签页里 `localhost` 指 A）这是收紧                                                                                                                                                                                                            |
| 访问 T3 自己的端口            | 不能（§5.6），页面连不上 B 的 T3 API、隧道口、桌面内置 server 的其他回环口                                                                                                                                                                                                                           |
| 读 A 的文件、剪贴板           | 与网关无关，沿用预览的现有权限（`ALLOWED_PREVIEW_PERMISSIONS`）                                                                                                                                                                                                                                      |

### 6.2 DNS rebinding

- A 端：只有回环名（含 `*.localhost`）和回环 IP 字面量会到代理，Chromium 自己判定，不经 DNS。代理再校验一遍，非回环一律 403。`evil.com` 解析到 127.0.0.1 的重绑定页面，其请求直连 A（现状如此），不经过我们。
- B 端：只拨 `127.0.0.1`/`::1` 字面量，不解析名字；目标只有端口号。
- 页面的 `Host` 头原样转发，是它自己的请求，不构成越权。

### 6.3 转发出来的连接在 B 上看起来来自回环地址

会。B 上的程序看到的对端是 `127.0.0.1`，可能因此放宽检查：免认证的调试接口、`allowedHosts` 里放行 localhost 的 dev server、只信任回环的管理端点。这就是 §6.1 说的风险面。缓解叠加：只许可有主端口；屏蔽调试端口；`Host` 头保持原样（程序仍能拒绝它不认的 Host）；功能本身只在用户明确打开这个标签页时才有流量。记入文档："转发进来的连接对 B 上的程序看起来是本机访问"。

### 6.4 cookie 隔离

分区按环境隔离（§2）。同一环境内 `localhost` 的 cookie 不分端口（浏览器的通用行为，与在本机开发一样）。不同环境之间、与本机环境之间互不可见。B 的 T3 自己的会话 cookie 在这个分区里不存在（T3 的页面不在预览分区里加载）。

### 6.5 票据泄露后的影响范围

持票者（5 分钟内，需要能到达 B 的网址）可以：对 B 上有主、未排除的端口开隧道，上限 64 条并发，速率受限。不能：调用 RPC（要 DPoP）、读文件、用终端、碰 T3 自己的端口。撤销会话后立即失效。票据只在 A 主进程内存中。

### 6.6 其他

- A 端代理被本机其他进程利用：需要口令（§4.4）。
- B 端被未认证请求打：路由要求票据、拒绝带 `Origin` 的请求；票据校验失败不进数据库以外的任何地方。
- 日志泄露：核对 query 不入日志（§4.6）。

## 7. 界面与文案

原则：地址栏不变；不新增常驻控件；用上游 `components/ui` 现有 variant；所有文案走 `t()` 并补 `zh-Hans` catalog（新文件 `catalogs/zh-Hans/loopbackGateway.ts`，术语按 `GLOSSARY.md`）；桌面主进程生成的 HTML 用 `translate(getUiLocale(), …)`（`BrowserSession.ts` 已有先例）。

### 7.1 转发标识

地址栏旁一个小图标（现有 `PreviewChromeRow` 里），只在以下全部为真时出现：桌面运行时的标签页、环境非本机、网关状态 `active`、当前 URL 的主机是回环名。悬停提示："localhost 已转发到 {environment}"。点开是小菜单（现有 Menu 组件）：

- "在 {environment} 的浏览器中打开"（上游已有动作，复用）
- "停止转发，使用这台电脑的 localhost"（§10）

### 7.2 错误卡片

加载失败时上游画 `PreviewUnreachable`（带「在 X 的浏览器中打开」，来自 #17316）。我们给它加一个 `reason`，根据主进程发来的 `gatewayDenied` 事件（以及 B 离线、旧版等状态）换文案，不新做页面：

| 情形                                                 | 标题 / 说明                                                                          | 操作                            |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------- |
| 端口不是 T3 起的（`not-owned`）                      | 「这个端口不是 T3 起的服务」「{environment} 只转发它的终端和 agent 启动的服务。」    | 在 {environment} 的浏览器中打开 |
| 端口被保留（`reserved`，T3 自己的或屏蔽的调试端口）  | 「这个端口不能转发」                                                                 | 同上                            |
| 没有程序在监听（`upstream-refused`）                 | 「{environment} 上没有程序监听 {port}」「服务启动后重试。」                          | 重试                            |
| B 离线 / 不可达（`offline`）                         | 「连不上 {environment}」                                                             | 重试                            |
| 权限不够（`forbidden`）                              | 「这个连接没有转发权限」「需要预览和终端权限。」                                     | —                               |
| B 是不支持网关的旧版或上游版（`unsupported-server`） | 「{environment} 的 T3 版本不支持转发 localhost」「更新它，或者在它的浏览器中打开。」 | 在 {environment} 的浏览器中打开 |
| 经 T3 Connect 中继（`unsupported-route`）            | 「通过 T3 Connect 的连接不支持转发 localhost」                                       | 同上                            |
| 端口发现关闭（`discovery-disabled`）                 | 「{environment} 关闭了端口发现」                                                     | 同上                            |
| 达到上限（`limit-reached` / `rate-limited`）         | 「转发的连接太多」                                                                   | 重试                            |

后两行"不支持"的情形没有主进程事件（没装代理，Chromium 直接连 A 的 `localhost` 被拒）。这时 `PreviewUnreachable` 的 fork 钩子看"远程环境 + 回环主机 + 网关状态不是 active"，换成对应的说明。

### 7.3 票据自动续期

用户感觉不到：续期在渲染进程里提前做（§4.2）；刚过期的短窗口里，新连接的错误卡片显示"正在重新连接…"并在拿到票据后自动重载一次主框架（只在卡片是因为 401 出现时）。

### 7.4 i18n 工作量

约 25 条新文案，一个 catalog 文件，`vp run i18n:report` 必须 0 missing / 0 stale，`i18n.test.ts` 通过。需要截图验收：中英文各一张的转发标识和三种错误卡片，守住上游风格（见记忆：UI 审美要求）。

## 8. 能力探测与退路

四道门，全部满足才启用，任何一道不满足都**保持现有行为**：

1. **运行时**：`window.desktopBridge?.preview` 存在（桌面版）。网页和手机不进入。
2. **环境**：非主环境，且不满足 `reachesEnvironmentLoopback`（WSL 等不需要）。
3. **能力**：`environment.capabilities.loopbackGateway === true`。读取方式照 `readEnvironmentSupportsServerBrowser`（`apps/web/src/state/entities.ts:349`），在 `apps/web/src/fork/loopbackGateway/capability.ts` 里写一个同样的读取函数，不改上游。服务端在 `ServerEnvironment.ts:279` 旁加一行；契约在 `environment.ts:156` 旁加一行 `optionalKey`，老服务端不发这个字段，客户端读到 `false`。
4. **连接与权限**：连接目标不是中继；会话有两个 scope（`permissionAtom`）；用户没有在这个环境上关闭转发（§10）。

这些组合成状态：`active | unsupported-server | unsupported-route | no-permission | disabled-by-user | not-applicable`。`resolveDiscoveredServerUrl` 只在 `active` 时对回环 URL 原样放行；其他状态走原逻辑（私网改写成环境 IP、公网回退）。这样上游版本的 B 和关闭转发的用户完全不受影响，「在 B 的浏览器中打开」始终存在。

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
| 命令面板                                                                                                      | 现有的打开链接和浏览器命令都落到上面这些路径                                                  | 不新增命令。转发开关放在标识的菜单里（§7.1）。如果主控想要面板里也有，是一条 fork 命令，成本很低但属于范围扩大，列入 Q6                                                                                                                  |
| 重启后恢复的标签页                                                                                            | 服务端保存会话，打开对话时重新挂 webview                                                      | 靠 §2.3 的"网关已登记"门；不持久化转发状态，只持久化"用户对哪些环境关闭了转发"                                                                                                                                                           |
| agent 用 `preview_open` / `preview_navigate` 打开标签页                                                       | 见下                                                                                          | **不涉及网关**                                                                                                                                                                                                                           |

关于最后一行，我查到的事实：远程环境上 agent 打开的标签页用**服务端运行时**（B 上的无头 Chrome，画面推流），`localhost` 本来就指 B。证据：`previewRuntimeFor` 对 `serverBrowser` 的环境返回 `"server"`；上游在 #16827 的关闭说明里写明"desktop now opens remote-environment browser tabs locally for user-opened tabs. Agent-opened tabs and web/mobile clients still stream."；`DesktopBrowserChannel` 是桌面应用和**它自己内置 server** 之间的 fd 通道（`ServerConfig.desktopBrowserFd`），不连别的环境；`apps/web/src` 里没有 B 的 agent 去驱动 A 桌面 webview 的 automation host 代码。所以"B 的 agent 在 A 桌面渲染的标签页里操作"在这个代码库里不存在，网关不需要也不应该处理它。我没有端到端验证这一点（没有启动应用），9.3 的手动检查里加一条：在远程对话让 agent 打开 `localhost:5173`，确认它是服务端标签页。

## 10. 反向状态

| 想要                              | 办法                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 这个环境不再转发                  | 标识菜单「停止转发，使用这台电脑的 localhost」。写入本机设备级 store（`apps/web/src/fork/loopbackGatewayStore.ts`，localStorage，键名沿用 `sidebarViewStore.ts` 的方式，不进 `ClientSettings`、不改 contracts）。主进程把该环境所有分区改回 `{ mode: "direct" }` 并 `closeAllConnections()`。再次打开同一个菜单项为「恢复转发」，两个方向都有 |
| 某个标签页单独不转发              | **做不到，也不做**：代理是 session 级的，一个环境的所有标签页共用。需要 A 的 `localhost` 时：系统浏览器，或本机环境对话里的标签页。写进用户文档                                                                                                                                                                                               |
| 环境断开                          | 渲染进程把状态置 `offline` 推给主进程；之后的新请求得到 `offline` 错误页。**已建立的隧道不受 RPC 连接影响**（它们是独立的 WebSocket），只在 B 或网络真断时才断                                                                                                                                                                                |
| 环境重连                          | 渲染进程重新取票据、推给主进程、状态回 `active`。页面可能需要手动刷新；Vite HMR 会自己恢复                                                                                                                                                                                                                                                    |
| 路由切换（局域网 → 隧道）         | 渲染进程订阅连接的 `httpBaseUrl`，变化时推新地址；旧隧道自然结束，新连接走新地址                                                                                                                                                                                                                                                              |
| 应用重启                          | 代理、口令、票据都不持久化。启动后恢复标签页，webview 等"网关已登记"（本地 IPC，不等网络）；主进程以 `pending` 状态先装好代理，没有票据时回 503，非回环流量不受影响；渲染进程连上 B 后取票据变 `active`                                                                                                                                       |
| B 升级成支持的版本 / 降级成不支持 | 能力来自服务器配置，随连接更新；`active` 与否变化时安装器装上或拆掉代理                                                                                                                                                                                                                                                                       |

## 11. 性能

- **不轮询。** 票据续期是一次性定时器；端口许可靠现有快照，未命中至多每 2 秒触发一次扫描；没有新增订阅。
- **不按请求扫描。** 命中路径只读内存。
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

### 9.0 技术前提验证（S）

两件事，各用最小骨架，任何一件失败就回到本文重新设计：

1. **B 端**：在共享 `HttpRouter` 上加一条 `GET /api/loopback-gateway/tunnel` 升级路由，把 `request.upgrade` 的 Socket 对接到 `net.connect`，确认：主监听口和 `TunnelListener` 口都能用；背压（写慢的一端会不会无限缓冲）；`awaitInvalidation` 竞速能关闭它。
2. **A 端**：`http.Agent` 的 `createConnection` 返回自定义 `Duplex`，对着一个本地 SSE/分块/大上传的服务跑；确认 `ws` 的 `createWebSocketStream` 到 B 的通路；决定是否并入系统根证书（§3.6）。

验收：两个小脚本的原始输出放 `/tmp`，结论回写本文 §3；脚本不进仓库。

### 9.1 server 网关（M）

范围：契约 `forkLoopbackGateway.ts`、`auth.ts` 的 audience、能力位、RPC `loopbackGateway.issueTicket`、隧道路由、许可检查、排除表、`PortDiscovery.ownedListener`（若 Q4 同意）、速率与并发上限。

验收：

- 两个 scope 缺一不可；只读会话被拒。
- 票据：过期、篡改、错 audience（`rpc` 的 `wsTicket`、`media` 的 `wsTicket`）、已撤销会话、没有 `wsTicket`、带 `Origin`、Cookie/Bearer 回退：全部被拒。
- 端口：有主放行；无主、T3 自己的主口和隧道口、屏蔽的调试端口被拒；`T3CODE_PORT_DISCOVERY=0` 不广告能力、RPC 报 `discovery-disabled`；只绑 `::1` 和只绑 `127.0.0.1` 的服务各自连得上；未命中重扫的 2 秒限流。
- 撤销：会话撤销后，已建立的隧道关闭，新升级 401（`Deferred` 等事件）。
- 上限：每会话并发、速率。
- 主监听口和隧道监听口行为一致。

测试层：许可/排除/拨号选择是纯函数 → 单元测试（`apps/server/src/fork/loopbackGateway/*.test.ts`）；路由与撤销 → 起真实 server 层加真实 `ws` 客户端和真实回环服务（沿用 `TunnelListener.test.ts` 的 harness）；权限表 → 契约行为测试（AGENTS.md 要求加受保护方法时扩展）。

### 9.2 桌面代理与分区（M）

范围：`apps/desktop/src/fork/loopbackGateway/`：代理、隧道客户端、环境注册表、会话安装器、`app.on("login")`、错误页和 `webRequest` 事件、IPC 与 preload 桥、票据续期请求。

验收：

- 主机判定表（§1.2）逐项；非回环一律 403；`0.0.0.0` 不转发（文档化）。
- 口令：无口令 407；有口令放行；两个环境各一份口令互不通用。
- HTTP：流式/SSE、分块、`Connection: close`、大请求体、中途取消；同一条 Chromium 连接上不同端口的请求各自选对隧道；keep-alive 复用。
- CONNECT（https、ws）：数据双向、一端关闭另一端关闭。
- 票据过期的行为；`pending` 状态回 503。
- 会话安装器：`setProxy` 的参数就是 §1.1 的规则串；改回直连时 `closeAllConnections`；多个 profile 都装；新 profile 补装。
- **真实 Electron**：把附录 A 的 spike 改成一个可重复的脚本（`vp run fork:loopback-gateway:electron-smoke`，不进 CI，在 9.4 的人工验收里跑）。

测试层：代理逻辑用假隧道（一对 `Duplex`）做单元测试，不碰 Electron；安装器用 mock 的 `Session`；Chromium 实际行为只能在真 Electron 里证明，所以放在脚本里。

### 9.3 web 接线、界面与中文（M）

范围：`apps/web/src/fork/loopbackGateway/`（能力读取、取票据与续期的挂载组件、store、标识、错误卡片）、`resolveDiscoveredServerUrl` 的改动、`HostedBrowserWebview` 的等待门、`PreviewUnreachable` 的 reason、zh-Hans catalog。

验收：

- `resolveDiscoveredServerUrl` 表测试：`active` 时放行；各非 active 状态走原逻辑；`systemBrowser` 选项行为不变；`0.0.0.0` → `localhost`。
- 续期调度是纯函数（输入现在时间和过期时间，输出下一次动作），不用定时器测。
- 一个浏览器测试：错误卡片按 reason 换文案（`render` from `apps/web/test/render.tsx`）。
- `vp run i18n:report` 0 missing / 0 stale；`i18n.test.ts` 通过。
- 中英文对照截图（标识和三种卡片）。
- `vp run fork:guard`、`vp run check:changed`。

### 9.4 两台电脑的端到端与文档（M）

场景：B 的 T3 终端起 Vite，A 打开 `localhost:5173`，热更新可用，非 T3 起的端口被拒。

1. **无界面部分**加进 `vp run fork:selfhost:e2e` 作为新场景：A、B 是现有 harness 起的两台真实 server；B 的终端经 RPC 打开并写入命令起一个带 SSE 和 WebSocket 的小服务；A 端用桌面代理模块（纯 Node，不 import electron）经自建隧道取页面、收 SSE、说 WebSocket；一个**不是**终端起的服务（harness 直接 spawn 的）被拒；移除 B 上 A 的设备后隧道关闭。
2. **界面部分**在 Electron 里做一次（`test-t3-app`，用 `--use-mock-keychain`、`--host-resolver-rules="MAP *.t3.localhost 127.0.0.1"`、定向信任 Caddy CA）：Vite 示例，输入 `localhost:5173`，地址栏不变、标识出现、改文件热更新生效、`https://localhost` 自签名、端口列表点击、终端链接点击、重启应用后恢复标签页；非 T3 起的端口出卡片；关闭转发后回到旧行为。
3. 按 §11.1 测首屏。
4. 文档：`docs/user/remote-access.md` 的 "Browser on a remote environment" 旁加一节；FORK.md 加一节；本文档写入结果。

验收：上面全部通过；`fork:selfhost:e2e` 连续两遍全绿；官方基线不变（不碰 `~/.t3`、fork 真实 home）。

### 以后再做（不在 9）

- 多路复用 / 预开隧道（视 §11.1 结果）。
- 记录绑定地址的上游改动之外的更细归属（按线程精确归属需要改 contracts）。
- 网页版（附录 C）。

## 13. 上游改动预算

新代码全部放 `apps/*/src/fork/` 和 `packages/*/src/fork*`。

| 上游文件                                                                      | 预计行数                                                             | 内容                                                                                         |
| ----------------------------------------------------------------------------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/contracts/src/environment.ts`                                       | +2                                                                   | 能力位 `loopbackGateway`                                                                     |
| `packages/contracts/src/rpc.ts`                                               | +2                                                                   | 展开 fork RPC（同 `FORK_DEVICE_KEYS_RPCS`）                                                  |
| `packages/contracts/src/index.ts`                                             | +1                                                                   | 导出 fork 契约                                                                               |
| `packages/contracts/src/clientRpcPermissions.ts`                              | +4                                                                   | 展开受保护 scope、`clientRpcRequiredScopes` 里为该方法返回两个 scope                         |
| `packages/contracts/src/auth.ts`                                              | +1                                                                   | `AuthWebSocketTicketUse` 加 `"loopback-gateway"`                                             |
| `apps/server/src/ws.ts`                                                       | +3                                                                   | 注册 RPC 处理器（同 `makePushRpcHandlers`）                                                  |
| `apps/server/src/server.ts`                                                   | +4                                                                   | 路由层与服务层                                                                               |
| `apps/server/src/environment/ServerEnvironment.ts`                            | +2                                                                   | 广告能力（受 `PORT_DISCOVERY` 影响）                                                         |
| `apps/server/src/preview/PortScanner.ts`                                      | +25                                                                  | 记录绑定类别、`ownedListener`、导出 `PORT_DISCOVERY_ENV`（Q4，可拒）                         |
| `apps/desktop/src/preload.ts`                                                 | +8                                                                   | 桥                                                                                           |
| `apps/desktop/src/ipc/DesktopIpcHandlers.ts`                                  | +2                                                                   | 安装 IPC                                                                                     |
| `apps/desktop/src/main.ts`                                                    | +2                                                                   | 层                                                                                           |
| `apps/desktop/package.json`                                                   | +1                                                                   | `ws` 依赖（当前没有任何工作区包直接依赖它，它只作为 `@effect/platform-node` 的传递依赖存在） |
| `apps/web/src/browser/browserTargetResolver.ts`                               | +8                                                                   | `active` 时放行、`systemBrowser` 选项                                                        |
| `apps/web/src/browser/HostedBrowserWebview.tsx`                               | +3                                                                   | 等"网关已登记"                                                                               |
| `apps/web/src/components/preview/PreviewUnreachable.tsx`                      | +6                                                                   | reason 卡片钩子                                                                              |
| `apps/web/src/components/preview/PreviewChromeRow.tsx`                        | +3                                                                   | 标识                                                                                         |
| `apps/web/src/components/AppSidebarLayout.tsx`                                | +2                                                                   | 挂载取票据与续期（同 `KeepAwakeReporter`）                                                   |
| `FooterPorts.tsx`（fork 文件）、`ThreadServersPanel.tsx` 两处系统浏览器调用点 | +2                                                                   | `{ systemBrowser: true }`                                                                    |
| `packages/client-runtime/src/i18n/catalogs/zh-Hans/index.ts`                  | +2                                                                   | 注册 catalog                                                                                 |
| 合计（不含文档）                                                              | **约 +85**，20 个上游文件（另有 fork 自己的 `FooterPorts.tsx` 一行） | 停止线 130 行；超线先放弃 `PortScanner.ts`（退路：依次试两个地址）                           |
| 文档                                                                          | `docs/user/remote-access.md` +25、`FORK.md` +40                      |                                                                                              |

上游 26 个新提交（`322f6544df..8b44f42b14`）预判：

- 这四个目录**零改动**：`apps/web/src/browser`、`apps/web/src/components/preview`、`apps/desktop/src/preview`、`apps/server/src/preview`（`git diff --stat` 为空）。
- 上表里每个文件在这 26 个提交里都**零改动**；整个区间对 `apps/desktop`、`apps/server/src/ws.ts`、`packages/contracts` 只改了 3 个文件（两个 `package.json` 的版本号、`contracts/src/review.ts` +5 行）。
- 上游 main 仍然没有网关（`Gateway.ts` 不存在）。

预估新代码规模：server 约 700、desktop 约 900、web 约 500、契约与共享约 200，测试另约 1,500。

## 14. 需要主控拍板的问题

**Q1. 局域网明文 `http://` 连接是否也启用？** 票据在 query 里明文，同网段可嗅探，5 分钟内可开隧道（受许可和上限约束，不能调 RPC）。RPC 本身有 DPoP，网关没有。选项：A 默认启用，文档写明；B 只在 https、Tailscale、SSH 转发、回环上启用，明文局域网回到旧行为（局域网用户恰恰是最常见的，他们本来就能靠"监听 0.0.0.0 + 改写成环境 IP"凑合）。**我推荐 A**：明文局域网上终端输出、代码本来就是明文的，网关没有让情况质变；但如果你的使用场景里局域网不可信，选 B。

**Q2. 项目脚本配置的 Preview URL 是否算许可？** 我建议**不算**（§5.2）。算的话要先确认 agent 能不能改项目脚本。

**Q3. 是否额外屏蔽调试端口 9222、9229、5858、5859、2375、2376？** 我建议**屏蔽**（§5.6、§6.1），成本一个常量表。

**Q4. 是否同意改 `PortScanner.ts`（约 +25 行）来记录绑定地址？** 同意则精确连到端口发现看到的地址；不同意则依次试 `127.0.0.1`、`::1`，有一个窗口很小的残余风险（§5.5）。我推荐同意。

**Q5. 权限是否坚持两个 scope？** 我推荐坚持（§4.3）。如果你只想要 `preview:operate`，改动只是 `clientRpcRequiredScopes` 里不加分支、路由里少检查一个，但受限会话就能碰到终端起的服务。

**Q6. 命令面板是否加「转发 localhost」开关？** 默认不加，开关只在标识菜单里。要加是一条 fork 命令。

**Q7. 同意"一个环境所有标签页共用转发，不支持单标签页关闭"吗？** 技术上 session 级代理做不到按标签页（§10）。

**Q8. 同意先不支持 `0.0.0.0` / `[::]` 吗？** Chromium 不把它们当回环，它们会连到 A 本机。web 地址规范化换成 `localhost`，页面自己写死的不管。

**Q9. 同意 9.0 作为独立的前置验证阶段吗？** 两个前提（B 端 Socket 背压、A 端 `Agent` 对自定义 `Duplex`）验证失败会改动传输层设计，所以先花半天确认。

**我没有核实的前提（汇总）：**

- frp 在几十条并发升级连接、长时间空闲连接下的行为（9.4 测）。
- B 端 Effect `Socket.writer` 的背压是否足够（9.0）。
- server 请求日志/遥测是否记录 query（实现时核对）。
- 主进程并入系统根证书是否可行、私有 CA 的 B 地址（9.0）。
- 经 T3 Connect 中继的行为（明确不支持，没测）。
- `protocol.handle`、`webRequest` 的否决只依据文档，没有实测。
- Windows 上的端口归属（`netstat`、无 agent 档）和 `ps -E` 在不同 macOS 版本上的表现，沿用上游，没有重测。
- "B 的 agent 不会驱动 A 的桌面标签页"是读代码得出的，没有启动应用验证（9.3 手动检查）。

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
