# 自建配对：每台设备一把钥匙（设计）

- 日期：2026-11-03。基线：`main` @ `35d24458d0`。只读调研加设计，没有写实现代码，没有运行 server / dev / Docker。
- 标注约定：**[已核实]** = 读过源码或官方文档对应行；**[推断]** = 根据代码结构或旧版本文档推理，没有逐行验证或没有运行；**[待验证]** = 依赖 frp / Caddy / Node 的运行时行为，阶段 8.0 的验证（见第 8 节）必须先确认。
- 出处写成 `path:line`，相对仓库根目录。frp 和 Caddy 的文档来自 context7（frp 文档是 dev 分支 / v0.71，部署包钉的是 v0.61.1，版本差异一律标 [待验证]）。
- 用户已批准的方案（SSH 式每台设备一把钥匙）和承诺的安全模型是本文的规格，不再重新讨论；本文只回答"怎么做"。
- **读法**：20 分钟读完第 0 节（结论速览）、第 4 节（威胁模型）、第 5 节（阶段）、第 10 节（要你拍板的问题）就够做决定；第 2、3 节是逐题依据和协议细节，实现者再读；第 7、8 节是测试和先要验证的前提。

## 0. 结论速览

一句话：**每台设备自己生成一把 P-256 密钥，VPS 上的注册表（registry）只存公钥。电脑用密钥签名登录隧道，设备用密钥签一张"只给这台电脑、60 秒有效"的通行证，换到一个绑定设备密钥的普通 T3 会话。**

### 0.1 十五个问题，一行一个结论

| #   | 问题                       | 结论                                                                                                                                                                                                                                                 |
| --- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 密钥类型和格式             | **P-256 / ES256，JWK 公钥，设备 id = RFC 7638 指纹**。手机的设备密钥和 DPoP 会话密钥**分开**：一把标识身份（注册到 VPS），一把绑定会话（可随时更换）                                                                                                  |
| 2   | 设备怎么向电脑证明自己     | **JWT-bearer 通行证（assertion）**，不做挑战往返。通行证由设备密钥签名，`aud` = 目标电脑的 environmentId，`exp ≤ 120 秒`，带 `jti` 和 `cnf.jkt`。放在 fork 自己的路由 `POST /oauth/t3x-device`，线上格式沿用 RFC 7523，返回值与 `/oauth/token` 完全相同 |
| 3   | 桌面渲染进程连别的电脑     | 渲染进程把自己的 DPoP 指纹发给本机 server（RPC `devices.signAssertion`），本机 server 用电脑的设备密钥签名。**只有本机 owner（`desktop-bootstrap` 主体、非转发请求）能要求签名**，且目标必须是清单里的另一台电脑                                     |
| 4   | 密钥放哪、丢了怎么办       | 手机：`expo-secure-store` 里独立的一项。渲染进程：没有设备密钥。电脑：server 的 `ServerSecretStore`（0600）。**丢了就是一台新设备**，没有恢复路径，到任一台电脑上移除旧条目                                                                           |
| 5   | VPS 上的注册表             | **Node 24（`node:sqlite` + `node:crypto` + `node:http`），零 npm 依赖**，用 `infra/self-host/` 里的 Dockerfile 在 VPS 上构建。请求用设备密钥签名（`T3X-Proof`，覆盖方法、完整 URL、请求体哈希、`jti`）。`./t3x` 是对同一份模块的 `docker compose exec`   |
| 6   | 隧道                       | frp 走 443：**wss 经 Caddy 的 `/~!frp` 路径**进 frps；每台电脑一个 **HTTP vhost 子域名**；注册表同时是 frps 的服务端插件（`Login`/`NewProxy`/`Ping`/`NewWorkConn`）。登录凭据是电脑自签的 24 小时 ticket，放在 `metadatas`                             |
| 7   | frpc 在哪运行、怎么发     | **由 server 托管**（不是桌面主进程），这样无头 `t3x` 也能用，签名也不用跨进程。固定 frp 0.61.1 + SHA-256，由 `fork-dist-mac.ts` 放进 `.app` 后和其余 Mach-O 一起签名。无头：`t3x devices tunnel install` 或 PATH                                       |
| 8   | 电脑上的设备清单同步       | 每 60 秒带 `If-None-Match` 拉一次，落到 `ServerSecretStore` 的 JSON 文档；VPS 不通时用最后一份清单，局域网照常。清单里消失的设备，其 `t3x-device:*` 会话全部撤销                                                                                     |
| 9   | 邀请                       | `t3x1.<base64url(JSON)>`，约 200 字符，QR 里放同一个字符串。含 registry 源、registry id、邀请 id 和密钥、设备类型、过期时间。子域名由电脑名派生，保证唯一，保留 `ntfy` 等                                                                              |
| 10  | 客户端发现与保存           | 手机：回到前台时（≥30 秒间隔）向注册表取清单；电脑渲染进程：订阅本机 server 的清单流。环境以 `BearerConnectionProfile`（`authorization: "t3-connect"`）保存，认证由 fork 的装饰层接管，**不改 resolver / routes / driver**。局域网路由靠已有的学习路由 |
| 11  | UI                         | 桌面：Sharing & access 里新增"Devices"区（加入、清单、邀请、移除），原来的"公网地址 + 隧道命令"收进"Advanced"。手机：加入页（扫码或粘贴）+ 设备清单页                                                                                                 |
| 12  | 现有 fork 代码             | `PublicUrls`、`DirectEndpoints` 的 public 路由、`DesktopSelfHost`、`ManagedTunnel` 都保留（Advanced 用）；`AuthAttemptLimiter` 加一条路径；ntfy 并入同一套 compose（`ntfy.<域名>`，由 `setup.sh` 默认安装）                                           |
| 13  | 测试                       | 单元测试逐层；端到端用 compose 绑 `127.0.0.1:18443` + Caddy `tls internal` + `*.t3.localhost`，名字解析靠只在测试进程里加载的 DNS 预载脚本，CA 靠 `NODE_EXTRA_CA_CERTS` 和 frpc `trustedCaFile`，不改 `/etc/hosts`、不动钥匙串                       |
| 14  | 阶段                       | 6 个阶段：8.0 验证（S）→ 8.1 VPS（L）→ 8.2 server 核心（L）→ 8.3 隧道与无头 CLI（M）→ 8.4 客户端（L）→ 8.5 打包、文档、端到端（M）。8.3 和 8.4 在合约冻结后可并行                                                                                     |
| 15  | 威胁模型                   | 见第 4 节：8 项要求的情形加 6 项补充。最大的剩余风险是"VPS 被攻破"（已接受）和"带终端权限的手机能读到电脑的设备密钥"（同一用户 shell，不是 OS 边界）                                                                                                  |

### 0.2 关键决策表

| 决策                       | 选择                                                                           | 放弃的方案                                       | 主要理由                                                                                  |
| -------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| 密钥算法                   | P-256 / ES256                                                                  | Ed25519                                          | 现有 DPoP 验证、签名、手机 noble 实现全是 P-256；Secure Enclave 和 WebCrypto 只保证 P-256 |
| 设备密钥与 DPoP 密钥       | 两把                                                                           | 手机复用 DPoP 密钥                               | 电脑渲染进程必须支持"两把"，一条代码路径；DPoP 密钥可换而不必重新注册                     |
| 设备证明方式               | 一次性通行证（assertion）                                                      | 挑战-应答                                        | 一次往返、server 不存挑战状态；`jti` 加 DPoP 双重绑定足够                                 |
| 通行证的端点               | fork 自己的路由 `/oauth/t3x-device`                                            | 给 `/oauth/token` 加第二种 grant                 | 不改上游的契约 schema 和处理器；限速中间件加一行                                          |
| 注册表运行时               | Node 24 + `node:sqlite`                                                        | Go / Python / 带 npm 依赖                        | VPS 上只靠 Dockerfile 构建，测试和 server 同一门语言                                      |
| 隧道代理类型               | HTTP vhost（子域名）                                                           | 每台电脑一个 TCP 端口                            | 只开 443；Host 原样透传；子域名即身份                                                     |
| 隧道登录凭据               | `metadatas` 里的自签 ticket + 显式心跳                                         | frp OIDC（每次登录现签）                         | 只依赖文档写明的行为；OIDC 路线列为 8.0 的优化备选                                        |
| frpc 谁来托管              | server                                                                         | 桌面主进程（扩展 `ManagedTunnel`）               | 无头也能用；密钥不出 server 进程                                                          |
| 设备清单同步               | 状态对账（清单没有就撤销）                                                     | 事件 / 墓碑                                      | 幂等，离线重启后也正确                                                                    |
| 会话授权                   | 手机会话 = 标准 scope 去掉 `access:write` 和 `relay:write`                     | 新增 scope / 新增会话方法                        | 不碰 contracts 的 scope 词表；`devices.invite/remove` 本来就要求 `access:write`           |
| 客户端接入                 | 装饰 `RemoteEnvironmentAuthorization`，按 environmentId 分派                   | 新增 profile 类型并改 resolver / routes / driver | 上游零行修改                                                                              |
| 浏览器                     | 不加入；继续用配对链接                                                         | 给浏览器发设备密钥                               | 没有强理由；浏览器存不住私钥，且用户明确要求保持不变                                      |

## 1. 架构总览

```
                      ┌────────────────────────── VPS（只开 80/443）──────────────────────────┐
                      │                                                                      │
 手机 / 电脑 ──HTTPS──▶│ Caddy ─ t3.example.com/v1/*        ──▶ registry :8080  (设备、邀请、清单)  │
                      │      ─ t3.example.com/~!frp (wss)  ──▶ frps :7000  ◀── 插件回调 ──┐     │
                      │      ─ *.t3.example.com            ──▶ frps :8080 (vhost)          │     │
                      │      ─ ntfy.t3.example.com         ──▶ ntfy :80                    │     │
                      │      ─ 证书 ask ──▶ registry :8082                  registry :8081 ┘     │
                      └──────────────────────────────────▲───────────────────────────────────┘
                                                         │ frpc（wss + metadatas 里的 ticket）
 电脑 A：桌面 app = 渲染进程 + 主进程 + server（持有设备密钥、托管 frpc、同步清单）
```

三类设备都只有"一把设备密钥"这一个长期身份：

| 角色            | 持有设备密钥的进程    | 能做什么                                                                     |
| --------------- | --------------------- | ---------------------------------------------------------------------------- |
| 电脑（computer）| 该电脑的 T3 server    | 邀请 / 移除 / 重命名设备；开隧道；用通行证登录别的电脑；校验别人的通行证    |
| 手机（phone）   | 手机 app（SecureStore）| 加入、看清单、用通行证登录电脑；**不能**邀请或移除（注册表直接拒绝）        |
| 浏览器          | 无                    | 不加入；继续用配对链接 + 一次性码（today's pairing links）                  |

"桌面 app"不是单独的设备：它的身份就是它自己的 server。桌面渲染进程去连别的电脑时，让本机 server 替它签通行证（第 3.6 节）。

### 1.1 为什么这样切分

- **注册表只管名单，不管会话。** 注册表进程本身不接触 T3 会话 token，也不签任何 T3 会话；会话由各台电脑自己签发。窃取注册表数据库只能得到公钥和邀请哈希（第 4 节）。同一台 VPS 上的 Caddy 终止 TLS，所以控制整台 VPS 的人既能读流量也能加钥匙，这是已接受的限度。
- **TLS 在 VPS 终止**（FORK.md 「自建连接」、`infra/self-host/README.md:15` 已经写明）：VPS 上的人能读到明文流量。本方案不改变这一点；两项加固放在第 9 节，用户已同意先记下。
- **每台电脑一个子域名。** `toHttpBaseUrl` 把 pathname 固定成 `/`，环境只能挂在 origin 根路径上（`packages/shared/src/remote.ts:108-119`，[已核实]，引自 `research/t3-connect-and-mobile-browser.md` A2），所以只能按子域名区分电脑，这也是用户要求 `*.t3.example.com` 的原因。

## 2. 决策记录（Q1–Q12）

每题给出权衡过的选项、推荐和理由，以及依据的现有代码。Q13（测试）、Q14（阶段）、Q15（威胁模型）分别放在第 7、5、4 节。

### Q1 密钥类型和格式；手机要不要复用 DPoP 密钥

| 选项                              | 优点                                                                                                  | 缺点                                                                                                              |
| --------------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **P-256 / ES256（推荐）**         | 仓库里生成、签名、验证、指纹全是现成的；iOS Secure Enclave、Android Keystore、WebCrypto 都保证支持     | 签名比 Ed25519 长 32 字节（对 JWT 无影响）                                                                        |
| Ed25519                           | 密钥短、签名确定                                                                                      | Secure Enclave 不支持；Android Keystore 和 WebCrypto 的支持要看版本 [推断]；要在 shared / mobile / server 新增代码路径 |
| 手机复用现有 DPoP 密钥            | 少一个 SecureStore 项                                                                                 | 见下                                                                                                              |
| **手机另建一把设备密钥（推荐）**  | 角色清晰；DPoP 密钥可以随意更换而不必重新注册；与电脑渲染进程用同一条协议路径（设备密钥 ≠ 会话密钥）  | 多一个 SecureStore 项                                                                                             |

推荐：**P-256；设备密钥与 DPoP 会话密钥分开；公钥用 JWK（`kty/crv/x/y`），设备 id = RFC 7638 指纹**（base64url(SHA-256(`{"crv","kty","x","y"}`))），签名用 JWS ES256 紧凑格式（r‖s）。

为什么分开：通行证里的 `cnf.jkt` 要指向"会话绑定到哪把 DPoP 密钥"。电脑的桌面渲染进程里，设备密钥在 server、DPoP 密钥在渲染进程，**本来就是两把**（Q3）；手机若复用，`cnf.jkt` 等于签名者自己，协议要为手机单开一条分支。统一成"永远两把"最简单。DPoP 密钥以后因为泄露嫌疑需要换，也不必去注册表重新登记。

依据：

- [已核实] 手机 DPoP：P-256 生成 `apps/mobile/src/features/cloud/dpop.ts:168-188`，存进 SecureStore（项名常量 `:89`，读写 `:193`、`:224`），`createDpopProof` 接受外部传入的 `proofKey`（`:238-248`）。
- [已核实] 指纹和验证：`packages/shared/src/dpop.ts:97-104`（`computeDpopJwkThumbprint`）、`:123-206`（`verifyDpopProof`，用 noble `p256.verify`，`format: "compact"`）。
- [已核实] server 的 DPoP 验证 + 重放标记：`apps/server/src/auth/dpop.ts:55-126`。
- [推断] 手机的 SecureStore 在 Android 上由 Keystore 包裹加密，但私钥字节在签名时会进入 JS 内存（noble 签名）。"系统钥匙串"的承诺因此是**静态加密**，不是"不可导出"。要做到不可导出需要原生模块（Android Keystore / iOS Secure Enclave 的 P-256 密钥），选 P-256 正是为了留这条升级路径。这一限度写进第 10 节。

### Q2 设备怎么向电脑证明自己；电脑返回什么

先读现状 [已核实]：

- `/oauth/token` 是 `application/x-www-form-urlencoded`，唯一的 grant 是 token-exchange，`subject_token` 是一次性配对码或 bootstrap 凭据（`packages/contracts/src/auth.ts:220-230`）；处理器在 `apps/server/src/auth/http.ts:352-413`：有 `DPoP` 头就先 `verifyRequestDpopProof`（`:365-381`），再调用 `exchangeBootstrapCredentialForAccessToken`（`:383`）。
- 兑换逻辑 `apps/server/src/auth/EnvironmentAuth.ts:955-1015`：带 `proofKeyThumbprint` 时签发 `method: "dpop-access-token"`、**1 小时**的会话（`:970-979`），否则是 30 天的 Bearer。
- 会话由 `SessionStore.issue` 签发：接受 `subject`、`scopes`、`client`（label、deviceType）、`proofKeyThumbprint`、`ttl`（`apps/server/src/auth/SessionStore.ts:377-388`、`:643-749`），落在已有的 `auth_sessions` 表里，`listActive()` 返回的每行带 `subject`（`:960-980`）。**不需要数据库迁移。**
- 重放：DPoP 证明的 `jti` 以 `dpop-proof-<hash>` 的文件标记存在 `secrets/`（`dpop.ts:100-124`），每小时清理一次一天前的标记（`replayMarkers.ts:22-67`）。
- 已连接的 socket 在会话到期时关闭，除非同一把 DPoP 密钥续期（`SessionStore.ts:412-416`、`:1043`，`latestSessionByProofKey` 在 `:504`、`:711`）。

| 选项                                         | 往返       | server 状态                  | 重放防护                         | 评价                                                                               |
| -------------------------------------------- | ---------- | ---------------------------- | -------------------------------- | ---------------------------------------------------------------------------------- |
| **A. JWT-bearer 通行证（推荐）**             | 1          | 无（只记 `jti`）             | `jti` 标记 + 短 `exp` + DPoP 双重绑定 | 蜂窝网络上少一次往返；与现有 DPoP 机制同构；依赖时钟（±120 秒）                    |
| B. 挑战-应答（server 发 nonce，设备签 nonce）| 2          | 要存挑战，并过期清理         | nonce 一次性                     | 不依赖时钟，但多一次往返和一类状态；时钟偏差问题 DPoP 现在已经容忍 300 秒          |

推荐 **A**。通行证（JWT）：

- 头：`{alg: "ES256", typ: "t3x-assertion+jwt", kid: <设备 id>}`。
- 载荷：`{v:1, iss, sub: <设备 id>, aud: <目标电脑的 environmentId>, rid: <registry id>, iat, exp (≤ iat+120), jti, cnf: {jkt: <会话绑定的 DPoP 指纹>}}`。
- 请求同时带 `DPoP` 头，由 `cnf.jkt` 对应的密钥签名；server 校验两者指纹一致。**偷到通行证也换不到会话**，除非同时拥有 DPoP 私钥。
- `aud` 用 environmentId 而不是 URL：同一份通行证在公网、局域网、Tailscale 任一路由上都有效，而且发给 A 的通行证不能拿去 B 重放。

端点：**fork 自己的路由 `POST /oauth/t3x-device`**，而不是给 `/oauth/token` 加第二种 grant。

| 选项                          | 上游改动                                                                                   | 评价                                  |
| ----------------------------- | ------------------------------------------------------------------------------------------ | ------------------------------------- |
| 扩展 `/oauth/token`           | `AuthTokenExchangeRequest` 变成联合体（contracts）、`http.ts` 处理器分派、HttpApi 描述符   | 每次上游改动都可能冲突                |
| **fork 路由（推荐）**         | 只在 `AuthAttemptLimiter.rejectedCodeStatus`（`:101-112`）加一个 `case`；路由在 `fork/` 里 | 上游零改动；线上格式沿用 RFC 7523 的 `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`、`assertion=`，响应是现成的 `AuthAccessTokenResult`（`auth.ts:232-238`），客户端可以复用现有的响应解码 |

路由挂载位置：[已核实] 路由层在 `apps/server/src/server.ts:771` 的 `layerMakeRoutes`，已有按功能分组的 `HttpRouter.add`（例如 `apps/server/src/guest/http.ts:140`、`:210`、`:232`）。

会话内容：

| 字段         | 值                                                                                                                                         |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `method`     | `dpop-access-token`（1 小时，沿用现有续期机制）                                                                                            |
| `subject`    | `t3x-device:<kind>:<设备 id>`（`kind` = `computer` / `phone`）                                                                             |
| `client.label` | 清单里的设备名（"Authorized clients" 里就显示这个名字）；`deviceType` = `mobile` / `desktop`                                              |
| `scopes`     | 电脑：`AuthStandardClientScopes`（`auth.ts:150-167`）。**手机：去掉 `access:write` 和 `relay:write`**                                      |
| 绑定         | `proofKeyThumbprint = cnf.jkt`                                                                                                             |

撤销：`listActive()` 里 `subject` 以 `t3x-device:` 开头且设备 id 不在清单里的会话，逐个 `SessionStore.revoke`（`:417`）。撤销会广播 `clientRemoved`，已连接的 socket 被关闭 [已核实：`docs/internals/connection-runtime.md` 经 `research/t3-connect-and-mobile-browser.md` A2 引用]；推送注册随会话一起删除 [已核实：FORK.md 「不依赖 Google 的推送」第 2 条]。

续期时每次都会产生一行新的会话，旧行到期消失，和 T3 Connect 现在的行为一致 [推断]。能不能用 `replaceActiveForSubjectAndMethod`（`SessionStore.ts:386`）把它压成每台设备一行，取决于续期时被替换的会话会不会让 socket 掉线（`awaitInvalidation` 的"同一把密钥续期则不关闭"逻辑，`:1043-1100`），列入 8.2 的验收项，不预先假定。

### Q3 桌面渲染进程连别的电脑

渲染进程没有设备密钥，所以让本机 server 代签。

| 选项                                                   | 评价                                                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| 把设备私钥交给主进程 / 渲染进程                        | 破坏"私钥不出 server"，渲染进程是网页代码                                                                      |
| 主进程经 IPC 向 server 要签名（像 `t3xSelfHostBridge`）| 要在主进程里另建一条到 server 的认证通道；无头模式没有这条路                                                   |
| **本机 server 的 RPC `devices.signAssertion`（推荐）** | 渲染进程已经和本机 server 有一条认证过的连接；无头也成立；授权在 server 里一处检查                             |

谁能要求签名（三条同时满足，任一不满足就拒绝）：

1. 调用者主体是 `desktop-bootstrap`。这是桌面主进程给自己的渲染进程发放的 bootstrap 会话的主体（`apps/server/src/auth/PairingGrantStore.ts:322-324`，签发会话时 `subject: grant.subject`，`EnvironmentAuth.ts:884-886`）。**已有同类先例**：`CloudLink.linkProof` 用 `principal.subject === "desktop-bootstrap"` 判断"本机 owner"（`apps/server/src/cloud/CloudLink.ts:634-648`）。配对链接来的浏览器会话拿不到这个主体，所以朋友的浏览器即使有 `access:write`，也不能借本机 server 去登录你的其他电脑。
2. 请求不带转发头（沿用 `hasForwardedAuthorityHeaders` 的检查，`CloudLink.ts:638`）。
3. 目标 `aud` 必须是清单里**另一台**电脑的 environmentId；`jkt` 必须是格式合法的指纹。

签名限速（每分钟 60 次）；日志只记设备 id、目标 environmentId 和 `jkt` 前 8 位。无头 server 没有渲染进程，不需要这条 RPC。

续期：渲染进程的会话 1 小时到期，`renewDpopBeforeExpiry`（`packages/client-runtime/src/connection/driver.ts:200-216`）会触发重新兑换，所以每小时向本机 server 要一张新通行证。

### Q4 各端的密钥存放；丢了怎么办

| 端                    | 位置                                                                                                                             | 丢失 / 损坏                                                                                                                                  |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 手机                  | `expo-secure-store` 的独立一项（`t3x-device-key-v1`，`WHEN_UNLOCKED_THIS_DEVICE_ONLY`）；不随云备份迁移                          | 卸载、清数据、换机 = **新设备**：用新邀请重新加入；旧条目在任一台电脑的 Devices 里显示"很久没出现"，手动移除                                  |
| 桌面渲染进程          | **没有设备密钥**；只有现有的 DPoP 会话密钥                                                                                       | 不影响设备身份                                                                                                                               |
| 电脑的 server         | `ServerSecretStore`，名字 `fork-device-key`，0600 文件、0700 目录、原子写入（和推送注册同一个模式，`apps/server/src/fork/push/PushRegistrations.ts:22-27`） | 删了 state 目录 = 新设备；membership 文档一起没了，界面回到"未加入"；旧条目到别的电脑上移除。**state 目录整份拷到另一台机器 = 两台机器共用一把钥匙**，不支持，隧道登录会互相顶掉 |
| 备份 / 导出           | **不提供**                                                                                                                       | 与 `authorized_keys` 的心智一致：丢了就换一把                                                                                                |

macOS 上把私钥放进 Keychain 的"更强"方案被否决：fork 刚刚因为 Keychain 授权弹窗卡住主线程吃过亏（FORK.md 「打包与签名」），而且无头 server 没有 Keychain。

### Q5 VPS 上的注册表

**运行时。** 选项：Node（`node:sqlite`）、Go 单文件、Python 标准库、带 npm 依赖的 Node。选 **Node 24 + 内置模块**：`node:http`、`node:crypto`（ES256 / P-256 / SHA-256 / `timingSafeEqual` 全齐）、`node:sqlite`（`DatabaseSync`；Node 22.13 起不需要实验开关，24 的官方镜像直接可用 [待验证]）。VPS 上的构建只靠 `infra/self-host/registry/Dockerfile`（`FROM node:24-alpine`，`COPY *.mjs`，无 `npm install`）。测试和 server 同一门语言，密码学语义（JWS、指纹）可以做交叉向量测试。

**存储（SQLite，WAL，卷 `/data/registry.db`）**，`CREATE TABLE IF NOT EXISTS` 加 `PRAGMA user_version` 做自己的版本管理（上游不涉及，这是 VPS 上的独立服务，不是 T3 数据库）：

| 表         | 列                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `meta`     | `registry_id`（首次启动随机）、`rev`（整数，任何清单变化 +1）                                                                              |
| `devices`  | `id`（指纹，主键）、`name`、`name_key`（小写，唯一）、`kind`、`jwk`、`subdomain`（电脑才有，唯一）、`environment_id`、`created_at`、`last_seen_at`、`last_tunnel_at`、`invited_by` |
| `invites`  | `id`、`secret_hash`（SHA-256）、`kind`（`computer` / `phone` / `any`）、`created_by`（设备 id 或 `cli`）、`expires_at`、`used_at`、`used_by` |
| `seen_jti` | `(device_id, jti)`、`exp`；超过窗口就清                                                                                                    |

移除设备 = 删行 + `rev+1`（不留墓碑，对账是"状态差"，见 Q8）。

**API**（全部 JSON，经 Caddy 挂在 `https://<域名>/v1/`；细节见第 3.3 节）：`GET /v1/info`（公开）、`POST /v1/join`、`GET /v1/devices`、`POST /v1/invites`、`GET /v1/invites`、`DELETE /v1/invites/{id}`、`DELETE /v1/devices/{id}`、`PATCH /v1/devices/{id}`（改名）。

**请求认证。** DPoP 式，但用自己的 `typ`：`T3X-Proof: <JWS>`，载荷 `{htm, htu, iat, jti, bh}`，`htu` 是**含查询串的完整 URL**（由注册表按自己配置的公网源重建，不信 `Host` 头），`bh` 是请求体的 SHA-256。不直接复用 DPoP 证明，是因为 `normalizeDpopHtu` 会丢掉查询串，而且 DPoP 不覆盖请求体（`packages/contracts/src/auth.ts:247-252` 的注释说明了 `htu` 不含查询串）。时间窗 ±120 秒，`(device_id, jti)` 防重放。

**限速。** Caddy 在最前面，XFF 取 Caddy 写入的那一跳。`/v1/join` 失败 10 次 / 10 分钟 / IP；已认证请求 120 次 / 分钟 / 设备；创建邀请 10 次 / 小时 / 设备；未使用的邀请最多 20 个。

**`./t3x`。** 一个 bash 脚本，等价于 `docker compose exec registry node /app/cli.mjs "$@"`；CLI 与 HTTP 处理器共用同一个模块，直接操作数据库（root 权限即管理权限，不走签名）。命令：`invite [--kind computer|phone|any]`、`devices`、`revoke <名字|id>`、`invites`、`rename <名字> <新名字>`、`ntfy`、`info`。邀请命令输出字符串和终端二维码；二维码编码器直接复制 `packages/shared/src/qrCode.ts`（Project Nayuki，MIT，726 行，已 vendored，保留许可头），用一个测试保证两份输出一致。

### Q6 隧道

先读现状 [已核实]：`infra/self-host/frps.toml:1-14` 是 token 认证 + TLS 强制 + 只允许 `remotePort = 7001`；`docker-compose.yml:13-24` 发布 7000；`Caddyfile:6-19` 把整个域名反代到 `frps:7001`。frp 镜像钉在 `fatedier/frps:v0.61.1`（`docker-compose.yml:13`），部署包文档说"frpc 0.70.0 + frps 0.61.1 实测互通"。

| 方面             | 选项                                                       | 选择                                                                                       |
| ---------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 控制通道经 443   | frpc `transport.protocol = "wss"` → Caddy → frps           | **wss**：文档写明 wss 时外层 TLS 一直开启，校验对象是 TLS 端点（可以是反向代理）[已核实：frp README、`client/connector.go`] |
| 数据面           | HTTP vhost（`subDomainHost` + `subdomain`）／每电脑一个 TCP 端口 | **HTTP vhost**：只开 443；`subDomainHost` 文档明确支持通配 DNS [已核实：frp README]          |
| 怎么检查登录     | `auth.method = "token"` 共享令牌／OIDC／服务端插件         | **服务端插件**（`httpPlugins`，`ops = ["Login","NewProxy","Ping","NewWorkConn"]`）[已核实：`doc/server_plugin.md`] |

**登录凭据和重连。** 服务端插件的 `Login` 请求带 `metas`（来自 frpc 的 `metadatas.*`），`Ping` / `NewProxy` 里在 `user.metas` [已核实：`doc/server_plugin.md` "Metadata"]。方案：

1. server 在每次启动 frpc 时生成配置，`metadatas.t3x_ticket` = 电脑自己用设备密钥签的 ticket：`{v:1, kid: 设备 id, sub: 子域名, iat, exp: iat+24h}`，`user = <设备 id 前 16 位>`。
2. 注册表的 `Login` 插件验证签名（用库里的公钥）、`exp`、设备仍在名单里；通过后记下 `run_id → 设备 id`。
3. frpc 自动重连时用的是同一份配置，所以 **ticket 的有效期必须覆盖重连**：24 小时。server 每 12 小时（或检测到输出里出现登录失败）重新生成配置并重启 frpc，重启代价是隧道断约一秒，T3 客户端自带重连。
4. frpc 在首次登录成功之后遇到登录失败，会一直重试而不是退出 [推断，frp 客户端行为]，所以"检测输出里的登录失败并重启"是必须的，不是优化。

备选（8.0 验证后再定要不要采用）：frp 的 OIDC 模式让 frpc 每次登录向一个 `tokenEndpointURL` 取新令牌 [已核实：README "OIDC Authentication"，frpc 配置项 `auth.oidc.clientID / clientSecret / audience / tokenEndpointURL`]。可以把 `tokenEndpointURL` 指向 server 在 `127.0.0.1` 上的一个本地端点，每次登录现签一张 5 分钟的令牌，彻底不需要重启。但 frps 的 OIDC 校验要求一个能做 OIDC 发现的 issuer，库的签名算法限制我没有核实（[推断] 只认 RS256）。登录令牌出现在 `privilege_key` 里也是 [推断]。风险大于收益，先不做。

**移除一台电脑 / 已连接的怎么办。**

- `Login` 与 `NewProxy`：设备不在名单里就拒绝。
- `Ping`（心跳）：设备已被移除就返回拒绝；frpc 收到带错误的 Pong 会关闭会话并重连，重连的 `Login` 被拒 [推断：frp 客户端对 Pong 错误的处理；服务端 Ping 插件 op 文档已核实]。`NewWorkConn` 同样拒绝，即使控制连接还在，也拿不到数据通道。
- **关键陷阱** [已核实]：frpc 开启 TCPMux（默认开）时，应用层心跳默认值是 **-1，即关闭**（`pkg/config/v1/client.go`：`HeartbeatInterval` / `HeartbeatTimeout` 在 TCPMux 打开时默认 -1）。不显式设置，`Ping` 插件永远不会被调用。生成的 frpc 配置必须写 `transport.heartbeatInterval = 30`、`transport.heartbeatTimeout = 90`；frps 侧的 `transport.heartbeatTimeout` 要同步。这是"下次心跳被踢"承诺能否成立的前提，列入 8.0。

`NewProxy` 的约束（插件逐项检查）：`proxy_type == "http"`；`subdomain` 必须等于该设备注册的子域名；`custom_domains`、`locations`、`http_user` 必须为空；每台设备同时只有一个代理；`user` 必须等于设备 id 前 16 位。所以电脑 A 无法为电脑 B 的子域名注册代理（威胁表第 7 行）。

**Caddy。**

```
{
	email {$ACME_EMAIL}
	on_demand_tls { ask http://registry:8082/ask }
}
{$T3X_DOMAIN} {
	@frp path /~!frp
	handle @frp { reverse_proxy frps:7000 }
	handle /v1/* { reverse_proxy registry:8080 }
	handle { respond 404 }
}
ntfy.{$T3X_DOMAIN} { reverse_proxy ntfy:80 { flush_interval -1 } }
https:// {
	tls { on_demand }
	reverse_proxy frps:8080 {
		flush_interval -1
		stream_close_delay 5m
		header_up X-T3x-Client-IP {remote_host}
	}
}
```

- 证书只给注册过的电脑：`ask` 端点（`registry:8082/ask?domain=…`）只对 `<已登记子域名>.<域名>` 返回 200，其余一律 403 [已核实：Caddy 文档，2xx 授权，其他状态码取消签发并让握手报错，`ask` 只能做常数时间的数据库查询]。`ntfy.` 和根域名是显式站点，Caddy 自己申请证书，不走 `ask`。
- 首次访问某台电脑时要现场申请证书，要几秒。注册表在电脑加入成功后，自己向 Caddy 发一次带该 SNI 的请求，提前触发签发（8.1 验收项）。
- Let's Encrypt 有频率限制（同一注册域名每周 50 张），个人使用不会触及；README 里写一句。
- frps 与 Caddy 之间是 compose 内网上的明文 ws / http（宿主机端口都不发布）；`transport.tls.force` 必须去掉，否则 frps 会拒绝 Caddy 转来的非 TLS 控制连接 [待验证]。
- **XFF 陷阱** [推断]：HTTP vhost 比 TCP 代理多一层反向代理，frps 可能再往 `X-Forwarded-For` 追加一跳（Caddy 的容器地址）。`AuthAttemptLimiter.clientKey` 取**最右一项**（`apps/server/src/auth/AuthAttemptLimiter.ts:125-139`），那就变成所有人共用同一个桶，一个人失败 20 次就锁住全体。Caddy 因此额外写 `X-T3x-Client-IP`；若 8.0 证实 frps 会追加，`clientKey` 优先读这个头（仅当请求来自 loopback，即 frpc）。

### Q7 frpc 在哪里运行，怎么分发

| 选项                                          | 评价                                                                                                                           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 桌面主进程（扩展 `ManagedTunnel`）            | `ManagedTunnel` 现成（退避、进程组清理、输出分类，`apps/desktop/src/selfHost/ManagedTunnel.ts:60-63`）；但无头 `t3x` 用不了，ticket 必须由 server 签，要跨进程传 |
| **server 托管（推荐）**                       | 无头和桌面同一份代码；签名在进程内；先例：server 已经托管 `cloudflared`（`apps/server/src/cloud/ManagedEndpointRuntime.ts`，崩溃退避和日志分类，经 `research/t3-connect-and-mobile-browser.md` A4 引用）[推断：未重读该文件] |

推荐 server 托管：`fork/deviceKeys/DeviceTunnel.ts` 用 Effect 的 `ChildProcessSpawner` 起 frpc（配置写进 `<stateDir>/fork-tunnel/frpc.toml`，0600，不放在命令行里），退避 1→60 秒、稳定 30 秒后复位（沿用 `restartDelayMs` 的数字），`Scope` 关闭就杀进程。桌面 app 退出时 server 随之退出，frpc 随之停止，"随 app 启停"成立。`ManagedTunnel` 一行不改，继续服务 Advanced 里的"自定义隧道命令"。

**打包。** 钉死 **frp 0.61.1**（与 compose 里的 frps 同版本，少一个变量；README 里"0.70.0 客户端"的组合保留为已验证的备选）：

- 版本、各平台归档 URL 和 SHA-256 写在一个 fork 文件（`packages/shared/src/forkFrp.ts`）；测试读取 `infra/self-host/docker-compose.yml` 保证版本一致。
- `scripts/fork-dist-mac.ts`（fork 自己的脚本）在 `build-desktop-artifact.ts --target dir` 之后、`@electron/osx-sign` 之前，下载归档、核对 SHA-256、把 `frpc` 放进 `.app/Contents/Resources/bin/`。FORK.md 描述的流水线本来就由内向外签名所有嵌套二进制，并逐个用 `file` 找出 Mach-O 校验（FORK.md 「打包与签名」第 2、3 条），frpc 自动被覆盖；hardened runtime 下 Go 二进制不需要额外 entitlement [推断]，由签名后的 `codesign --verify` 把关。
- 桌面后端配置通过环境变量 `T3X_FRPC_PATH` 告诉 server 去哪找（`apps/desktop/src/backend/DesktopBackendConfiguration.ts`，上游文件，一行 `// fork:`）。
- 无头：按顺序找 `T3X_FRPC_PATH` → `<T3 home>/bin/frpc` → PATH；`t3x devices tunnel install` 从同一张表下载并校验后放进 `<T3 home>/bin/`。

### Q8 电脑上的设备清单同步

| 项           | 决定                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 间隔         | 启动后立即一次，之后每 60 秒（`Schedule.spaced`），外加 RPC `devices.refresh` 立即同步一次。请求带 `If-None-Match: "<rev>"`，没变化时 304，几乎零流量                       |
| 持久化       | `ServerSecretStore` 文档 `fork-device-list`：`{rev, fetchedAt, devices[]}`，原子写入；不建 SQL 表，所以**不需要数据库迁移，也不需要照搬 `ensureImportTables` 的建表模式**（那个模式在 `apps/server/src/fork/SharedWorktrees.ts:166-186`，是 fork 往 T3 数据库里加表的做法；本功能的数据量只有几十行，文档更简单，且与推送注册一致） |
| 离线         | 取失败就保留上一份清单并标记 `stale`（界面显示"上次同步 3 小时前"）。清单里的设备仍然可以登录（局域网照常）；离线期间被移除的设备，要等下一次同步成功才会被撤销。**默认不设"离线太久就拒绝"**，列入第 10 节让主控确认 |
| 撤销         | 每次同步成功后做一次**状态对账**：`listActive()` 中 `subject` 以 `t3x-device:` 开头、设备 id 不在新清单里的会话，全部撤销。状态对账是幂等的，离线期间被移除、server 重启之后第一次同步也正确                    |
| 自己被移除   | 清单里没有自己的 id，或注册表返回 `device_revoked`：停隧道、删除 membership 和密钥、撤销所有 `t3x-device:*` 会话，界面显示"这台电脑已被移出服务器"，状态回到"未加入"      |

### Q9 邀请和子域名

**邀请字符串**：`t3x1.` + base64url(UTF-8 JSON)，约 200 字符：

```json
{"v":1,"o":"https://t3.example.com","r":"<registry id, 8 字符>","i":"<邀请 id, 11 字符>","s":"<密钥, 22 字符=128 位>","k":"c|p|a","e":1793000000}
```

- `k` 是邀请预期的设备类型（`c` 电脑、`p` 手机、`a` 任意）；注册表在兑换时强制检查，客户端也用它在界面上提示"这是给手机的邀请"。`e` 只用于客户端提前拒绝，权威过期时间在注册表。
- 注册表只存 `SHA-256(密钥)`。一次一设备、单次使用、15 分钟有效。
- 二维码里就是这同一个字符串（版本 10 左右，QR 约 57×57，终端用半块字符 29 行）。手机应用内扫码；系统相机扫到只是一段文字，不会唤起任何东西，所以**不注册新的 URL scheme**（共存保证不受影响）。以后要做深链，用 `FORK.scheme` 加 `join?invite=`。
- 输入位置：桌面 Settings → "Join my server" 的粘贴框；手机的"加入服务器"页的相机和粘贴框；无头 `t3x devices join <邀请>`。**不需要手敲**。

**子域名**（只给电脑）：

1. 从设备名派生：NFC 规范化 → 转小写 → 非 `[a-z0-9]` 全部换成 `-` → 合并重复的 `-` → 去掉首尾 `-` → 最长 30 字符。
2. 结果为空（例如全是汉字）→ `computer-<4 位随机 base32>`。
3. 保留名：`ntfy`、`www`、`api`、`registry`、`frp`、`admin`、`mail`、`t3x`、`_*`，以及以 `xn--` 开头的名字。
4. 与已有子域名冲突 → 追加 `-2`、`-3`…
5. **分配后不再变**（改名只改显示名）；移除设备后释放名字。名字被别的电脑重用时，手机先拉 `/.well-known/t3/environment` 校验 environmentId 再发凭据（`verifyDirectEndpoint`，`packages/client-runtime/src/authorization/service.ts:141-158`），不会把凭据发给错的机器。

### Q10 客户端发现和保存

**保存方式** [已核实 + 推断]：

- 注册方式：`EnvironmentRegistry.register(BearerConnectionRegistration)`（`packages/client-runtime/src/connection/registry.ts:107-110`），profile 里 `authorization: "t3-connect"`。`resolver.ts:148-154` 看到这个标记就调用 `remote.authorizeDpop`，**在读取凭据之前**就返回，所以注册时的 `credential` 只是占位（空令牌）。`routes.ts:223`、`:343`、`:425` 对这个标记的处理（学习路由共用 DPoP、不判定明文泄露、移除时的级联）正好是我们要的语义。全库只有这几处引用该字面量 [已核实：grep]。
- 缺口：`RemoteEnvironmentAuthorization` 的真实实现（`authorization/service.ts:289-342`）绑定 T3 Connect 的云会话（`assertSession`、`obtainBootstrap`）。**装饰它**：fork 提供 `withDeviceKeyAuthorization(base)`，对已登记为"设备环境"的 environmentId 走通行证流程，其余原样委托。`authorizeDpop`、`authorizeDpopHttp`（`state/environmentHttpAuth.ts:145-165`）、`renewDpopBeforeExpiry`（`driver.ts:200-216`）三个入口都通过这个服务，所以上游文件不需要改，只需要在两个客户端各一处把装饰后的 layer 提供出去 [推断：layer 的组装点在 `apps/web/src/connection/runtime.ts` 和 `apps/mobile/src/connection/runtime`，没有逐行读]。
- 替代：新增 `authorization: "t3x-device"` 字面量，要改 `catalog.ts:26`、`routes.ts` 三处、`resolver.ts:148`，共约 5 处上游改动，语义更清楚但每次合并上游都可能冲突。**推荐复用 `"t3-connect"` 标记 + 装饰层**，并在装饰层写一行注释说明为什么。

**列出电脑与获得会话：**

| 端               | 数据来源                                                         | 刷新时机                                                                                              |
| ---------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| 手机             | 直接向注册表 `GET /v1/devices`（带 `If-None-Match`）             | App 回到前台（距上次 ≥30 秒）、设备页手动下拉、刚加入之后；不做后台定时轮询                           |
| 桌面渲染进程     | 本机 server 的 RPC 流 `devices.subscribe`（先给快照，之后只在清单变化时推送）[推断：流式 RPC 在契约里已有大量先例] | 订阅期间无轮询；server 自己每 60 秒同步一次                                                           |
| 无头 / CLI       | `t3x devices list`                                               | 按需                                                                                                  |

**同步到连接注册表**：对每台电脑，清单里有、本地没有 → `register`（公网路由 `https://<子域名>.<域名>`，env id 取清单里的 `environment_id`）；清单里没有、本地有（并且在"设备管理的环境"索引里）→ `registry.remove(environmentId)`（`registry.ts:121`）；URL 变了 → 替换路由。"设备管理的环境"索引存在每个客户端本地（web：localStorage 的 fork store；手机：AsyncStorage），只有索引里的环境会被同步删除，用户自己手动添加的环境绝不会被动。

**局域网**：连上公网路由后，电脑上报的 LAN / tailnet 地址由 `mergeLearnedRoutes` 作为学习路由加进来（`routes.ts:206-`），排序优先于 public（`ROUTE_KIND_RANK`，`routes.ts:105`），回到家自动切回局域网 [已核实：FORK.md 「自建连接」第 236 行描述的就是这个逻辑]。学习路由复用 `"t3-connect"` 的 DPoP 语义，所以通行证在局域网路由上同样有效（`aud` 是 environmentId，不是 URL）。

### Q11 UI（概述，细节见第 3.9 节和 8.4 的验收）

- **桌面**：Settings → Sharing & access 里新增 "Devices" 区，位置在原来 `SelfHostSettings` 的位置（`apps/web/src/components/settings/ConnectionsSettings.tsx` 里把那一处渲染换成 `DevicesSettings`，由它在 "Advanced" 折叠区里渲染 `SelfHostSettings`，只改一行）。
  - 未加入：说明一句 + "Join my server" 按钮 → 对话框（电脑名、邀请粘贴框）。
  - 已加入：顶部一行"已连接 t3.example.com · 这台电脑：`https://mac.t3.example.com`（在线 / 离线）"；设备清单（名称、种类、最近出现的相对时间、移除按钮）；"Invite a device" 按钮 → 对话框显示二维码 + 字符串 + 复制 + "有效至 14:32"（**绝对时间，不做每秒走字的倒计时**）；邀请列表里有"取消"。
  - Advanced（折叠）：原来的"自定义公网地址 + 隧道命令"。
  - 只在 server 声明 `capabilities.deviceKeys` 时渲染；加入 / 离开只给本机 owner（`desktop-bootstrap`）显示，因为 server 在这两个 RPC 里也做同样的检查。
- **手机**：Settings 里一个 "Server devices" 入口，两个页面：加入页（相机扫描 + 粘贴 + 设备名）、设备清单页（只读列表、最近出现、"离开此服务器"）。环境列表里托管的环境显示"由你的服务器管理"，移除入口换成"离开此服务器"，避免用户删了又被同步回来。
- **组件**：只用 `apps/web/src/components/ui` 现有的 Button、Dialog、已有的 `qr-code.tsx`（`apps/web/src/components/ui/qr-code.tsx`，研究文档 A3 已核实）；不用 `className` 重新着色。
- **多语言**：新建 `catalogs/zh-Hans/devices.ts`（web）和 mobile 对应文件；验收按用户的审美记忆——中文字不要显得过大、界面要有层次、守住上游风格，**中英文对照截图**。

### Q12 现有 fork 代码怎么处理

| 现有代码                                                     | 变化                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/environment/PublicUrls.ts`                  | **保留**，服务 Advanced 的自定义地址。新增：`list` 再读一个由设备 membership 写入的小文件 `device-public-url.json`（同目录，原子写入，每次调用重新读），这样电脑自己的 `https://<子域>.<域名>` 也作为 `public` 端点上报，已用配对链接配对的浏览器 / 设备也能学到。不引入 layer 依赖 |
| `apps/server/src/environment/DirectEndpoints.ts:167-169`     | **不变**                                                                                                                                                                                                                                                        |
| `apps/desktop/src/selfHost/DesktopSelfHost.ts`               | **保留**，界面挪进 Advanced。生成配对二维码时要能选到设备地址：`serverExposure.getAdvertisedEndpoints` 追加的是 `DesktopSelfHost.publicUrls`，需要让它也包含设备地址（读同一个文件，路径是否与 server 的 state 目录一致要在 8.4 核对）[推断]                    |
| `apps/desktop/src/selfHost/ManagedTunnel.ts`                 | **不变**，继续只管 Advanced 里用户自己写的隧道命令。与 `DeviceTunnel` 同时存在不冲突（不同 frpc 实例、不同代理名），界面在两者都开时提示一句                                                                                                                     |
| `apps/server/src/auth/AuthAttemptLimiter.ts:101-112`         | `rejectedCodeStatus` 加一个 `case "/oauth/t3x-device": return 401`（带 `// fork:`）。若 8.0 证实 vhost 会追加 XFF，`clientKey` 再优先读 `X-T3x-Client-IP`（见 Q6）                                                                                               |
| 推送注册（`apps/server/src/fork/push/`）                     | **不变**。注册以会话 id 为键，设备会话与之天然兼容；撤销设备会话时服务端自己删除注册（FORK.md 已写明）。手机通过各电脑的 `push.register` 注册，共用同一个 endpoint                                                                                              |
| ntfy                                                         | **并入同一套 compose**：`ntfy.<域名>` 在通配 DNS 之内，不再需要单独的 A 记录。`setup.sh` **默认安装**，`--no-ntfy` 关闭。它创建只读 `up*` 的 `phone` 账号，随机密码写进 `secrets/ntfy-phone.txt`（0600）并打印一次，`./t3x ntfy` 可以再次显示。SSRF 限制（只向公网地址推送）不变 |

## 3. 协议规格

约定：所有 JSON 的时间是 Unix 秒（整数）；`b64u` = 无填充 base64url；所有 JWS 都是 `b64u(header).b64u(payload).b64u(sig)`，签名是 ES256 的 r‖s（64 字节），签名输入是 `SHA-256(b64u(header) + "." + b64u(payload))`，与 `packages/shared/src/dpop.ts:174-183` 一致，所以现有的 P-256 实现可以直接复用。

### 3.1 密钥与标识

| 项           | 格式                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------- |
| 设备公钥     | JWK：`{"kty":"EC","crv":"P-256","x":b64u,"y":b64u}`，只接受这四个字段                                 |
| 设备 id      | `b64u(SHA-256({"crv":…,"kty":…,"x":…,"y":…}))`（字段顺序固定，RFC 7638），43 字符；同 `computeDpopJwkThumbprint` |
| 设备种类     | `computer`（电脑）／`phone`（手机）                                                                    |
| 显示名       | NFC，1–40 字符，无控制字符；在未移除的设备里大小写不敏感唯一，冲突自动加 ` (2)`                       |
| registry id  | 注册表首次启动时的 8 字符随机 base32；写进邀请、通行证的 `rid`、电脑的 membership，防止"同名但其实是另一个注册表" |

### 3.2 邀请

| 字段 | 含义                                   | 长度 / 取值                      |
| ---- | -------------------------------------- | -------------------------------- |
| `v`  | 版本                                   | `1`；未知版本客户端提示"请更新应用" |
| `o`  | 注册表公网源（`https://host[:port]`，无路径） | ≤ 80                           |
| `r`  | registry id                            | 8                                |
| `i`  | 邀请 id                                | 11（64 位随机）                  |
| `s`  | 邀请密钥                               | 22（128 位随机）                 |
| `k`  | 预期设备类型                           | `c` / `p` / `a`                  |
| `e`  | 过期时间（仅供客户端提前判断）         | Unix 秒，创建后 15 分钟          |

字符串 = `"t3x1." + b64u(JSON)`。兑换时发 `i.s`，注册表比较 `SHA-256(s)`（`timingSafeEqual`），在一个 `BEGIN IMMEDIATE` 事务里同时检查未过期、未使用、种类匹配，并把邀请标记为已使用——所以并发兑换只有一个赢家。

### 3.3 注册表 API

基址 `https://<域名>[:端口]/v1`。"签名"= 带有效的 `T3X-Proof`（3.4），"电脑"= 签名者的设备种类必须是 `computer`。

| 方法与路径                  | 认证                | 请求                                                           | 成功响应                                                                                                        | 主要错误（`error`）                                                                                 |
| --------------------------- | ------------------- | -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `GET /info`                 | 无                  | –                                                              | `{apiVersion:1, registryId, domain, publicPort}`                                                                 | –                                                                                                   |
| `POST /join`                | 邀请 + 自签名（PoP）| `{invite:"i.s", device:{name, kind, jwk, environmentId?}}`     | `{registryId, deviceId, name, subdomain?, url?, rev}`                                                             | `invite_invalid` / `invite_expired` / `invite_used` / `kind_mismatch` / `name_invalid` / `rate_limited` |
| `GET /devices`              | 签名（任意设备）    | `If-None-Match: "<rev>"`                                       | `200 {rev, devices:[{id, name, kind, jwk, subdomain?, url?, environmentId?, createdAt, lastSeenAt, online?}]}` 或 `304` | `device_unknown`（被移除）                                                                          |
| `POST /invites`             | 签名 + 电脑         | `{kind:"computer"｜"phone"}`                                   | `{id, invite:"t3x1.…", expiresAt}`                                                                                | `too_many_invites` / `rate_limited`                                                                 |
| `GET /invites`              | 签名 + 电脑         | –                                                              | `{invites:[{id, kind, createdBy, expiresAt}]}`（未使用且未过期的）                                                | –                                                                                                   |
| `DELETE /invites/{id}`      | 签名 + 电脑         | –                                                              | `204`                                                                                                             | `not_found`                                                                                         |
| `DELETE /devices/{id}`      | 签名 + 电脑         | –                                                              | `204`；可删除自己（= 离开）                                                                                       | `not_found` / `forbidden`（手机调用）                                                               |
| `PATCH /devices/{id}`       | 签名；手机只能改自己，电脑可改任何 | `{name}`（只改显示名，不改子域名）                  | `{id, name}`                                                                                                      | `name_invalid` / `name_taken` / `forbidden`                                                         |
| `PATCH /devices/self`       | 签名                | `{environmentId}`（电脑重新报告环境 id）                       | `{rev}`                                                                                                           | –                                                                                                   |

- `GET /devices` 同时刷新签名者的 `last_seen_at`。电脑的 `online` 由 frps 插件的 `Login`/`Ping` 更新（30 秒一次，批量写盘，不是每次心跳一次 fsync）。
- 清单里包含**所有**设备的公钥（电脑要用它验通行证）；手机也能看到，公钥不是秘密。
- 错误格式 `{error, error_description}`，状态码 400 / 401 / 403 / 404 / 409 / 429。

内部端口（不经 Caddy，只在 compose 网络里）：`:8081/frps` 是 frps 插件回调，`:8082/ask` 是 Caddy 证书询问。

### 3.4 请求签名 `T3X-Proof`

JWS：头 `{alg:"ES256", typ:"t3x-req+jwt", kid:<设备 id>}`（`/join` 里改为 `jwk:<公钥>`，用来证明持有对应私钥）；载荷：

| 字段  | 内容                                                                                                    |
| ----- | ------------------------------------------------------------------------------------------------------- |
| `htm` | HTTP 方法，大写                                                                                         |
| `htu` | 完整 URL（含查询串；协议和主机小写；默认端口省略）。注册表自己用配置里的公网源 + 实际路径重建比对，不读 `Host` 头 |
| `iat` | 签发时间，与注册表时钟差 ≤ 120 秒                                                                       |
| `jti` | 128 位随机；注册表记 `(设备 id, jti)` 到 `exp = iat + 240`，之后清理                                    |
| `bh`  | 请求体的 `b64u(SHA-256(body))`；没有请求体时省略                                                        |

校验顺序：解码 → 查设备（`/join` 例外）→ 验签 → 方法与 URL → 时间窗 → `bh` → 插入 `jti`（唯一约束冲突 = 重放）。一次失败不暴露是哪一步：统一 `401 invalid_proof`，具体原因只写进注册表日志。

### 3.5 通行证和令牌端点

`POST /oauth/t3x-device`（电脑的 server 上，表单编码）：

| 项           | 内容                                                                                                                                  |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
| 请求头       | `DPoP: <proof>`（必须，由 `cnf.jkt` 对应的密钥签名；htm=`POST`，htu=本请求 URL）                                                      |
| 请求体       | `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`、`assertion=<通行证>`、`scope=<可选，取交集>`                                |
| 通行证头     | `{alg:"ES256", typ:"t3x-assertion+jwt", kid:<设备 id>}`                                                                               |
| 通行证载荷   | `{v:1, iss:<设备 id>, sub:<设备 id>, aud:<目标 environmentId>, rid:<registry id>, iat, exp, jti, cnf:{jkt}}`，`exp - iat ≤ 120`        |
| 成功响应     | 与 `/oauth/token` 的 `AuthAccessTokenResult` 相同：`{access_token, issued_token_type, token_type:"DPoP", expires_in:3600, scope}`     |
| 失败响应     | `401 {error:"invalid_grant", error_description, t3x_reason}`；`t3x_reason` 取 `device_unknown`、`device_revoked`、`audience_mismatch`、`registry_mismatch`、`expired`、`time_window`、`replay`、`key_mismatch`、`list_unavailable` |

server 校验顺序（失败即停；通行证自己的 `jti` 最后才消耗）：

1. 解码与 `typ/alg`；`kid` 在缓存的清单里（没有清单则 `list_unavailable`；清单里没有则 `device_unknown`）。
2. 用清单里的公钥验签；`iss == sub == kid`。
3. `aud` = 本环境 id；`rid` = membership 里的 registry id。
4. `|now - iat| ≤ 120` 且 `now < exp`。
5. `verifyRequestDpopProof({ request, expectedThumbprint: cnf.jkt })`（已有函数，`apps/server/src/auth/dpop.ts:55`，它自己也消耗 DPoP 的 `jti`）。
6. 在 `secrets/` 里 `create("t3x-assertion-<hash(kid:jti)>")`，已存在即 `replay`。前缀要加进 `REPLAY_MARKER_PREFIXES`（`apps/server/src/auth/replayMarkers.ts:15`，一行 `// fork:`），否则标记永远不会被清理。
7. `SessionStore.issue(...)`，参数见 Q2。

通行证每次兑换现签、绝不缓存；客户端只缓存兑换回来的会话令牌（`expiresAt - 60 秒` 时续期，沿用 `DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS`，`connection/model.ts:113`）。

### 3.6 桌面渲染进程代签

RPC `devices.signAssertion`（server，本机 owner 专用，见 Q3 的三个条件）：

| 方向 | 内容                                                                                         |
| ---- | -------------------------------------------------------------------------------------------- |
| 请求 | `{audienceEnvironmentId, dpopThumbprint}`                                                    |
| 响应 | `{assertion: <通行证 JWS>, expiresAt}`（`exp = iat + 60`）                                   |
| 错误 | `NotLocalOwner`、`UnknownAudience`、`NotJoined`、`RateLimited`                               |

渲染进程拿到后立刻向目标电脑 `POST /oauth/t3x-device`（用它自己的 DPoP 密钥签 DPoP 头）。这张通行证的 `iss` 是**本机电脑的设备 id**，所以目标电脑会话的 `subject` = `t3x-device:computer:<本机设备 id>`，"Authorized clients" 里显示本机电脑的名字。

### 3.7 隧道

**frpc 配置**（server 每次启动 frpc 时生成，`<stateDir>/fork-tunnel/frpc.toml`，0600）：

```toml
serverAddr = "t3.example.com"
serverPort = 443
user = "<设备 id 前 16 位>"
loginFailExit = false
metadatas.t3x_ticket = "<ticket>"

transport.protocol = "wss"
transport.heartbeatInterval = 30
transport.heartbeatTimeout = 90

[[proxies]]
name = "t3x"
type = "http"
localIP = "127.0.0.1"
localPort = <server 实际监听端口>
subdomain = "<子域名>"
```

测试时再加 `transport.tls.serverName` 和 `transport.tls.trustedCaFile`，生产环境不写（生产用系统 CA）。`transport.protocol = "wss"` 时外层 TLS 一直开启并校验 [已核实]。

**ticket**：JWS `{alg:"ES256", typ:"t3x-ticket+jwt", kid:<设备 id>}` + 载荷 `{v:1, iss:<设备 id>, rid, sub:<子域名>, iat, exp: iat+86400}`。

**frps 配置**（`infra/self-host/frps.toml` 重写）：

```toml
bindPort = 7000                       # 不发布到宿主机；只有 Caddy 能经 compose 网络访问
vhostHTTPPort = 8080
subDomainHost = "{{ .Envs.T3X_DOMAIN }}"
transport.heartbeatTimeout = 90

[[httpPlugins]]
name = "t3x-registry"
addr = "registry:8081"
path = "/frps"
ops = ["Login", "NewProxy", "Ping", "NewWorkConn"]
```

**插件规则**（注册表 `plugin.mjs`）：

| op            | 检查                                                                                                                                      | 失败                                  |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------- |
| `Login`       | `metas.t3x_ticket` 签名合法、`exp` 未过、`rid` 匹配、设备在名单里且是电脑、`user` = 设备 id 前 16 位；通过则记录 `run_id → 设备 id`，更新 `last_tunnel_at` | `reject: true, reject_reason: "…"`    |
| `NewProxy`    | `proxy_type == "http"`、`subdomain` 等于该设备的子域名、`custom_domains/locations/http_user` 为空、该设备只有这一个代理                    | 拒绝                                  |
| `Ping`        | 用 `user.run_id`/`user.metas` 找到设备，设备仍在名单里；更新 `last_tunnel_at`（批量落盘）                                                 | 拒绝（frpc 收到错误的 Pong 后断开）   |
| `NewWorkConn` | 同 `Ping`                                                                                                                                 | 拒绝                                  |

插件返回 `{"reject": false, "unchange": true}` 表示放行 [已核实：`doc/server_plugin.md`]。插件不可用（注册表重启）时，frps 对该请求按失败处理 [推断]；frpc 会重连，注册表几秒内恢复。

### 3.8 清单同步与撤销（server）

```
未加入 ──join──▶ 已加入·在线 ◀─┐
   ▲                 │          │ 同步成功
   │            同步失败        │
   │                 ▼          │
   │          已加入·清单过期 ──┘
   │                 │
   └── 自己被移除 / leave ──────┘
```

| 事件                           | 动作                                                                                                                                                            |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server 启动，已有 membership   | 读 `fork-device-list` 作为当前清单；启动 `DeviceTunnel`；立刻同步                                                                                               |
| 每 60 秒 / `devices.refresh`   | `GET /v1/devices`；200 → 原子写入清单 → 对账（撤销已消失设备的 `t3x-device:*` 会话）→ 发布变更流；304 → 只刷新 `fetchedAt`；网络错误 → 标记过期，保留清单      |
| `401 device_unknown`           | 自己被移除：进入"未加入"（Q8）                                                                                                                                  |
| 通行证到达                     | 用内存里的清单验证（不在请求路径上访问 VPS）                                                                                                                    |
| `devices.invite/remove/rename` | 直接调注册表（用本机密钥签名），成功后立即触发一次同步，让界面马上刷新                                                                                          |

### 3.9 server 的 RPC 与契约（`packages/contracts/src/forkDeviceKeys.ts`，仿照 `forkPush.ts`）

| RPC                      | 权限                                                 | 说明                                                                                  |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `devices.status`         | `access:read`                                        | `{state, registryHost, deviceId, name, url, tunnel:{status, lastError}, listFetchedAt, stale}` |
| `devices.subscribe`      | `access:read`                                        | 流：先给 `{rev, devices[]}` 快照，清单或状态变化时再推送                              |
| `devices.join`           | 本机 owner（server 检查）                            | `{invite, name}`                                                                      |
| `devices.leave`          | 本机 owner                                           | 向注册表删除自己，再清本地                                                            |
| `devices.invite`         | `access:write`（`CLIENT_GUARDED_RPC_SCOPES`）        | `{kind}` → `{id, invite, expiresAt}`                                                  |
| `devices.cancelInvite`   | `access:write`                                       | `{id}`                                                                                |
| `devices.remove`         | `access:write`                                       | `{deviceId}`                                                                          |
| `devices.rename`         | `access:write`                                       | `{deviceId, name}`                                                                    |
| `devices.refresh`        | `access:read`                                        | 立即同步                                                                              |
| `devices.signAssertion`  | 本机 owner                                           | 3.6                                                                                   |

- 手机的会话没有 `access:write`，所以邀请 / 移除 / 重命名在 server 一侧也是被拒绝的，这是**第二道**防线；第一道是注册表按设备种类拒绝。
- 写操作用 `createEnvironmentRpcCommand`，`CLIENT_GUARDED_RPC_SCOPES` 里登记（仿 `apps/mobile/src/fork/push/pushCommands.ts`），并补 `clientRpcPermissions` 的权限行为测试（AGENTS.md 要求）。
- 不提供 MCP 工具：让 agent 能给自己的电脑加设备或移除设备，没有合理的使用场景，且风险高。定时任务同理不触及。
- `capabilities.deviceKeys` 由 server 的能力声明给出，旧客户端 / 旧 server 看不到这一区。
- 无头 CLI：`t3x devices join <邀请>` / `list` / `invite --kind phone` / `remove <名字>` / `leave` / `tunnel install`，调用同一个服务，输出邀请时同样打印二维码（复用 `renderTerminalQrCode`，`apps/server/src/startupAccess.ts:162`，`cli/pair.ts:247` 就是这样用的）。

### 3.10 server 状态存放

| 位置（`ServerSecretStore` 名）     | 内容                                                                                      |
| ---------------------------------- | ----------------------------------------------------------------------------------------- |
| `fork-device-key`                  | 私钥 JWK（0600，原子写入）                                                                |
| `fork-device-membership`           | `{registryOrigin, registryId, deviceId, name, kind, subdomain, url, joinedAt}`            |
| `fork-device-list`                 | `{rev, fetchedAt, devices[]}`                                                             |
| `t3x-assertion-<hash>`             | 重放标记（空内容，由 `replayMarkers` 清理）                                               |
| `<stateDir>/device-public-url.json`| 只含 `{url}`，供 `PublicUrls` 读取（不含秘密）                                            |
| `<stateDir>/fork-tunnel/frpc.toml` | 每次启动重新生成（含 ticket，不含私钥），0600                                             |

## 4. 威胁模型

假设攻击者能看到公网上的所有流量（但看不到 VPS 上 Caddy 解密后的明文，除非 VPS 本身被攻破）、能猜 URL、能抓到某一个泄露的字符串。"剩余风险"一列是实现后仍然存在的。

### 4.1 要求的八种情形

| #   | 情形                              | 能做什么                                                                                                          | 缓解                                                                                                                                                                                                                                                                              | 剩余风险                                                                                                                                         |
| --- | --------------------------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | 丢失的手机                        | 拿到解锁的手机就能用 app，通过会话访问你的电脑（含终端）                                                          | 到任一台电脑 Devices 移除（或 VPS 上 `./t3x revoke`）；60 秒内所有在线电脑撤销其会话；注册表拒绝其签名；SecureStore 用 `WHEN_UNLOCKED_THIS_DEVICE_ONLY`，锁屏时读不出密钥；手机会话没有 `access:write`，不能再去邀请或移除别人                                                    | 电脑离线（VPS 不通）时撤销要等下次同步成功；手机上的私钥不是"不可导出"（Q1），已解锁且被 root 的手机可能被取出密钥。要阻断需要原生 Keystore（见第 10 节问题 3） |
| 2   | 泄露的邀请字符串                  | 在 15 分钟内、被用掉之前，抢先加入成一台设备                                                                      | 单次使用、15 分钟、128 位密钥、只存哈希；邀请指定设备类型；`./t3x invites` 和电脑界面都能看到待用邀请并取消；兑换时注册表日志记 IP 和设备名；加入成功会立刻出现在所有人的清单里                                                                                                    | 抢到的人在你发现并移除之前是一台正式设备。邀请要当作密码来传递（和 `authorized_keys` 里加一行是同一个级别）                                      |
| 3   | 被偷的会话令牌                    | 单独拿着令牌没用：会话是 DPoP 绑定的，每次请求要用私钥签证明                                                      | 令牌只绑定一把 DPoP 密钥；通行证本身绑定 `cnf.jkt` 且 120 秒过期；会话 1 小时到期；撤销后立即失效                                                                                                                                                                                  | 同时偷到令牌和 DPoP 私钥（同一台设备被攻破）；局域网明文 HTTP 上窃听到的 DPoP 证明，`jti` 一次性，无法重放                  |
| 4   | 被偷的注册表数据库                | 得到所有设备的公钥、名字、子域名，以及邀请的 SHA-256                                                              | 库里没有私钥、没有会话令牌；邀请密钥 128 位，哈希不可逆，且 15 分钟后失效；`registry_id` 不是秘密                                                                                                                                                                                  | 设备清单（谁、叫什么、在线时间）泄露，属于隐私泄露。能写数据库的人（即控制 VPS 的人）可以加钥匙——已接受的限度，第 9 节的"清单由设备签名"可消除   |
| 5   | 被移除后仍在运行的电脑            | 继续占着隧道、继续回应请求                                                                                        | 插件在 `Login`、`NewProxy`、`Ping`、`NewWorkConn` 都检查名单；显式开启 30 秒心跳（TCPMux 默认关闭心跳，必须显式写）；被拒的 `Ping` 让 frpc 断开，重连的 `Login` 被拒；它的 server 下次同步发现自己被移除，停隧道并清密钥；别的电脑 60 秒内撤销它的通行证会话                      | 心跳窗口内（≤约 90 秒）它仍可能服务已建立的连接；VPS 上有人手动给它放行时无法阻止。验证项见第 8 节                                               |
| 6   | 重放通行证                        | 重放同一张通行证以获取新会话                                                                                      | `jti` 在 `secrets/` 里一次性（先验证全部其它项，最后才消耗）；120 秒时间窗；`aud` 绑定一台电脑；`cnf.jkt` 要求同时拥有 DPoP 私钥；DPoP 证明自己也有 `jti` 一次性                                                                                                                    | server 重启不丢标记（落盘）；时钟偏差超过 120 秒会被误拒（报 `time_window`，界面提示检查时间）                                                   |
| 7   | 电脑冒用别的电脑的子域名          | 把别人的域名指向自己，截获手机的请求                                                                              | `NewProxy` 插件强制 `subdomain == 该设备登记的子域名`，且不允许 `custom_domains`、`locations`；`user` 必须等于设备 id 前缀，frps 按 `user` 隔离代理名；Caddy 的 `ask` 只给已登记名字发证书；手机连接前先核对 `/.well-known/t3/environment` 的 environmentId，再发任何凭据          | 子域名被释放后分配给另一台电脑：旧书签会打到新电脑，但环境 id 校验会拒绝发送凭据                                                                 |
| 8   | VPS 被攻破（**已接受**）          | 读取所有经过 Caddy 的明文（含会话令牌与对话）；往名单里加自己的钥匙；冒充注册表                                  | 用户已明确接受。DPoP 绑定使被读到的令牌不能在别处重放，但攻击者在中间位置可以直接代理请求；保持 VPS 只开 80/443、自动更新、只给 root 一个人                                                                                                                                        | 全部。第 9 节的两项加固（电脑自己解 HTTPS；清单由设备签名）做完才能消除                                                                          |

### 4.2 补充情形

| #   | 情形                                              | 缓解 / 说明                                                                                                                                                                                                                                                                  |
| --- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | 带终端权限的手机读取电脑的设备密钥                | **不是 OS 边界**：手机会话有 `terminal:operate`，等于 server 用户的 shell，能读 `secrets/fork-device-key`（`docs/internals/environment-auth.md` 开头也说明了：withholding management 不是边界）。注册表按种类拒绝手机邀请 / 移除只防"诚实但被诱导的客户端"和被盗的手机密钥；被盗后到撤销之前，手机可以升级为这台电脑的身份。第 10 节列为需要主控知道的限度 |
| 10  | 偷到电脑的 state 目录                             | 拿到设备私钥 = 这台电脑。与偷到 `~/.ssh/id_ed25519` 同级。移除该设备即失效                                                                                                                                                                                                    |
| 11  | 钓鱼邀请（对方给你一个指向他自己注册表的邀请）    | 加入前界面显示注册表域名，要求确认；加入后只会看到那个注册表里的电脑；只泄露你的设备公钥                                                                                                                                                                                     |
| 12  | 滥用 Caddy 按需证书（用大量 SNI 耗尽证书额度）    | `ask` 只放行已登记的子域名；`ask` 只在 compose 内网监听；不使用 Caddy 的 interval/burst（文档不建议）                                                                                                                                                                         |
| 13  | 猜邀请 / 撞 `/v1/join`                            | 128 位密钥；`/join` 每 IP 失败 10 次 / 10 分钟；邀请 id 与密钥分开，id 不是秘密                                                                                                                                                                                              |
| 14  | frps 插件端口暴露                                 | `:8081` 和 `:8082` 只绑 compose 内网地址，Caddy 里没有任何指向它们的路由；宿主机不发布                                                                                                                                                                                       |

## 5. 阶段计划

流程沿用 `tasks/todo.md` 的惯例：每阶段独立 worktree 实现 → 测试与 review 并行 → 修复 → `--no-ff` 合入。**8.3 与 8.4 在 8.2 的契约（`forkDeviceKeys.ts`）冻结后可以并行**，其余顺序依赖。规模：S ≈ 1 天以内，M ≈ 2–3 天，L ≈ 4–6 天（以一个实现者计）。

### 阶段 8.0 验证（S）：先确认 frp / Caddy / Node 的运行时行为

- **交付**：第 8 节清单逐项的结果（通过 / 不通过 / 方案调整），写回本文档第 8 节；一个一次性的 `docker-compose.spike.yml`（不进仓库，放 `/tmp`）。不写产品代码。
- **新文件**：无（只改本文档）。**上游接线**：无。
- **验收**：第 8 节所有 [待验证] 项都有结论；有项目不通过则同步调整第 2 节 Q6 的方案并告知主控。
- 谁来做：测试方（本机有 Docker 的人）。设计阶段我没有运行 Docker。

### 阶段 8.1 VPS 端（L）

- **交付**：注册表服务（API、插件、`ask`、CLI）；重写后的 compose / Caddyfile / frps.toml；`setup.sh`、`./t3x`；ntfy 并入；旧的 README 和 `frpc.toml.example` 挪到 `infra/self-host/advanced/`；测试用 compose 覆盖文件。
- **新文件**（全在 `infra/self-host/`）：`registry/Dockerfile`、`registry/server.mjs`、`registry/db.mjs`、`registry/proof.mjs`（JWS / 指纹 / 请求签名）、`registry/invites.mjs`、`registry/subdomain.mjs`、`registry/plugin.mjs`、`registry/ask.mjs`、`registry/cli.mjs`、`registry/qr.mjs`（vendored）、`registry/*.test.mjs`、`setup.sh`、`t3x`、`docker-compose.test.yml`、`Caddyfile.test`、`README.md`（重写）、`advanced/README.md`、`advanced/frpc.toml.example`。
- **上游接线**：无（`infra/` 不是上游代码，但 `fork:guard` 扫描 `scripts/` 和 `packages/`，这里新增的路径不涉及）。
- **验收**：
  - `node --test infra/self-host/registry` 全绿（Mac 上不需要 Docker）。
  - `docker compose -f docker-compose.yml -f docker-compose.test.yml up` 起得来，宿主机只绑 `127.0.0.1:18443`；`curl --cacert` 访问 `/v1/info` 通。
  - 用一个脚本化的"假设备"（Node，使用 `proof.mjs`）完成：CLI 出邀请 → 加入 → 列出 → 邀请手机 → 移除；frpc 0.61.1 用 ticket 登录成功，访问 `https://a.t3.localhost:18443/` 到达本机一个小 HTTP 服务；换一个别人的子域名被 `NewProxy` 拒绝；移除后 90 秒内 frps 日志里出现断开。
  - `setup.sh` 在干净的 compose 上打印邀请字符串和二维码；`--no-ntfy` 生效。
- 规模：registry ≈ 1,100 行 + 测试 ≈ 1,200 行；compose / Caddy / 脚本 ≈ 350 行；vendored QR ≈ 600 行。

### 阶段 8.2 server 核心（L）：身份、注册表客户端、清单、通行证、撤销

- **交付**：电脑能加入、同步清单、验证通行证并签发 DPoP 会话、对账撤销、代渲染进程签名、被移除后自清理。**不含隧道**。
- **新文件**：
  - `packages/contracts/src/forkDeviceKeys.ts`（RPC 与数据类型）。
  - `packages/shared/src/forkDeviceKeys/`：`jws.ts`、`invite.ts`、`assertion.ts`、`subdomain.ts`、`proof.ts`（纯函数，noble P-256，被 server / client-runtime / mobile 共用）。
  - `apps/server/src/fork/deviceKeys/`：`DeviceIdentity.ts`、`RegistryClient.ts`、`DeviceDirectory.ts`（同步 + 对账 + 变更流）、`DeviceAssertionAuth.ts`（`/oauth/t3x-device`）、`DeviceKeysService.ts`（join / leave / invite / remove / rename / signAssertion）、`deviceRpcHandlers.ts`、`layer.ts`，以及各自的 `*.test.ts`。
  - `apps/server/src/cli/devices.ts`（`t3x devices …`，除 `tunnel` 之外）。
- **上游接线**（均带 `// fork:`，行数是估计）：`packages/contracts/src/index.ts` 与 `rpc.ts`（并入 RPC 组，约 4 行）；`clientRpcPermissions.ts`（受保护写入，约 3 行）；`apps/server/src/auth/RpcAuthorization.ts` 与 `RpcInstrumentation.ts`（权限和指标表，约 6 行）；`apps/server/src/ws.ts`（handler，约 3 行）；`apps/server/src/server.ts`（import + layer + 路由，约 4 行）；`apps/server/src/auth/replayMarkers.ts:15`（前缀，1 行）；`apps/server/src/auth/AuthAttemptLimiter.ts:101`（1 个 case）；`apps/server/src/environment/PublicUrls.ts`（读第二个文件，约 6 行，在 `make` 里）；`apps/server/src/cli/`（注册子命令，约 3 行）。
- **验收**：
  - 对着真实的 8.1 注册表（进程内启动，不用 Docker）：加入 → 清单同步 → 通行证换到会话；手机种类会话没有 `access:write`；`audience_mismatch`、`replay`、`time_window`、`key_mismatch`、`device_revoked` 各有反向用例。
  - 移除设备后调用 `devices.refresh`，该设备的会话立即消失，已连接 socket 关闭，推送注册被删。
  - VPS 不通：`stale` 状态，已有设备仍可用通行证登录。
  - `devices.signAssertion` 只对 `desktop-bootstrap` 主体成功，配对链接来的会话（即使有 `access:write`）被拒。
  - 续期不踢掉 socket（Q2 的 `awaitInvalidation` 验证项）。
  - `vp run fork:guard`、`vp run check:changed` 通过；权限行为测试覆盖新的受保护 RPC。
- 规模：契约 ≈ 250 行；shared ≈ 450 行；server ≈ 1,600 行；测试 ≈ 1,800 行。

### 阶段 8.3 隧道与无头 CLI（M）

- **交付**：server 托管 frpc（生成配置、签 ticket、退避、检测登录失败后重启、12 小时轮换）；`membership` 写出 `device-public-url.json`；`t3x devices tunnel install|status`；frp 版本表和下载校验。
- **新文件**：`apps/server/src/fork/deviceKeys/DeviceTunnel.ts`、`frpcConfig.ts`、`frpBinary.ts`（查找和校验）、对应测试；`packages/shared/src/forkFrp.ts`（版本、URL、SHA-256 表）；`scripts/fork-fetch-frp.ts`（下载 + 校验 + 缓存，打包和端到端共用）。
- **上游接线**：`apps/desktop/src/backend/DesktopBackendConfiguration.ts`（`T3X_FRPC_PATH`，1–2 行）。
- **验收**：配置生成的快照测试（含心跳、`wss`、子域名、不含私钥）；ticket 的签名 / 过期单测；用假 frpc 可执行文件验证退避和"登录失败行 → 重启"；真实 frpc 对 8.1 的 compose 连通并自动重连一次（重启 frps 容器）；`forkFrp` 版本与 compose 一致的测试。
- 规模：≈ 700 行 + 测试 ≈ 700 行。

### 阶段 8.4 客户端（L）

- **交付**：web / 桌面设置页（Devices、加入、邀请、移除、Advanced）；client-runtime 的装饰层、同步器、"设备管理的环境"索引；手机的加入页、设备页、前台刷新；zh-Hans。
- **新文件**：
  - `packages/client-runtime/src/fork/deviceKeys/`：`DeviceKeyAuthorization.ts`（装饰 `RemoteEnvironmentAuthorization`）、`deviceEnvironmentSync.ts`（清单 → `register` / `remove`）、`managedIndex.ts`（索引的存储接口）。
  - `apps/web/src/components/settings/DevicesSettings.tsx`、`apps/web/src/fork/deviceKeysStore.ts`、`apps/web/src/fork/deviceKeysCommands.ts`；`apps/web/src/i18n/catalogs/zh-Hans/devices.ts`（具体路径跟随现有 catalog 目录）。
  - `apps/mobile/src/fork/deviceKeys/`：`deviceKey.ts`（SecureStore）、`registryClient.ts`（直接调注册表）、`useDeviceSync.ts`（前台刷新）、`JoinServerScreen.tsx`、`ServerDevicesScreen.tsx`、`deviceCommands.ts`；mobile 的 zh-Hans 文件。
- **上游接线**：`apps/web/src/components/settings/ConnectionsSettings.tsx`（把 `<SelfHostSettings />` 那一处换成 `<DevicesSettings />`，1 行）；`apps/web/src/connection/runtime.ts` 与 `apps/mobile/src/connection/runtime`（提供装饰后的 layer，各 1–2 行）[推断，需读文件确认]；`apps/mobile/src/Stack.tsx`（两个路由）；`apps/mobile/src/App.tsx`（安装前台同步，仿推送）；`apps/web/src/i18n/catalogs/zh-Hans/index.ts` 与 mobile 对应入口（各 1 行）；`apps/mobile/app.config.ts` 不改（无新原生模块，native fingerprint 不变）。
- **验收**：
  - 单元：装饰层分派（设备环境走通行证，其余走原实现）；同步器的增 / 删 / 改 URL，不动用户手动添加的环境；SecureStore 密钥的生成、读取、损坏恢复；加入流程各错误态。
  - 桌面：在 Electron 里走一遍加入 → 邀请 → 移除（`test-t3-app`），中英文对照截图；Advanced 里原功能仍然可用。
  - 浏览器（非桌面）：没有 `t3xSelfHostBridge` 时 Advanced 不出现，Devices 区按能力显示。
  - 手机：在没有安卓设备的条件下，只验证单元测试和 jest 渲染；真机项见第 7.4 节。
  - 性能：Devices 区不引入定时器；邀请的过期用绝对时间；`devices.subscribe` 在设置页之外不挂载额外订阅（环境同步订阅除外）。
- 规模：client-runtime ≈ 700 行；web ≈ 900 行 + 约 80 条译文；mobile ≈ 900 行 + 约 70 条译文；测试 ≈ 1,300 行。

### 阶段 8.5 打包、文档、端到端（M）

- **交付**：`fork-dist-mac.ts` 内置 frpc 并签名；FORK.md「自建连接」重写、`infra/self-host/README.md` 重写、`docs/user/remote-access.md` 新增 "Your own server" 一节并把旧的 "Your own public address" 标为 Advanced、`docs/internals/` 一页（为什么是通行证而不是挑战、信任边界、手机 shell 的限度）；端到端脚本 `scripts/fork-selfhost-e2e.ts` + `vp run fork:selfhost:e2e`。
- **新文件**：`scripts/fork-selfhost-e2e.ts`、`scripts/fork-selfhost-e2e/dns-preload.cjs`、`docs/internals/self-hosted-devices.md`。
- **上游接线**：`package.json`（脚本一行）。`docs/user/remote-access.md` 是上游文件，新增内容放在单独一节并标 fork。
- **验收**：第 7.2 节的端到端全绿；DMG 重新打包后 `codesign --verify --strict` 覆盖到 `frpc`；FORK.md 中所有路径和命令可以照做；`vp run fork:guard` 通过。
- 规模：脚本 ≈ 600 行；文档 ≈ 400 行。

## 6. 文件清单

### 6.1 新文件（按位置）

| 位置                                                        | 内容                                                                                       |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `infra/self-host/registry/*.mjs`、`Dockerfile`              | 注册表（8.1）                                                                              |
| `infra/self-host/{setup.sh,t3x,docker-compose.test.yml,Caddyfile.test}`、`advanced/` | 部署脚本、测试覆盖、旧文档（8.1）                                          |
| `packages/contracts/src/forkDeviceKeys.ts`                  | RPC 与数据类型（8.2）                                                                      |
| `packages/shared/src/forkDeviceKeys/`、`forkFrp.ts`         | 纯函数协议库、frp 版本表（8.2、8.3）                                                       |
| `apps/server/src/fork/deviceKeys/`                          | server 服务（8.2、8.3）                                                                    |
| `apps/server/src/cli/devices.ts`                            | 无头 CLI（8.2、8.3）                                                                       |
| `packages/client-runtime/src/fork/deviceKeys/`              | 装饰层与同步器（8.4）                                                                      |
| `apps/web/src/components/settings/DevicesSettings.tsx`、`apps/web/src/fork/deviceKeys*.ts` | 桌面 / web 界面（8.4）                                     |
| `apps/mobile/src/fork/deviceKeys/`                          | 手机（8.4）                                                                                |
| `scripts/fork-fetch-frp.ts`、`scripts/fork-selfhost-e2e.ts`、`scripts/fork-selfhost-e2e/` | 下载校验、端到端（8.3、8.5）                                       |
| `docs/internals/self-hosted-devices.md`                     | 一页决策说明（8.5）                                                                        |

### 6.2 要改的上游文件（全部带 `// fork:`，估计 ≤ 40 行）

| 文件                                                                    | 改什么                                              | 阶段 |
| ----------------------------------------------------------------------- | --------------------------------------------------- | ---- |
| `packages/contracts/src/index.ts`、`rpc.ts`                             | 并入 `devices.*` RPC 组                             | 8.2  |
| `packages/contracts/src/clientRpcPermissions.ts`                        | 受保护写入的 scope                                  | 8.2  |
| `apps/server/src/auth/RpcAuthorization.ts`、`RpcInstrumentation.ts`     | 权限与指标表                                        | 8.2  |
| `apps/server/src/ws.ts`                                                 | RPC handler                                         | 8.2  |
| `apps/server/src/server.ts`                                             | import、layer、`/oauth/t3x-device` 路由             | 8.2  |
| `apps/server/src/auth/replayMarkers.ts:15`                              | 重放标记前缀                                        | 8.2  |
| `apps/server/src/auth/AuthAttemptLimiter.ts:101`                        | 新路径的限速 case（以及 8.0 可能要求的 XFF 处理）   | 8.2  |
| `apps/server/src/environment/PublicUrls.ts`                             | 额外读 `device-public-url.json`                     | 8.2  |
| `apps/server/src/cli/*`                                                 | 注册 `devices` 子命令                               | 8.2  |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts`               | `T3X_FRPC_PATH`                                     | 8.3  |
| `apps/desktop/src/ipc/methods/serverExposure.ts`                        | 配对二维码可选到设备地址（需核实路径一致）          | 8.4  |
| `apps/web/src/components/settings/ConnectionsSettings.tsx`              | 渲染 `DevicesSettings`                              | 8.4  |
| `apps/web/src/connection/runtime.ts`、`apps/mobile/src/connection/runtime` | 提供装饰后的 `RemoteEnvironmentAuthorization`   | 8.4  |
| `apps/mobile/src/Stack.tsx`、`App.tsx`                                  | 路由、前台同步                                      | 8.4  |
| i18n 入口（web、mobile 的 `zh-Hans/index.ts`）                          | 并入新 catalog                                      | 8.4  |
| `package.json`                                                          | `fork:selfhost:e2e` 脚本                            | 8.5  |

**不会动**（这是方案刻意避开的）：`packages/client-runtime/src/connection/{resolver,routes,driver,catalog}.ts`、`registry.ts`、`apps/server/src/auth/{http,EnvironmentAuth,SessionStore}.ts`、`packages/contracts/src/auth.ts`、任何数据库迁移、`apps/mobile/app.config.ts` 与 native 模块。

### 6.3 与共存保证的核对

| 项                        | 结论                                                                                                                                  |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 端口                      | 没有新的本地监听端口；frpc 只出站；server 沿用 3873。测试用 `127.0.0.1:18443`，不碰官方的 3773                                       |
| 目录                      | 全部在 `~/.<fork home>/userdata` 下（`ServerSecretStore` / `stateDir`）；frp 缓存在 fork home 的 `bin/`，不是 `~/.t3`                 |
| URL scheme                | 不新增；深链形式将来使用 `FORK.scheme`                                                                                                |
| git refs                  | 无                                                                                                                                    |
| 钥匙串 / 签名             | 不新增钥匙串项；frpc 用现有的 `T3 Extend Code Signing` 身份签名                                                                       |
| 官方 T3 Code 的数据       | 不读不写 `~/.t3`；设备身份和官方应用没有任何交集                                                                                      |
| `fork:guard`              | 新代码不含官方身份字面量；`.t3` 字符串（带引号的）要避免，frp 路径用 `FORK` 常量                                                      |

### 6.4 每个平台各得到什么，以及 AGENTS.md「Hit every surface」核对

| 平台                 | 得到                                                                                                                                                                         |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面（Electron）     | 完整：加入、邀请、移除、重命名、离开、Advanced；server 托管 frpc 并随 app 启停；渲染进程经本机 server 代签通行证连接其他电脑；内置 frpc 并签名                                |
| Web（server 提供的页面） | Devices 区按能力显示；管理类操作（邀请 / 移除 / 重命名）对有 `access:write` 的会话可用；**加入 / 离开 / 代签只给本机 owner**，纯浏览器不加入、不持有设备密钥                |
| 手机                 | 加入（扫码或粘贴）、设备清单、自动出现所有电脑（含之后加入的）、通行证登录、前台刷新、离开；**没有**邀请 / 移除                                                             |
| 无头 `t3x`           | `t3x devices join/list/invite/remove/leave/tunnel`；server 托管 frpc；没有渲染进程，不需要代签                                                                               |

| AGENTS.md 清单项  | 是否适用，怎么处理                                                                                                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入口              | 适用。设置页之外：命令面板里加 "Invite a device" 动作（桌面 / web），无头 CLI；快捷键不加。命令面板条目放进 8.4 验收                                                                     |
| 客户端            | 适用，见上表。共享逻辑放 `packages/client-runtime/src/fork/` 和 `packages/shared`                                                                                                       |
| Providers         | 不适用：功能与 provider 无关，六个 adapter 都不动                                                                                                                                       |
| Agents / MCP      | **有意不提供**：agent 不应能给自己的电脑加设备或移除设备；定时任务同理。服务逻辑仍是 service 方法，传输层（`ws.ts`、HTTP 路由、CLI）保持很薄                                            |
| 契约              | 适用：`packages/contracts/src/forkDeviceKeys.ts`；server / web / mobile / desktop 一起跟随。`access:write` 的写入登记 `CLIENT_GUARDED_RPC_SCOPES`                                        |
| 反向状态          | 适用且已覆盖：加入 ↔ 离开；邀请 ↔ 取消邀请；加入 ↔ 移除；"这台电脑被移出"的显示；"看得到"：设备清单、待用邀请、`stale` 状态                                                              |
| 连接方式          | 适用：公网子域名是 `public` 路由，LAN / tailnet 来自学习路由，通行证以 environmentId 为 `aud` 所以三者通用；多设备、多环境（多台电脑）是核心场景                                         |
| 文档              | 适用：FORK.md「自建连接」会变得不准确，8.5 重写；`docs/user/remote-access.md` 新增一节；`docs/internals/` 只加一页决策说明（遵循"只写代码读不出来的原因"）                              |

## 7. 测试计划

测试规则沿用 AGENTS.md：测能出错的行为（协议、鉴权、持久化、竞态、外部格式解析）；在最低的一层写；用 `it.effect` 的 `TestClock` 和 `Deferred`，不写 `sleep` 轮询；浏览器测试用 `await using screen = await render(...)`。

### 7.1 逐层单元测试

| 层                                  | 测什么                                                                                                                                                                                                                       | 位置                                                         |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| 协议库（shared）                    | 指纹（RFC 7638 向量）；JWS 签发 / 验证往返；通行证和 ticket 的字段校验（过期、`exp-iat>120`、缺 `cnf`、`aud` 错）；邀请编解码（版本未知、截断、base64 污染）；子域名派生（汉字、emoji、保留名、长度、冲突后缀）           | `packages/shared/src/forkDeviceKeys/*.test.ts`               |
| **交叉向量**                        | 同一组固定私钥生成的请求签名 / 通行证 / ticket 向量，分别被 shared（noble）和注册表（`node:crypto`）验证；一旦两边不一致测试就失败。向量文件放 shared，注册表测试读取它                                                      | `packages/shared`（生成），`infra/self-host/registry`（读取） |
| 注册表（`node --test`）             | 邀请：并发兑换只有一个赢家、过期、种类不符、密钥错；加入：名字冲突、子域名分配；签名请求：重放、时间窗、`htu` 带查询串被篡改、`bh` 被篡改、手机调用邀请 / 移除被拒；`If-None-Match`；限速；`ask`：只放行登记的子域名；插件四个 op 的放行 / 拒绝；SQLite 并发 | `infra/self-host/registry/*.test.mjs`                        |
| server：DeviceIdentity              | 首次生成、重启读回、文件权限 0600、损坏文件的处理                                                                                                                                                                            | `apps/server/src/fork/deviceKeys/*.test.ts`                  |
| server：DeviceDirectory             | 同步 200 / 304 / 网络错误；`stale` 状态；对账（已消失设备的会话被撤销、仍在的不动、与消失同时到达的新通行证）；自己被移除后的自清理；变更流只在变化时发布                                                                  | 同上                                                         |
| server：DeviceAssertionAuth         | 每个 `t3x_reason` 一个反向用例；成功路径会话内容（subject、scope、label、`jkt`）；**手机会话缺 `access:write`**；`jti` 重放；DPoP 头缺失或指纹不符；先全部验证、最后才消耗 `jti`                                           | 同上                                                         |
| server：signAssertion               | 三个条件各自单独不满足时被拒（非 `desktop-bootstrap`、带转发头、目标不在清单或是自己）；限速                                                                                                                                | 同上                                                         |
| server：DeviceTunnel                | frpc 配置快照；退避序列；登录失败行 → 重启；12 小时轮换；ticket 不出现在命令行参数里；frpc 不存在时的状态和提示                                                                                                              | 同上（假 frpc 可执行文件）                                   |
| server：RPC 权限                    | 新增受保护方法的 `CLIENT_GUARDED_RPC_SCOPES` 行为测试（AGENTS.md 明确要求）                                                                                                                                                  | 现有的权限测试文件里加行                                     |
| 限速                                | `/oauth/t3x-device` 的 401 计入、429 返回；（若采用）`X-T3x-Client-IP` 只在来自 loopback 时信任                                                                                                                              | `AuthAttemptLimiter.test.ts` 加行                            |
| client-runtime                      | 装饰层：设备环境走通行证、其余委托；缓存和提前续期；同步器：增 / 删 / 改 URL，用户手动添加的环境不被动；占位凭据永远不会被读取                                                                                               | `packages/client-runtime/src/fork/deviceKeys/*.test.ts`      |
| web                                 | `DevicesSettings` 各状态（未加入、已加入、清单过期、被移出、加入失败的几种错误）；邀请对话框显示绝对过期时间且没有定时器；Advanced 折叠里的旧功能仍在                                                                           | `*.browser.test.tsx`（`render` from `apps/web/test/render`） |
| mobile                              | 密钥生成 / 读回 / 损坏恢复（mock SecureStore）；加入页的错误态；前台刷新的节流（≥30 秒）；移除后环境消失                                                                                                                     | `apps/mobile/src/fork/deviceKeys/*.test.ts`                  |
| 打包                                | `forkFrp` 版本与 compose 一致；归档 SHA-256 校验失败时拒绝；`fork-dist-mac` 的 Mach-O 校验清单里包含 `frpc`                                                                                                                  | `packages/shared`、`scripts/`                                |

### 7.2 本机能跑的端到端（不用真实 VPS）

`vp run fork:selfhost:e2e`（8.5 交付），先决条件只有 Docker Desktop 和 `scripts/fork-fetch-frp.ts` 能下载 frpc 0.61.1（SHA-256 校验后放进缓存；离线时用 `--frpc-path`）。

**环境搭建（每次运行，随后全部清理）**

| 项           | 做法                                                                                                                                                                                                                                                     |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Docker       | `docker compose -p t3x-e2e -f docker-compose.yml -f docker-compose.test.yml up -d --build`。测试覆盖文件把 Caddy 的 `ports` 改成 **只** `127.0.0.1:18443:443`（不发布 80、7000、8080），换用 `Caddyfile.test`（`tls internal`，其余与生产一致），`T3X_DOMAIN=t3.localhost`、`T3X_PUBLIC_PORT=18443`。结束时 `down -v`。项目名固定为 `t3x-e2e`，不碰别的 compose 项目 |
| 域名         | `t3.localhost` 与 `*.t3.localhost`。**不改 `/etc/hosts`**。frpc 用 `serverAddr = "127.0.0.1"` + `transport.tls.serverName = "t3.localhost"`，根本不做 DNS。T3 server 和测试客户端是 Node 进程：harness 用 `NODE_OPTIONS=--require=<scripts/fork-selfhost-e2e/dns-preload.cjs>` 启动它们，这个预载脚本只在这些子进程里把 `*.t3.localhost` 的 `dns.lookup` 映射到 `127.0.0.1`，**产品代码零改动**。如果 8.0 证实本机 `getaddrinfo` 本来就解析 `*.localhost`，预载脚本就是空操作。需要浏览器（Electron / Chromium）参与的场景用 `--host-resolver-rules="MAP *.t3.localhost 127.0.0.1"` |
| 信任内部 CA  | `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt` 取出根证书到临时目录。子进程环境里设 `NODE_EXTRA_CA_CERTS=<该文件>`；frpc 配置里写 `transport.tls.trustedCaFile`；浏览器场景用 `--ignore-certificate-errors-spki-list=<该证书 SPKI 哈希>`。**不写系统钥匙串，不改全局设置**，进程退出后随临时目录消失 |
| 两台"电脑"   | 用本 worktree 的 server 入口启动两个实例，`--home-dir <mktemp -d>`（绝不使用 `~/.t3` 或 fork 的真实 home），端口各取空闲端口；`vp run dev` 的世界之外，harness 记录自己启动的每个 PID，结束时只杀这些 PID                                                  |
| "手机"       | 一个 Node 脚本，使用 shared 协议库 + 与真实手机相同的 P-256 代码路径（私钥存在内存里，不是 SecureStore）。它模拟的是协议，不是 Android 界面                                                                                                               |

**场景（每条都断言事件，不用 sleep）**

1. VPS 一次性：`./t3x invite --kind computer` 出邀请（字符串 + 二维码非空）。
2. 电脑 A `t3x devices join <邀请>` → 清单里有 A；A 的隧道 `online`（等待注册表的 `last_tunnel_at` 变化，通过 `Deferred` 订阅 `devices.subscribe`，不轮询）；`https://a.t3.localhost:18443/.well-known/t3/environment` 返回 A 的环境 id。
3. A 邀请"手机" → 手机加入 → 清单里有手机 → 手机通过通行证拿到 A 的 DPoP 会话 → 用该会话调一次只读 RPC 成功；在 A 的 "Authorized clients" 里以手机的名字出现。
4. 电脑 B 加入；A 和 B 互相能看到并通过通行证互相登录（走 `devices.signAssertion` 的路径）。
5. 手机会话调用 `devices.invite` 被 server 拒绝；手机直接调注册表 `POST /invites` 被拒绝。
6. 移除手机（在 B 上操作）→ 在 A 上调用 `devices.refresh` → 手机的会话消失、已连接的 WebSocket 被关闭；手机再换通行证失败 `device_revoked`。（生产里同样的事在 60 秒内发生，这里用 `devices.refresh` 替代等待，证明的是对账逻辑，间隔本身由 `TestClock` 的单测覆盖。）
7. 移除 B（仍在运行）→ 注册表日志里在心跳窗口内出现断开；B 的 `https://b.t3.localhost:18443/` 变 502/404；B 的 server 自清理后状态是"未加入"。
8. 子域名冒用：A 的 frpc 配成 `subdomain = "b"` → `NewProxy` 被拒。
9. 重放：同一张通行证第二次使用被拒；篡改 `aud`、`cnf.jkt` 被拒。
10. VPS 离线：`docker compose stop registry caddy`，局域网地址上（`127.0.0.1:<A 的端口>`，用现有直连路由）手机用缓存清单仍能换会话；恢复后同步继续。
11. 重连：`docker compose restart frps` → frpc 自动重连，ticket 仍有效，隧道恢复；把 ticket 的 `exp` 调成已过期 → 登录失败 → DeviceTunnel 重新生成配置并重启。
12. 证书：访问一个未登记的 `evil.t3.localhost:18443` → TLS 握手失败（`ask` 返回 403）。

### 7.3 手动检查（一次，打包后）

- Electron 里（`test-t3-app`，用 `Replay (dev)` provider，零费用）：加入 → 邀请 → 移除的完整界面流程，中英文对照截图。
- 签名后的 DMG 里 `frpc` 的 `codesign --verify --strict`；**不启动签名包**（会写 fork 的真实数据库，沿用 P7 的做法）。

### 7.4 没有安卓设备访问之前无法测试的

| 项                                                                                                     | 为什么测不了                              | 当前替代                                                  |
| ------------------------------------------------------------------------------------------------------ | ----------------------------------------- | --------------------------------------------------------- |
| Android Keystore 对 `expo-secure-store` 的实际保护（锁屏后读不出、`WHEN_UNLOCKED_THIS_DEVICE_ONLY`）   | 需要真机 / 模拟器                         | 单测 mock；文档里写明未验证                               |
| 相机扫描二维码（`expo-camera`）解码 200 字符的 QR                                                      | 同上                                      | 对生成的 QR 做解码往返单测（用 shared 的编码器 + 解码库） |
| 前台恢复触发刷新（`AppState`）、网络切换（Wi-Fi ↔ 蜂窝）下的路由切换                                   | 同上                                      | 单测覆盖节流逻辑；路由切换逻辑是上游已有的                |
| 手机 → 公网域名 → 局域网回切的整体体验、回到家自动切回局域网                                           | 需要同时有手机和 VPS                      | 7.2 里用"模拟手机"验证协议部分                            |
| 推送：设备会话下 `push.register`、ntfy 在通配域名下的 `ntfy.<域名>`                                    | 需要 UnifiedPush 与真机                   | 沿用 `apps/server/scripts/verify-ntfy-push.ts` 对测试 compose 里的 ntfy |
| 中文界面在手机上的字号 / 层次                                                                          | 需要真机截图                              | 用户的审美验收项，留到设备访问开放后                      |
| 低端 Android 上的 P-256 签名耗时                                                                       | 需要真机                                  | noble 的 P-256 签名在手机 JS 里通常几十毫秒，一小时一次 [推断] |

## 8. 阶段 8.0 要验证的事项

以下全部是设计阶段**没有运行**的前提。结果写回这一节；任何一项失败，按"后果"调整第 2 节。

| #   | 要验证                                                                                                                                       | 期望                                                               | 失败的后果                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| 1   | frpc 0.61.1 `wss` → Caddy `handle @frp` 路径 `/~!frp` → frps `:7000` 明文 ws；`transport.tls.force` 去掉后是否正常                           | 控制通道建立                                                       | 路径不对：以 frps 实际的 websocket 路径为准；frps 要求 TLS：给 compose 内网一张自签证书              |
| 2   | `Login` 插件收到 `metas.t3x_ticket`；`reject_reason` 出现在 frpc 日志里                                                                      | 是                                                                 | 改用 `user` 字段携带                                                                               |
| 3   | TCPMux 默认下心跳关闭；显式 `heartbeatInterval=30` 后 `Ping` op 被调用，间隔约 30 秒                                                          | 是                                                                 | 同时关闭 `transport.tcpMux`，或改用只靠 `NewWorkConn` / 定时断开的移除手段                          |
| 4   | 拒绝 `Ping` 后 frpc 是否断开会话、重连、被 `Login` 拒绝；总耗时                                                                              | ≤ 90 秒                                                            | 注册表在移除时主动用 frps 的 dashboard API 或重启 frps 的方式踢人（需要 `webServer` 打开，内网）     |
| 5   | frpc 首次登录成功之后遇到登录失败，是重试还是退出；日志里能稳定匹配的失败文字                                                                | 重试（`loginFailExit=false`）；文字可匹配                          | 若退出，则 `DeviceTunnel` 的退避重启已足够，去掉"匹配失败文字"的需求                               |
| 6   | HTTP vhost：Host 原样透传、`X-Forwarded-Proto` 保留、WebSocket 与 SSE 不被缓冲；`X-Forwarded-For` 是否被 frps 追加了一跳                      | 前三项通过；XFF 若被追加则采用 `X-T3x-Client-IP`                   | vhost 不可用：改为 `type=tcp` + 每台电脑一个内部端口，由 Caddy 按子域名路由到对应端口（改动在 Caddy 生成逻辑） |
| 7   | Caddy `on_demand` + `ask` + `tls internal` + 通配 catch-all 站点与显式站点共存；首次访问的延迟；用一次带 SNI 的内部请求预热                    | 通过                                                               | 预热无效就去掉，只在文档里说明首次访问慢几秒                                                       |
| 8   | macOS 上 `*.t3.localhost` 对 Node（getaddrinfo）、Go（frpc）、curl 的解析                                                                    | 任一结果都可用（不解析就启用预载脚本）                             | 无，预载脚本兜底                                                                                   |
| 9   | `node:24-alpine` 里 `node:sqlite` 无需标志可用；WAL；批量写入心跳时间戳                                                                       | 是                                                                 | 退回 `node:22.13+` 或加 `--experimental-sqlite`                                                    |
| 10  | frpc 0.61.1 darwin_arm64 官方归档：记录 SHA-256；放入 `.app` 后 `codesign --options runtime` 签名并运行                                       | 通过                                                               | 需要额外 entitlement：在 `packaging/fork-macos/` 的 inherit 文件里补                              |
| 11  | `userName` / `user` 字段对 `proxy_name` 的前缀作用（`<user>.<name>`）以及插件 `NewProxy` 里 `proxy_name` 的形式                              | 符合预期                                                           | 调整插件的比较逻辑                                                                                 |
| 12  | （可选）OIDC 方案：frpc 取令牌的时机、令牌是否放在 `privilege_key`、frps 的签名算法限制                                                      | 仅在 3、5 失败时才看                                               | –                                                                                                  |

另有一项属于 8.2 的验收而不是 8.0：续期时用 `replaceActiveForSubjectAndMethod` 压成每设备一行，是否会让已连接的 socket 掉线（`SessionStore.ts:1043-1100`）。

## 9. 以后再做的安全加固（2026-11-03 用户同意先记下，暂不做）

这两项和 `tasks/todo.md` 阶段 8 末尾的清单一致。当前设计为它们留了位置，不需要推翻重来：

| 加固项                                                                                           | 现在已经留下的接口                                                                                                                                  | 做的时候要改什么                                                                                                                                           |
| ------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 电脑自己解 HTTPS：VPS 只按 SNI 转发加密后的字节，每台电脑自动申请 / 续期自己的证书              | 一台电脑一个子域名，一个设备 id；`aud` 用 environmentId 而不是 URL，所以改了传输层通行证仍然有效                                                      | Caddy 换成按 SNI 的四层转发（`caddy-l4` 或 frps 的 HTTPS vhost / `https` 代理类型）；电脑端内嵌 ACME 客户端并通过 HTTP-01/TLS-ALPN-01 经隧道完成验证；`X-T3x-Client-IP` 不再可用，限速改读 PROXY protocol；`ask` 端点不再需要 |
| 设备清单由设备签名：电脑只认签过名的清单，新增 / 移除都要已有设备签名                            | 清单里已经带每台设备的 `jwk`；`rev` 单调递增；`kid` / `rid` 已在所有 JWS 里                                                                         | 清单变成 `{rev, prev, entries[], sig, signer}` 的链；注册表只存储转发，不再有写权限；电脑和手机从第一份已知清单（加入时钉住）起验证链；`./t3x revoke` 要变成"由管理员设备签名"的请求，或者保留一个只在 VPS 本机持有的管理员钥匙 |

两项合起来，工作量大约在本阶段基础上再多一半。

## 10. 需要主控拍板的问题

按重要程度排序。每项都有我的默认选择，不回复就按默认做。

1. **带终端权限的手机能读到电脑的设备密钥。** 手机会话有 `terminal:operate`，等于 server 用户的 shell（`docs/internals/environment-auth.md` 开头说的"withholding management 不是边界"），所以"只有电脑能邀请或移除设备"在注册表和 `access:write` 两层是强制的，但在 OS 层不是边界：一部被盗的手机在撤销之前，理论上可以读走某台电脑的设备密钥并冒充它。可选：(a) 接受并写进文档（默认）；(b) 以后给手机一个"无终端"的受限档位，代价是手机功能缩水。
2. **离线太久是否要拒绝。** 默认：VPS 不通时无限期使用最后一份清单（局域网必须可用）。代价：离线期间被移除的设备，要等 VPS 恢复后才被撤销。可选：清单超过 N 天（例如 30 天）未同步就对新通行证"失败关闭"。
3. **手机私钥的保护强度。** 你的承诺是"手机放在系统钥匙串里"。`expo-secure-store` 实现的是静态加密（Android Keystore 包裹、iOS Keychain），但签名时私钥字节会进入 JS 内存，**不是"不可导出"**。要做到不可导出，需要写原生模块（Android Keystore / iOS Secure Enclave 的 P-256 密钥），会改变 Android 的 native fingerprint，而且现在没法在真机上测。默认：v1 用 SecureStore，选 P-256 保留升级路径，真机可用后再做原生版。
4. **是否复用 `authorization: "t3-connect"` 这个 profile 标记。** 复用可以让 `resolver.ts`、`routes.ts`、`driver.ts` 一行不改（只在两个客户端提供装饰后的 layer），代价是名字有点误导，需要代码注释。新增 `"t3x-device"` 字面量更清楚，但约 5 处上游改动，每次合并上游都可能冲突。默认：复用。
5. **frp 客户端版本。** 默认：打包 0.61.1（与 compose 里的 frps 同版本）。部署包文档里已验证的是 frpc 0.70.0 + frps 0.61.1 的组合；换成 0.61.1 + 0.61.1 的 `wss`、心跳、插件行为都要在 8.0 里重新验证。如果你想保持 0.70.0 客户端，需要同时核对插件协议版本。
6. **ntfy 默认安装。** 默认：`setup.sh` 默认装 ntfy 在 `ntfy.<域名>`，`--no-ntfy` 关闭，并创建只读的 `phone` 账号，随机密码写进 `secrets/ntfy-phone.txt`（0600）。不想在注册表所在的 VPS 上多一个服务的话，改成默认关闭。
7. **配对链接来的浏览器能否邀请 / 移除设备。** 这类会话有 `access:write`（默认标准授权），所以现在它可以通过 `devices.invite/remove` 经电脑的密钥操作。这与"配对链接的浏览器本来就能创建别的配对链接"同级，我按"拥有 `access:write` 就是 owner 级"处理。要更严格就让这几个 RPC 也只给 `desktop-bootstrap` 主体——但那样无头 server 的 Web 管理页就用不了邀请。默认：不加限制。
8. **验证机器和网络。** 8.0 与端到端需要 Docker Desktop 和从 GitHub 下载 frp 归档（国内网络可能慢，`--frpc-path` 可指向手动放好的文件）。VPS 上拉 `node:24-alpine` 同样走 Docker Hub，和现在拉 `caddy`、`fatedier/frps`、`ntfy` 一样；国内 VPS 可能要配镜像加速。默认：照此。
9. **会话在"Authorized clients"里的行数。** 每次续期产生新会话，行数是否压成每设备一行，取决于 8.2 里的验证（`replaceActiveForSubjectAndMethod` 会不会让 socket 掉线）。纯展示问题，不需要你决定，只是预告。

### 我没有核实的前提（汇总）

- 所有 [待验证] 项（第 8 节）：frp 0.61.1 的 wss 路径、心跳行为、`Ping` 拒绝后的客户端处理、vhost 对 XFF 的处理；Caddy 的按需证书与 `tls internal` 共存；`*.localhost` 在本机的解析；`node:sqlite` 的无标志可用性。
- 客户端 layer 的组装点（`apps/web/src/connection/runtime.ts`、`apps/mobile/src/connection/runtime`）、`serverExposure.getAdvertisedEndpoints` 与 server state 目录是否一致、手机 `Stack.tsx` 路由写法，我都没有逐行读，8.4 开始前要先读。
- `apps/server/src/cloud/ManagedEndpointRuntime.ts` 是引用研究文档得到的，没有重读。
- 没有读 `~/.t3/userdata`、`~/.<fork home>/userdata`、凭据、钥匙串或 `.env`；没有运行任何进程、Docker 或 Tailscale。
