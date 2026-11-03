# 自建配对：每台设备一把钥匙（设计）

- 日期：2026-11-03。基线：`main` @ `35d24458d0`。只读调研加设计，没有写实现代码，没有运行 server / dev / Docker。
- 标注约定：**[已核实]** = 读过源码或官方文档对应行；**[实测]** = 阶段 8.0 在本机用 frp v0.71.1、Caddy 本地 CA、`node:24-alpine` 实际跑出来的结果（第 8 节）；**[推断]** = 根据代码结构或旧版本文档推理，没有逐行验证或没有运行；**[待验证]** = 依赖运行时行为、8.0 没覆盖到、留到 8.1 / 8.2 开工时确认的事（第 8c 节）。
- 出处写成 `path:line`，相对仓库根目录。frp 和 Caddy 的文档来自 context7；frp 的行为以 8.0 在 v0.71.1 上的实测为准。
- 用户已批准的方案（SSH 式每台设备一把钥匙）和承诺的安全模型是本文的规格，不再重新讨论；本文只回答"怎么做"。2026-11-03 先按 GPT 评审和主控的 16 条决定修订（对照见 0.4），再按 8.0 的实测结果修订（对照见 0.5）；第 8 节是实测结果本身。
- **读法**：20 分钟读完第 0 节（结论速览）、第 4 节（威胁模型）、第 5 节（阶段）、第 10 节（要你拍板的问题）就够做决定；第 2、3 节是逐题依据和协议细节，实现者再读；第 7、8 节是测试和先要验证的前提。

## 0. 结论速览

一句话：**每台设备自己生成一把 P-256 密钥，VPS 上的注册表（registry）只存公钥。电脑用密钥签名登录隧道，设备用密钥签一张"只给这台电脑、120 秒有效"的通行证，换到一个绑定设备 DPoP 密钥的普通 T3 会话。设备环境在客户端里用新的 profile 标记 `"t3x-device"`，任何一步出错都阻断连接，绝不回退到官方 relay 或 bearer。**

> 2026-11-03 两次修订：评审修订（0.4）和 8.0 实测后的修订（0.5）。第 8 节是 8.0 的实测结果。

### 0.1 十五个问题，一行一个结论

| #   | 问题                   | 结论                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 密钥类型和格式         | **P-256 / ES256，JWK 公钥，设备 id = RFC 7638 指纹**。手机的设备密钥与 DPoP 会话密钥**分开**。v1 手机密钥放 SecureStore：系统钥匙串静态加密，签名时解密进 JS 内存，**不是"不可导出"**（原生版见第 9 节第三项）                                                                                                                                                                                        |
| 2   | 设备怎么向电脑证明自己 | **JWT-bearer 通行证**，不做挑战往返。fork 路由 `POST /oauth/t3x-device`，走与 `/oauth/token` 同一套 DPoP 校验、响应头、CORS 和限速，返回同样的 `AuthAccessTokenResult`；会话 DPoP 绑定，手机比电脑少 `access:write`、`relay:write`                                                                                                                                                                    |
| 3   | 桌面渲染进程连别的电脑 | RPC `devices.signAssertion`，**只有 `desktop-bootstrap` 主体能调**（已签名的会话声明，不看任何请求头）；目标必须在服务端自己的清单里，且不是自己                                                                                                                                                                                                                                                      |
| 4   | 密钥放哪、丢了怎么办   | 手机：`expo-secure-store` 单独一项。电脑：server 的 `ServerSecretStore`（0600）。渲染进程：没有设备密钥。丢了就是一台新设备，没有恢复路径                                                                                                                                                                                                                                                             |
| 5   | VPS 上的注册表         | Node 24 + `node:sqlite`，零 npm 依赖。`T3X-Proof` 的规范 URL = 配置的公网源 + 路径 + 查询串，不读 `Host` / `X-Forwarded-*`；邀请用条件 UPDATE + 唯一约束一次性消费；所有未认证端点限速；二维码由镜像里的 `qrencode` 生成                                                                                                                                                                              |
| 6   | 隧道                   | frp wss 经 Caddy 的 `/~!frp` 进 443，每台电脑一个 HTTP vhost 子域名。frps 插件在 `Login` / `NewProxy` / `Ping` / `NewWorkConn` **每次都查注册表实时库**，且自己限时（frps 调插件没有超时）；ticket 绑定设备 id、子域名和登记代次。**移除一台电脑后隧道最多一个心跳（约 30 秒）内断开**；`NewWorkConn` 不是立即切断点。`X-Forwarded-Proto` 被 frps 改写成 `http`，协议和 issuer 改从本机配置来（3.11） |
| 7   | frpc 在哪运行、怎么发  | **由 server 托管**。frp 钉 **v0.71.1**（frps 镜像 digest 和 darwin_arm64 SHA-256 见 8a），frps 与 frpc 同版本；官方 darwin_arm64 用 `--options runtime` 签名后能运行、没有钥匙串弹窗；`fork-dist-mac.ts` 放进 `.app` 随其余 Mach-O 一起签名                                                                                                                                                           |
| 8   | 电脑上的设备清单同步   | 每 60 秒带 `If-None-Match` 拉一次，存进 `ServerSecretStore`。VPS 不通时可用最后一份清单**至多 7 天**（局域网照常），超过后拒绝新通行证，直到同步成功；24 小时未同步设置页告警。清单里消失的设备，其会话全部撤销                                                                                                                                                                                       |
| 9   | 邀请和子域名           | `t3x1.<base64url(JSON)>`，约 200 字符，二维码同一字符串。加入时**钉住注册表源与 registry id**；子域名由电脑名派生，**移除后留墓碑、永不再分配**                                                                                                                                                                                                                                                       |
| 10  | 客户端发现与保存       | 新 profile 标记 **`"t3x-device"`**，失败即阻断（不回退 relay、不回退 bearer）。顺序：注册表清单 → URL 校验 → well-known 的 environmentId 等于注册表记录 → 才发通行证。移除的电脑，手机在同步时丢掉其 profile                                                                                                                                                                                          |
| 11  | UI                     | 桌面 Devices 区（仅桌面渲染进程；原"公网地址 + 隧道命令"收进 Advanced）。加入页显示注册表域名要求确认。手机：加入页（扫码或粘贴）+ 设备清单页                                                                                                                                                                                                                                                         |
| 12  | 现有 fork 代码         | `PublicUrls`、`DirectEndpoints` 的 public 路由、`DesktopSelfHost`、`ManagedTunnel` 保留；`AuthAttemptLimiter` 加一条路径；ntfy 并入同一套 compose，`setup.sh` 默认安装，`--no-ntfy` 关闭                                                                                                                                                                                                              |
| 13  | 测试                   | 单元测试逐层；端到端用 compose 绑 `127.0.0.1:18443` + Caddy `tls internal` + `*.t3.localhost`。`*.localhost` 本机 Node / curl / Go 都能直接解析，不需要预载脚本；`::1` 会先被拒再回落到 IPv4，测试强制 IPv4 或同时发布 `[::1]`。CA 靠 `NODE_EXTRA_CA_CERTS` 和 frpc `trustedCaFile`，不改 `/etc/hosts`、不动钥匙串。安全验收分摊进 8.1 / 8.2 / 8.4                                                    |
| 14  | 阶段                   | 6 个阶段：8.0 验证（S）→ 8.1 VPS（L）→ 8.2 server 核心（L）→ 8.3 隧道与无头 CLI（M）→ 8.4 客户端（L+）→ 8.5 打包、文档、端到端（M）。8.3 和 8.4 在 8.2 契约冻结后可并行                                                                                                                                                                                                                               |
| 15  | 威胁模型               | 第 4 节：8 项要求的情形加 10 项补充。最大的两条残余风险：有 `terminal:operate` 的会话能读走那台电脑的设备密钥并冒充它；VPS 被攻破（已接受）                                                                                                                                                                                                                                                           |

### 0.2 关键决策表

| 决策                    | 选择                                                          | 放弃的方案                       | 主要理由                                                                                      |
| ----------------------- | ------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------- |
| 密钥算法                | P-256 / ES256                                                 | Ed25519                          | 现有 DPoP 验证、签名、手机 noble 实现全是 P-256；Secure Enclave 和 WebCrypto 只保证 P-256     |
| 设备密钥与 DPoP 密钥    | 两把                                                          | 手机复用 DPoP 密钥               | 电脑渲染进程本来就是两把，统一一条代码路径；DPoP 密钥可换而不必重新注册                       |
| 设备证明方式            | 一次性通行证                                                  | 挑战-应答                        | 一次往返、server 不存挑战状态；`jti` 加 DPoP 双重绑定足够                                     |
| 通行证端点              | fork 路由 `/oauth/t3x-device`，复用 `auth/http.ts` 导出的助手 | 给 `/oauth/token` 加第二种 grant | 不改契约 schema 和 HttpApi 描述符；仍走同一套 DPoP / 响应头 / 限速                            |
| **客户端 profile 标记** | **新字面量 `"t3x-device"`，缺省实现阻断**                     | 复用 `"t3-connect"` + 装饰层     | `"t3-connect"` 会把任何漏接的设备环境送进官方 managed relay（Cloudflare）并泄露 environmentId |
| 会话授权                | 手机 = 标准 scope 去掉 `access:write` 和 `relay:write`        | 新增 scope / 新会话方法          | 不碰 scope 词表                                                                               |
| **谁能管理设备**        | `desktop-bootstrap` 主体 + 本机 `t3x devices` CLI             | 任何有 `access:write` 的会话     | 配对浏览器是远端 bearer，被盗就等于设备管理权限                                               |
| 注册表运行时            | Node 24 + `node:sqlite`                                       | Go / Python / 带 npm 依赖        | VPS 上只靠 Dockerfile 构建，测试和 server 同一门语言                                          |
| 隧道代理类型            | HTTP vhost（子域名）                                          | 每电脑一个 TCP 端口              | 只开 443；Host 原样透传；子域名即身份                                                         |
| 隧道登录凭据            | `metadatas` 里的自签 ticket，每次操作查实时库                 | OIDC                             | 只依赖文档写明的行为                                                                          |
| frpc 谁来托管           | server                                                        | 桌面主进程                       | 无头也能用；密钥不出 server 进程                                                              |
| 清单陈旧                | 7 天上限                                                      | 无限期沿用                       | 让"撤销"有上界                                                                                |
| 清单同步                | 状态对账（清单没有就撤销）                                    | 事件 / 墓碑流                    | 幂等，离线重启后也正确                                                                        |
| 子域名                  | 墓碑，永不复用                                                | 释放后重分配                     | 阻止旧书签、旧缓存落到另一台电脑                                                              |
| 二维码                  | 镜像里 `libqrencode-tools`，`qrencode -t ansiutf8`            | vendored 编码器                  | 少 600 行；缺工具时回退纯文本                                                                 |
| 浏览器                  | 不加入；继续用配对链接                                        | 给浏览器发设备密钥               | 浏览器存不住私钥，且用户明确要求保持不变                                                      |

### 0.3 承诺与限度（安全模型现在的样子）

**撤销承诺，精确说法**：能连上 VPS 的电脑，在移除后约 1 分钟内撤销该设备的全部会话；连不上 VPS 的电脑，在重新连上时撤销，**最晚 7 天**；超过 7 天未同步的电脑会拒绝新的设备通行证，已经签发的会话最长再活 1 小时（DPoP 会话 1 小时到期，且无法续期）。"移除后 1 分钟全部失效"这句话**不成立**，不要对用户这样说。

**隧道的承诺，精确说法**（8.0 实测后改写）：一台电脑被移除后，它的**隧道最多一个心跳（约 30 秒）内断开**；实测 13 秒和约 30 秒。这段时间里，已经建立的连接和连接池里的连接仍可能服务请求，因为 `NewWorkConn` 只在新建连接时问一次插件，不是立即切断点（Q6）。移除**手机等不开隧道的设备**不受这条影响，靠各台电脑吊销它的会话，适用上面一段的时间。

| 残余风险                                                                     | 为什么                                                                                                                                                                                                      |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **有 `terminal:operate` 的会话能读走那台电脑的设备密钥，冒充它直到它被移除** | `terminal:operate` 就是 server 用户的 shell，能读 `ServerSecretStore` 里的 `fork-device-key`。所有标准 scope 的设备（含配对浏览器、其他电脑）都有它；手机没有 `access:write` 也不改变这一点。这不是 OS 边界 |
| VPS 被攻破（已接受）                                                         | TLS 在 VPS 终止，能读明文，能往名单里加钥匙。两项加固在第 9 节                                                                                                                                              |
| 注册表被替换，或域名 / DNS / 证书被劫持                                      | 钉住 registry id 只能防"填错地址"，防不了控制域名的人（`/v1/info` 是公开的，id 可以抄）。真正的解法是第 9 节的"清单由设备签名"                                                                              |
| 手机密钥是静态加密，不是不可导出                                             | v1 用 SecureStore：系统钥匙串加密保存，签名时解密进 JS 内存；已解锁且被 root 的手机可能被取出。原生 Keystore / Secure Enclave 版是第 9 节第三项                                                             |
| 电脑离线最多 7 天                                                            | 见上，撤销有上界但不是 1 分钟                                                                                                                                                                               |

### 0.4 评审修订对照（16 条决定）

| #   | 决定                               | 落在哪里                                   |
| --- | ---------------------------------- | ------------------------------------------ |
| 1   | 新 profile 字面量 `"t3x-device"`   | Q10、6.2                                   |
| 2   | `/oauth/t3x-device` 同一条流水线   | Q2、3.5、AuthAttemptLimiter 反向测试见 8.2 |
| 3   | 撤销链逐步命名并测试               | Q2「撤销链」、8.2 验收                     |
| 4   | `signAssertion` 不信任请求头       | Q3、3.6                                    |
| 5   | 注册表规范 URL、原子邀请、限速     | Q5、3.3、3.4                               |
| 6   | 只有本机 owner 能管理设备          | Q3、3.9                                    |
| 7   | 7 天陈旧上限                       | Q8、3.8、0.3                               |
| 8   | 隧道每次查实时库                   | Q6、3.7                                    |
| 9   | 钉住注册表、发现顺序、墓碑、钓鱼   | Q9、Q10、3.1                               |
| 10  | 威胁模型升级                       | 0.3、第 4 节                               |
| 11  | 手机密钥的准确描述                 | Q1、0.3、第 9 节                           |
| 12  | ntfy 默认安装并记录加固            | Q12                                        |
| 13  | `qrencode` 代替 vendored 编码器    | Q5、5（8.1）                               |
| 14  | frp 版本由 8.0 选定；新增 3 项验证 | Q7、第 8 节                                |
| 15  | 安全验收分摊进各阶段               | 第 5 节                                    |
| 16  | 去掉 OIDC 备选和证书预热           | Q6、第 8 节                                |

### 0.5 8.0 实测后的第二次修订

2026-11-03，8.0 的实测结果回来，按下表改了正文。第 8 节是结果本身。

| 实测发现                                      | 改动                                                                                        | 落在哪里                 |
| --------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------ |
| frps 把 `X-Forwarded-Proto` 改写成 `http`     | 协议、issuer、DPoP `htu` 改从本机保存的隧道源推导，不读任何请求头；找到并写清三个上游调用点 | 3.11、6.2                |
| XFF 多出一跳（Caddy 容器）                    | 限速键用 `X-T3x-Client-IP`，仅回环对端时认；Caddy 覆盖客户端自带的同名头                    | 3.11、Q6、8.2 验收       |
| `NewWorkConn` 不是立即切断点，`Ping` 才是     | 承诺改成"最多一个心跳（约 30 秒）"；`poolCount = 0`                                         | 0.3、Q6、3.7、4.1 情形 5 |
| frps 调插件没有超时                           | 注册表自己限时、限在途数、独立监听器、healthcheck 和重启策略                                | Q6、3.7、8.1 验收        |
| frpc 日志里没有 "login failed"                | `DeviceTunnel` 只匹配三句，并按固定的 `reject_reason` 分流                                  | 3.7                      |
| `ask` 撤不回已签发的证书                      | 访问控制不靠证书；墓碑子域名上的旧证书无害；`release` 复用证书不是问题                      | Q6、4.2 情形 15、7.2     |
| `*.t3.localhost` 本机直接可解析，`::1` 先被拒 | 去掉 DNS 预载脚本；端到端强制 IPv4 或同时发布 `[::1]`                                       | 7.2、8.5                 |
| frp 钉 v0.71.1，darwin_arm64 签名无弹窗       | 全文改钉 v0.71.1；记录 SHA-256 和镜像 digest                                                | Q7、8a、8.5              |

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

| 角色             | 持有设备密钥的进程      | 能做什么                                                                 |
| ---------------- | ----------------------- | ------------------------------------------------------------------------ |
| 电脑（computer） | 该电脑的 T3 server      | 邀请 / 移除 / 重命名设备；开隧道；用通行证登录别的电脑；校验别人的通行证 |
| 手机（phone）    | 手机 app（SecureStore） | 加入、看清单、用通行证登录电脑；**不能**邀请或移除（注册表直接拒绝）     |
| 浏览器           | 无                      | 不加入；继续用配对链接 + 一次性码（today's pairing links）               |

"桌面 app"不是单独的设备：它的身份就是它自己的 server。桌面渲染进程去连别的电脑时，让本机 server 替它签通行证（第 3.6 节）。

### 1.1 为什么这样切分

- **注册表只管名单，不管会话。** 注册表进程本身不接触 T3 会话 token，也不签任何 T3 会话；会话由各台电脑自己签发。窃取注册表数据库只能得到公钥和邀请哈希（第 4 节）。同一台 VPS 上的 Caddy 终止 TLS，所以控制整台 VPS 的人既能读流量也能加钥匙，这是已接受的限度。
- **TLS 在 VPS 终止**（FORK.md 「自建连接」、`infra/self-host/README.md:15` 已经写明）：VPS 上的人能读到明文流量。本方案不改变这一点；两项加固放在第 9 节，用户已同意先记下。
- **每台电脑一个子域名。** `toHttpBaseUrl` 把 pathname 固定成 `/`，环境只能挂在 origin 根路径上（`packages/shared/src/remote.ts:108-119`，[已核实]，引自 `research/t3-connect-and-mobile-browser.md` A2），所以只能按子域名区分电脑，这也是用户要求 `*.t3.example.com` 的原因。

## 2. 决策记录（Q1–Q12）

每题给出权衡过的选项、推荐和理由，以及依据的现有代码。Q13（测试）、Q14（阶段）、Q15（威胁模型）分别放在第 7、5、4 节。

### Q1 密钥类型和格式；手机要不要复用 DPoP 密钥

| 选项                             | 优点                                                                                                 | 缺点                                                                                                                   |
| -------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| **P-256 / ES256（推荐）**        | 仓库里生成、签名、验证、指纹全是现成的；iOS Secure Enclave、Android Keystore、WebCrypto 都保证支持   | 签名比 Ed25519 长 32 字节（对 JWT 无影响）                                                                             |
| Ed25519                          | 密钥短、签名确定                                                                                     | Secure Enclave 不支持；Android Keystore 和 WebCrypto 的支持要看版本 [推断]；要在 shared / mobile / server 新增代码路径 |
| 手机复用现有 DPoP 密钥           | 少一个 SecureStore 项                                                                                | 见下                                                                                                                   |
| **手机另建一把设备密钥（推荐）** | 角色清晰；DPoP 密钥可以随意更换而不必重新注册；与电脑渲染进程用同一条协议路径（设备密钥 ≠ 会话密钥） | 多一个 SecureStore 项                                                                                                  |

推荐：**P-256；设备密钥与 DPoP 会话密钥分开；公钥用 JWK（`kty/crv/x/y`），设备 id = RFC 7638 指纹**（base64url(SHA-256(`{"crv","kty","x","y"}`))），签名用 JWS ES256 紧凑格式（r‖s）。

为什么分开：通行证里的 `cnf.jkt` 要指向"会话绑定到哪把 DPoP 密钥"。电脑的桌面渲染进程里，设备密钥在 server、DPoP 密钥在渲染进程，**本来就是两把**（Q3）；手机若复用，`cnf.jkt` 等于签名者自己，协议要为手机单开一条分支。统一成"永远两把"最简单。DPoP 密钥以后因为泄露嫌疑需要换，也不必去注册表重新登记。

依据：

- [已核实] 手机 DPoP：P-256 生成 `apps/mobile/src/features/cloud/dpop.ts:168-188`，存进 SecureStore（项名常量 `:89`，读写 `:193`、`:224`），`createDpopProof` 接受外部传入的 `proofKey`（`:238-248`）。
- [已核实] 指纹和验证：`packages/shared/src/dpop.ts:97-104`（`computeDpopJwkThumbprint`）、`:123-206`（`verifyDpopProof`，用 noble `p256.verify`，`format: "compact"`）。
- [已核实] server 的 DPoP 验证 + 重放标记：`apps/server/src/auth/dpop.ts:55-126`。
- [已核实 + 推断] 手机 v1 用 `expo-secure-store`（`apps/mobile/src/features/cloud/dpop.ts:193`、`:224` 就是这样存 DPoP 密钥的）：私钥由系统钥匙串（Android Keystore / iOS Keychain）**静态加密**保存，签名时 noble 在 JS 里解密使用，私钥字节会进入 JS 内存。所以"放在系统钥匙串里"的准确说法是**静态加密，不是不可导出**。要做到不可导出需要原生模块（Android Keystore / iOS Secure Enclave 的 P-256 密钥）和真机测试，列为第 9 节第三项；选 P-256 正是为了留这条升级路径。

### Q2 设备怎么向电脑证明自己；电脑返回什么

先读现状 [已核实]：

- `/oauth/token` 是 `application/x-www-form-urlencoded`，唯一的 grant 是 token-exchange，`subject_token` 是一次性配对码或 bootstrap 凭据（`packages/contracts/src/auth.ts:220-230`）；处理器在 `apps/server/src/auth/http.ts:352-413`：有 `DPoP` 头就先 `verifyRequestDpopProof`（`:365-381`），再调用 `exchangeBootstrapCredentialForAccessToken`（`:383`）。
- 兑换逻辑 `apps/server/src/auth/EnvironmentAuth.ts:955-1015`：带 `proofKeyThumbprint` 时签发 `method: "dpop-access-token"`、**1 小时**的会话（`:970-979`），否则是 30 天的 Bearer。
- 会话由 `SessionStore.issue` 签发：接受 `subject`、`scopes`、`client`（label、deviceType）、`proofKeyThumbprint`、`ttl`（`apps/server/src/auth/SessionStore.ts:377-388`、`:643-749`），落在已有的 `auth_sessions` 表里，`listActive()` 返回的每行带 `subject`（`:960-980`）。**不需要数据库迁移。**
- 重放：DPoP 证明的 `jti` 以 `dpop-proof-<hash>` 的文件标记存在 `secrets/`（`dpop.ts:100-124`），每小时清理一次一天前的标记（`replayMarkers.ts:22-67`）。
- 已连接的 socket 在会话到期时关闭，除非同一把 DPoP 密钥续期（`SessionStore.ts:412-416`、`:1043`，`latestSessionByProofKey` 在 `:504`、`:711`）。

| 选项                                          | 往返 | server 状态          | 重放防护                              | 评价                                                                      |
| --------------------------------------------- | ---- | -------------------- | ------------------------------------- | ------------------------------------------------------------------------- |
| **A. JWT-bearer 通行证（推荐）**              | 1    | 无（只记 `jti`）     | `jti` 标记 + 短 `exp` + DPoP 双重绑定 | 蜂窝网络上少一次往返；与现有 DPoP 机制同构；依赖时钟（±120 秒）           |
| B. 挑战-应答（server 发 nonce，设备签 nonce） | 2    | 要存挑战，并过期清理 | nonce 一次性                          | 不依赖时钟，但多一次往返和一类状态；时钟偏差问题 DPoP 现在已经容忍 300 秒 |

推荐 **A**。通行证（JWT）：

- 头：`{alg: "ES256", typ: "t3x-assertion+jwt", kid: <设备 id>}`。
- 载荷：`{v:1, iss, sub: <设备 id>, aud: <目标电脑的 environmentId>, rid: <registry id>, iat, exp (≤ iat+120), jti, cnf: {jkt: <会话绑定的 DPoP 指纹>}}`。
- 请求同时带 `DPoP` 头，由 `cnf.jkt` 对应的密钥签名；server 校验两者指纹一致。**偷到通行证也换不到会话**，除非同时拥有 DPoP 私钥。
- `aud` 用 environmentId 而不是 URL：同一份通行证在公网、局域网、Tailscale 任一路由上都有效，而且发给 A 的通行证不能拿去 B 重放。

端点：**fork 自己的路由 `POST /oauth/t3x-device`**，而不是给 `/oauth/token` 加第二种 grant。

| 选项                  | 上游改动                                                                                   | 评价                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 扩展 `/oauth/token`   | `AuthTokenExchangeRequest` 变成联合体（contracts）、`http.ts` 处理器分派、HttpApi 描述符   | 每次上游改动都可能冲突                                                                                                                                                                               |
| **fork 路由（推荐）** | 只在 `AuthAttemptLimiter.rejectedCodeStatus`（`:101-112`）加一个 `case`；路由在 `fork/` 里 | 上游零改动；线上格式沿用 RFC 7523 的 `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`、`assertion=`，响应是现成的 `AuthAccessTokenResult`（`auth.ts:232-238`），客户端可以复用现有的响应解码 |

路由挂载位置：[已核实] 路由层在 `apps/server/src/server.ts:771` 的 `layerMakeRoutes`，已有按功能分组的 `HttpRouter.add`（例如 `apps/server/src/guest/http.ts:140`、`:210`、`:232`）。**挂在这里，所以全局的 CORS、请求追踪和 `AuthAttemptLimiter` 中间件对它同样生效**；DPoP 校验、响应头和错误形状复用 `auth/http.ts` 的同一批助手，细节和对照表见 3.5。

会话内容：

| 字段           | 值                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------- |
| `method`       | `dpop-access-token`（1 小时，沿用现有续期机制）                                                       |
| `subject`      | `t3x-device:<kind>:<设备 id>`（`kind` = `computer` / `phone`）                                        |
| `client.label` | 清单里的设备名（"Authorized clients" 里就显示这个名字）；`deviceType` = `mobile` / `desktop`          |
| `scopes`       | 电脑：`AuthStandardClientScopes`（`auth.ts:150-167`）。**手机：去掉 `access:write` 和 `relay:write`** |
| 绑定           | `proofKeyThumbprint = cnf.jkt`                                                                        |

#### 撤销链：今天是哪些函数在做，fork 增加什么

设备从清单里消失（或被移除）后，要同时做到：会话行失效、已发出的 WebSocket ticket 失效、已打开的 socket 关闭、不能续期。核实过的现状 [已核实]：

| 步骤                        | 今天做这件事的函数                                                                                                                                                                                                             | fork 增加                                                                                                           |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| 1 找到该设备的会话          | `SessionStore.listActive()`（`SessionStore.ts:407`，实现在 `:960-980`）返回每行 `subject`                                                                                                                                      | 过滤 `subject` 前缀 `t3x-device:`，并且设备 id 不在新清单里                                                         |
| 2 吊销会话                  | `SessionStore.revoke(sessionId)`（`:417`，实现在 `:984-1000` 附近）：`authSessions.revoke` 写 `revokedAt`，从 `connectedSessionsRef` 删掉，`emitRemoved` 发出 `clientRemoved`                                                  | 对账循环逐个调用；整个"换清单 → 列出 → 吊销"在 `DeviceDirectory` 的信号量内完成                                     |
| 3 已发出的 WebSocket ticket | `SessionStore.verifyWebSocketToken`（`:900-960`）每次都按 sid 读会话行：`row.revokedAt !== null` → `WebSocketSessionRevokedError`（`:943`）。ticket 不自带有效性，所以**吊销行就等于吊销所有已发 ticket**                      | 无新代码。新增测试：吊销后用旧 ticket 升级连接被拒                                                                  |
| 4 已打开的 socket           | `ws.ts:3460`：`Effect.raceFirst(rpcWebSocketHttpEffect, sessions.awaitInvalidation(sessionId, proofKeyThumbprint))`；`awaitInvalidation`（`SessionStore.ts:1043-1100`）在链上任一行 `revokedAt !== null` 时返回，socket 被关闭 | 无新代码。新增测试：连接中吊销 → socket 关闭                                                                        |
| 5 续期                      | 续期就是又一次 `POST /oauth/t3x-device`。`awaitInvalidation` 的后继链只在同一 DPoP 密钥、同一 `subject`、scope 不缩减时延续（`:1080-1096`）；吊销后没有新会话，后继链也就断了                                                  | **签发前**在信号量内重新确认设备仍在清单里（3.5 第 6 步）；对账同一把信号量，所以对账之后不可能再为该设备签出新会话 |
| 6 推送注册                  | `PushNotifier` 订阅 `clientRemoved`（`apps/server/src/fork/push/PushNotifier.ts:341`）删除对应注册；FORK.md 已写明                                                                                                             | 无                                                                                                                  |

没有这把信号量的话会有这个竞态：通行证已通过验证、`SessionStore.issue` 还没执行时，对账跑完——于是已被移除的设备拿到一个新会话。信号量把"验证成员资格 + 签发"与"换清单 + 吊销"串行化。

签发时每次续期都会产生新的一行，旧行到期消失，和 T3 Connect 现在的行为一致 [推断]。能不能用 `replaceActiveForSubjectAndMethod`（`SessionStore.ts:386`）压成每台设备一行，取决于被替换的会话会不会让 socket 掉线（`awaitInvalidation` 的"同一把密钥续期则不关闭"逻辑），列入 8.2 验收，不预先假定。

### Q3 桌面渲染进程连别的电脑

渲染进程没有设备密钥，所以让本机 server 代签。

| 选项                                                    | 评价                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------- |
| 把设备私钥交给主进程 / 渲染进程                         | 破坏"私钥不出 server"，渲染进程是网页代码                              |
| 主进程经 IPC 向 server 要签名（像 `t3xSelfHostBridge`） | 要在主进程里另建一条到 server 的认证通道；无头模式没有这条路           |
| **本机 server 的 RPC `devices.signAssertion`（推荐）**  | 渲染进程已经和本机 server 有一条认证过的连接；授权在 server 里一处检查 |

谁能要求签名（**全部**满足）：

1. **会话主体恰好是 `desktop-bootstrap`。** 这是 `SessionClaims.sub`（`apps/server/src/auth/SessionStore.ts:435-436`）里已签名的声明，不是请求里任何客户端能设置的东西；只有消费桌面 bootstrap 授权才拿得到（签发处 `PairingGrantStore.ts:322-324`、`:443-445`，签发会话时 `subject: grant.subject`，`EnvironmentAuth.ts:884-886`）。先例：`CloudLink.linkProof` 用 `principal.subject === "desktop-bootstrap"` 判断本机 owner（`apps/server/src/cloud/CloudLink.ts:644-648`）。配对链接来的浏览器、其他电脑和手机的设备会话（`subject` 是 `t3x-device:…`）都不是。
2. **不使用任何"没带转发头"的判断。** 第一版设计借用了 `hasForwardedAuthorityHeaders`（`apps/server/src/cloud/linkChecks.ts:42-49`），它只看 `x-forwarded-host` / `x-forwarded-proto`，这两个头是客户端想发就发、想不发就不发的，检查"缺席"毫无防护力。反过来，也不能用对端地址：frpc 把所有隧道流量以 `127.0.0.1` 转进来，从 server 看都是 loopback（`docs/internals/remote.md` 对 T3 Connect 和 Tailscale Serve 也是这个结论）。所以可信信号只有第 1 条，已签名的会话主体。
3. **目标由服务端自己的清单判定。** `audienceEnvironmentId` 必须是 `DeviceDirectory` 当前清单里的**另一台电脑**（kind = computer，不是本机），`dpopThumbprint` 必须是格式合法的 43 字符指纹。清单、不是客户端传来的任何东西，决定能不能签。
4. 本机没有加入服务器、清单已陈旧超过 7 天（Q8）时，一律拒绝。

限速：每分钟 60 次；日志只记设备 id、目标 environmentId 和 `jkt` 前 8 位。无头 server 没有渲染进程，不需要这条 RPC。

续期：渲染进程的会话 1 小时到期，`renewDpopBeforeExpiry`（`packages/client-runtime/src/connection/driver.ts:200-216`）触发重新兑换，所以每小时向本机 server 要一张新通行证。

### Q4 各端的密钥存放；丢了怎么办

| 端            | 位置                                                                                                                                                                       | 丢失 / 损坏                                                                                                                                                                      |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 手机          | `expo-secure-store` 的独立一项（`t3x-device-key-v1`，`WHEN_UNLOCKED_THIS_DEVICE_ONLY`）；不随云备份迁移。**静态加密，签名时解密进 JS 内存，不是不可导出**（第 9 节第三项） | 卸载、清数据、换机 = **新设备**：用新邀请重新加入；旧条目在任一台电脑的 Devices 里显示"很久没出现"，手动移除                                                                     |
| 桌面渲染进程  | **没有设备密钥**；只有现有的 DPoP 会话密钥                                                                                                                                 | 不影响设备身份                                                                                                                                                                   |
| 电脑的 server | `ServerSecretStore`，名字 `fork-device-key`，0600 文件、0700 目录、原子写入（和推送注册同一个模式，`apps/server/src/fork/push/PushRegistrations.ts:22-27`）                | 删了 state 目录 = 新设备；membership 文档一起没了，界面回到"未加入"；旧条目到别的电脑上移除。**state 目录整份拷到另一台机器 = 两台机器共用一把钥匙**，不支持，隧道登录会互相顶掉 |
| 备份 / 导出   | **不提供**                                                                                                                                                                 | 与 `authorized_keys` 的心智一致：丢了就换一把                                                                                                                                    |

macOS 上把私钥放进 Keychain 的"更强"方案被否决：fork 刚刚因为 Keychain 授权弹窗卡住主线程吃过亏（FORK.md 「打包与签名」），而且无头 server 没有 Keychain。

### Q5 VPS 上的注册表

**运行时。** 选项：Node（`node:sqlite`）、Go 单文件、Python 标准库、带 npm 依赖的 Node。选 **Node 24 + 内置模块**：`node:http`、`node:crypto`（ES256 / P-256 / SHA-256 / `timingSafeEqual` 全齐）、`node:sqlite`（`DatabaseSync`；Node 22.13 起不需要实验开关；[实测] `node:24-alpine` v24.18.1 里无标志可用、WAL 正常）。VPS 上的构建只靠 `infra/self-host/registry/Dockerfile`：`FROM node:24-alpine`，`apk add --no-cache libqrencode-tools`（给 `./t3x` 画终端二维码，见下），`COPY *.mjs`，**无 `npm install`**。测试和 server 同一门语言，密码学语义（JWS、指纹）可以做交叉向量测试。

**存储（SQLite，WAL，卷 `/data/registry.db`）**，`CREATE TABLE IF NOT EXISTS` 加 `PRAGMA user_version` 做自己的版本管理（上游不涉及，这是 VPS 上的独立服务，不是 T3 数据库）：

| 表           | 列                                                                                                                                                                                                                                                                                                                                               |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `meta`       | `registry_id`（首次启动随机）、`rev`（整数，任何清单变化 +1）                                                                                                                                                                                                                                                                                    |
| `devices`    | `id`（指纹，主键）、`name`、`name_key`（小写，唯一）、`kind`、`jwk`、`subdomain`（电脑才有，唯一）、`environment_id`、`created_at`（也是**登记代次**，ticket 绑定它）、`last_seen_at`、`last_sync_at`（该设备最近一次带签名的 `GET /devices` 成功，304 也算）、`last_tunnel_at`、`invited_by`、`invite_id`（**唯一**，一个邀请最多生出一个设备） |
| `invites`    | `id`、`secret_hash`（SHA-256）、`kind`（`computer` / `phone` / `any`）、`created_by`（设备 id 或 `cli`）、`expires_at`、`used_at`、`used_by`                                                                                                                                                                                                     |
| `seen_jti`   | `(device_id, jti)`、`exp`；超过窗口就清                                                                                                                                                                                                                                                                                                          |
| `tombstones` | `subdomain`（主键）、`device_id`、`removed_at`。**永不删除**：移除电脑时写入；分配子域名时同时检查 `devices` 和 `tombstones`；只有管理员 `./t3x release <子域名>` 才能回收                                                                                                                                                                       |

移除设备 = 在一个事务里删行 + 写子域名墓碑 + `rev+1`（设备行本身不留墓碑，对账是"状态差"，见 Q8）；`DELETE` 的响应带 `removedAt` 和新的 `rev`。

**API**（全部 JSON，经 Caddy 挂在 `https://<域名>/v1/`；细节见第 3.3 节）：`GET /v1/info`（公开）、`POST /v1/join`、`GET /v1/devices`、`POST /v1/invites`、`GET /v1/invites`、`DELETE /v1/invites/{id}`、`DELETE /v1/devices/{id}`、`PATCH /v1/devices/{id}`（改名）。

**请求认证。** DPoP 式，但用自己的 `typ`：`T3X-Proof: <JWS>`，载荷 `{htm, htu, iat, jti, bh}`。`htu` 是**规范 URL = 注册表配置的公网源（`.env` 的 `T3X_PUBLIC_ORIGIN`，由 `setup.sh` 写入） + 实际请求行里的路径 + 查询串**；**绝不从 `Host`、`X-Forwarded-Host`、`X-Forwarded-Proto` 推导**（Caddy 多层代理下这些头可以重复或被伪造，会造成验签绕过或合法请求全拒）。`bh` 是请求体的 SHA-256。不直接复用 DPoP 证明，是因为 `normalizeDpopHtu` 会丢掉查询串，而且 DPoP 不覆盖请求体（`packages/contracts/src/auth.ts:247-252` 的注释说明了 `htu` 不含查询串）。时间窗 ±120 秒，`(device_id, jti)` 防重放。

**注册表只在 compose 内网监听，Caddy 是它唯一的入口**（`expose`，不写 `ports`）。日志里仍然把 `Host` 规范化后记下来用于排查：小写、去掉端口、IDN 转 punycode（`url.domainToASCII`）、截断到 255 字符，**只用于日志，不参与任何判断**；与配置的域名不符就记一条警告。

**限速。** Caddy 在最前面，用 `header_up X-T3x-Client-IP {remote_host}` **覆盖写入**客户端 IP（`/v1/*` 路由和 vhost 站点都要写；注册表只在内网，只有 Caddy 能写这个头，请求自带的同名头被覆盖）。**所有未认证的端点都限速**：`/v1/info` 60 次 / 分钟 / IP；`/v1/join` 失败 10 次 / 10 分钟 / IP，且被限速期间**不检查邀请**；验签之前的任何请求 300 次 / 分钟 / IP（防止拿签名校验耗 CPU）。已认证请求 120 次 / 分钟 / 设备；创建邀请 10 次 / 小时 / 设备；未使用的邀请最多 20 个。邀请兑换用**条件 UPDATE**：`UPDATE invites SET used_at=?, used_by=? WHERE id=? AND used_at IS NULL AND expires_at>? AND secret_hash=? AND kind IN (?, 'any')`，与插入设备行在同一个事务里，`changes() == 1` 才算成功；`devices.invite_id` 的唯一约束是第二道保险。不做 SELECT 之后再 DELETE。

**`./t3x`。** 一个 bash 脚本，等价于 `docker compose exec registry node /app/cli.mjs "$@"`；CLI 与 HTTP 处理器共用同一个模块，直接操作数据库（root 权限即管理权限，不走签名）。命令：`invite [--kind computer|phone|any]`、`devices`、`revoke <名字|id>`、`invites`、`rename <名字> <新名字>`、`release <子域名>`、`ntfy`、`info`。**二维码**：CLI 在容器里执行 `qrencode -t ansiutf8`，输入就是邀请字符串；容器里没有 `qrencode`（镜像被改过）时，回退只打印邀请字符串，并给出明确错误"二维码工具不可用，请直接复制上面的字符串"。不再 vendored 二维码编码器。`setup.sh` 在宿主机上只调用 `./t3x invite`，不依赖宿主机装了 `qrencode`，所以 macOS 和 Linux 的宿主机行为一致。

### Q6 隧道

先读现状 [已核实]：`infra/self-host/frps.toml:1-14` 是 token 认证 + TLS 强制 + 只允许 `remotePort = 7001`；`docker-compose.yml:13-24` 发布 7000；`Caddyfile:6-19` 把整个域名反代到 `frps:7001`。frp 镜像今天钉在旧的 0.61 系列（`docker-compose.yml:13`）；本方案改钉 v0.71.1（Q7）。下面标 **[实测]** 的结论来自阶段 8.0 在本机用 frp v0.71.1、Caddy 本地 CA、`node:24-alpine` 跑出来的结果（第 8 节）。

| 方面           | 选项                                                             | 选择                                                                                                                                                                                                                                                                                  |
| -------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 控制通道经 443 | frpc `transport.protocol = "wss"` → Caddy → frps                 | **wss**：外层 TLS 一直开启，校验对象是 Caddy [实测：frpc 信任 Caddy 本地根 CA 后 `login to server success`，frps 没开 `transport.tls.force`]。frps 的 websocket 路径是 `/~!frp`（v0.71.1 `pkg/util/net/websocket.go`）                                                                |
| 数据面         | HTTP vhost（`subDomainHost` + `subdomain`）／每电脑一个 TCP 端口 | **HTTP vhost**：只开 443；`subDomainHost` 支持通配 DNS [实测：`http proxy listen for host [a.t3.localhost]`]；SSE 首字节 2.5 ms 到达，WebSocket 101 并能 echo，没有被缓冲                                                                                                             |
| 怎么检查登录   | `auth.method = "token"` 共享令牌／OIDC／服务端插件               | **服务端插件**（`httpPlugins`，`ops = ["Login","NewProxy","Ping","NewWorkConn"]`）[实测：四个 op 的字段与文档一致；`Login.content.metas.t3x_ticket` 到得了插件，`Ping`/`NewProxy`/`NewWorkConn` 里在 `content.user.metas`；`proxy_name` = `<user>.<name>`，如 `deviceid01234567.t3x`] |

**登录凭据和重连。** 方案：

1. server 在每次启动 frpc 时生成配置，`metadatas.t3x_ticket` = 电脑自己用设备密钥签的 ticket：`{v:1, kid: 设备 id, sub: 子域名, gen: 登记代次, iat, exp: iat+24h}`，`user = <设备 id 前 16 位>`。
2. 注册表的 `Login` 插件**每次**查实时库（不缓存）：签名合法（用库里的公钥）、`exp` 未过、`kid` 对应的设备行存在且是电脑、`sub` 等于该行的子域名、`gen` 等于该行的 `created_at`、`rid` 匹配、`user` = 设备 id 前 16 位；通过后记下 `run_id → 设备 id`。**设备行被删了，不管 ticket 还剩多久都登不上**；移除后同一把密钥带新邀请重新加入会得到新的 `created_at` 和新的子域名，旧 ticket 作废。
3. frpc 自动重连时用的是同一份配置，所以 ticket 的有效期必须覆盖重连：24 小时。server 每 12 小时重新生成配置并重启 frpc，重启代价是隧道断约一秒，T3 客户端自带重连。**为什么 24 小时可以接受**：有效期只决定"被偷的 ticket 能用多久"，而移除靠的是实时查库，不靠 ticket 过期；偷到 ticket 还需要设备仍然登记着，且后果限于在真电脑离线时占用它的子域名（4.2 情形 18）。8.0 没有发现需要缩短它的理由。
4. 登录被拒后 frpc 不退出：`loginFailExit = false` 时一直重试，间隔逐步涨到约 20 秒 [实测：约 2、4、9、19、20 秒]。`DeviceTunnel` 怎么识别各种拒绝，见 3.7 的日志表。

备用方案：若以后发现 `metadatas` + 插件走不通，再评估 frp 的 OIDC 登录。8.0 已证明现在这条路走得通，不设计。

**移除一台电脑时，隧道什么时候断。** 这是 8.0 实测后改得最多的一段：

- `Login` 与 `NewProxy`：设备不在名单里就拒绝；**每次都查实时库**。
- **心跳必须显式写** [实测]：TCPMux 默认开着，不写 `transport.heartbeatInterval` 时跑 25 秒没有任何 `Ping`；写 `heartbeatInterval = 30` 后每 30.0–30.006 秒一次，登录成功的当下还会先有一次。所以生成的配置必须写 `transport.heartbeatInterval = 30`、`transport.heartbeatTimeout = 90`，frps 侧 `transport.heartbeatTimeout = 90`。
- **`Ping` 被拒是真正的切断点** [实测]：把插件改成拒绝后，下一次 `Ping` 在 13.0 秒时被拒，frpc 打出 `pong message contains error: <reason>`，18 ms 后重登又被拒（`connect to server error: <reason>`）。另一次观察到约 30 秒。所以上界是**一个心跳间隔，约 30 秒**。
- **`NewWorkConn` 不是立刻生效的切断点** [实测]：它只在**新建** work conn 时问一次插件。池里已有的和用完放回去复用的连接，下一次用户请求直接用，不再问插件。实测默认 `poolCount = 1`，拒绝之后紧接着的两次请求仍然是 HTTP 200（25 ms 和 9 ms）；池子用完之后的请求才被拒，用户看到 frps 自己的 404 页面。HTTP keep-alive 复用同理。**不要把"NewWorkConn 被拒 = 马上没有数据面"写进任何承诺。**
- **`poolCount` 取 0**（默认是 1）：池里就没有预先建好的连接，每条新的用户连接都要先过一次 `NewWorkConn`，所以撤销之后**新连接**立刻被拒，窗口只剩"已经建立的连接"。代价是每条新连接多一次到注册表的往返（compose 内网，预计几毫秒）。8.0 只测了默认值 1，**0 的效果和延迟留到 8.1 实测**；若延迟明显（新连接首字节 > 50 ms），退回 1，承诺不变（本来就按一个心跳算）。
- **对用户的承诺**：电脑被移除后，**隧道最多一个心跳（约 30 秒）内断开**；这段时间里已经建立的连接和池里的连接仍可能服务请求。
- **手机等设备不受这条影响**：它们不开隧道。移除手机靠各台电脑吊销它的会话（能连 VPS 的约 1 分钟，其余最晚 7 天，见 0.3 和 Q8）。

`NewProxy` 的约束（插件逐项检查）：`proxy_type == "http"`；`subdomain` 必须等于该设备注册的子域名；`custom_domains`、`locations`、`http_user` 必须为空；每台设备同时只有一个代理；`user` 必须等于设备 id 前 16 位。所以电脑 A 无法为电脑 B 的子域名注册代理（威胁表第 7 行）。

**插件没有超时，注册表必须自己设时限。** [实测 + 源码：v0.71.1 `pkg/plugin/server/http.go` 的 `http.Client` 没有 `Timeout`，`manager.go` 的 `newPluginRequestContext()` 用 `context.Background()`]

| 注册表的状态 | frps / frpc 的表现 [实测]                                                                                                                                                                                                                                                                                                                                                                             |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 进程挂了     | **失败关闭**：`Login` → `connect to server error: send Login request to plugin error`；`Ping` → `pong message contains error: send Ping request to plugin error`；`NewWorkConn` → `StartWorkConn contains error: send NewWorkConn request to plugin error`，用户请求得到 frps 的 404（那次等了 5.4 秒）。`NewProxy` 与 `Login` 走同一个 `handleMutableContent`，宕机时 `Login` 已先失败，没有单独打到 |
| 变慢         | **堵住，不是放行也不是拒绝**：`Login` 插件睡 8 秒，frpc 8 秒后才 `login to server success`。没有任何一层会替你掐断                                                                                                                                                                                                                                                                                    |

所以：

1. 注册表对每个插件请求**自己限时**：1.5 秒内没答完就回 `{"reject": true, "reject_reason": "t3x:busy"}`（失败关闭）；在途插件请求超过 64 个时立即回 503（非 200，frps 同样当失败）。
2. 插件监听器是**独立的 `http.Server`**（`:8081`，只在 compose 内网），不和公网 API 共用队列。处理函数只做 O(1) 的索引读和一次 ECDSA 验签，**不在插件路径上写库**：`last_tunnel_at` 之类写入放进内存 Map，每 30 秒批量落盘。`node:sqlite` 的 `DatabaseSync` 是同步的，无法中途取消，所以保证来自"处理函数足够短 + 库的 `busy_timeout` 设成 200 ms"，而不是来自定时器；定时器只限制排队。
3. compose 里给注册表加 `healthcheck`（`node /app/healthcheck.mjs`：对插件端口 `/health` 做一次 `SELECT 1`，1 秒内没答算失败，间隔 10 秒、重试 3 次）和 `restart: unless-stopped`；`frps` 和 `caddy` 用 `depends_on: condition: service_healthy`。
4. 注册表重启时所有隧道都会在下一次 `Ping`/`Login` 失败，frpc 约 20 秒内自己重连；README 写明"重启注册表会让隧道断几十秒"。
5. 若 8.1 的负载测试显示公网 API 打满时插件延迟明显变长（p99 > 100 ms），把插件挪到 `worker_threads` 里、用独立的只读连接。现在不做。

**Caddy。**

```
{
	email {$ACME_EMAIL}
	on_demand_tls { ask http://registry:8082/ask }
}
{$T3X_DOMAIN} {
	@frp path /~!frp
	handle @frp { reverse_proxy frps:7000 }
	handle /v1/* {
		reverse_proxy registry:8080 { header_up X-T3x-Client-IP {remote_host} }
	}
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

- 注册表的规范公网源来自 `.env` 的 `T3X_PUBLIC_ORIGIN`（`setup.sh` 根据域名写入），compose 把它传给注册表容器；请求里的 `Host` 与它无关（Q5）。
- **`ask` 只能挡住还没签发过证书的名字，撤不回已经签发的** [实测]：从名单里删掉后，握手仍然成功（2 ms，不再问 `ask`）；没有隧道时 frps 返回自己的 404 页面，TLS 不报错。从未允许过的名字，`ask` 返回 403，握手以 `tlsv1 alert internal error` 失败。所以访问控制靠 frps 插件和电脑自己的鉴权，**不靠证书**。墓碑子域名上的旧证书无害：没有隧道时 404。`./t3x release` 之后子域名被复用，证书也一起复用，这不是问题：证书和私钥都在 VPS 上，不在设备手里。
- `ask` 端点（`registry:8082/ask?domain=…`）只对 `<已登记子域名>.<域名>` 返回 200，其余一律 403；`ask` 只能做常数时间的数据库查询。`ntfy.` 和根域名是显式站点，Caddy 自己申请证书，不走 `ask`。显式站点和 `https://` catch-all 共存、没有被 catch-all 抢走 [实测：`t3.localhost/v1/info` 仍是注册表，`/` 仍是 Caddy 自己的 404]。
- 首次访问某台电脑时要现场申请证书。本地 CA 下 38 ms，第二次握手 3 ms；Let's Encrypt 的真实耗时 8.0 测不到（用的是 `local_certs`），README 里写"首次可能慢几秒"。不做预热。
- Let's Encrypt 有频率限制（同一注册域名每周 50 张），个人使用不会触及；README 里写一句。
- frps 与 Caddy 之间是 compose 内网上的明文 ws / http（宿主机端口都不发布），不需要 `transport.tls.force` [实测]。
- **`X-Forwarded-Proto` 不可信，`X-Forwarded-For` 多一跳** [实测]。issuer、DPoP `htu`、"是不是 https"和限速键怎么办，见 3.11。

### Q7 frpc 在哪里运行，怎么分发

| 选项                               | 评价                                                                                                                                                                                                                         |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 桌面主进程（扩展 `ManagedTunnel`） | `ManagedTunnel` 现成（退避、进程组清理、输出分类，`apps/desktop/src/selfHost/ManagedTunnel.ts:60-63`）；但无头 `t3x` 用不了，ticket 必须由 server 签，要跨进程传                                                             |
| **server 托管（推荐）**            | 无头和桌面同一份代码；签名在进程内；先例：server 已经托管 `cloudflared`（`apps/server/src/cloud/ManagedEndpointRuntime.ts`，崩溃退避和日志分类，经 `research/t3-connect-and-mobile-browser.md` A4 引用）[推断：未重读该文件] |

推荐 server 托管：`fork/deviceKeys/DeviceTunnel.ts` 用 Effect 的 `ChildProcessSpawner` 起 frpc（配置写进 `<stateDir>/fork-tunnel/frpc.toml`，0600，不放在命令行里），退避 1→60 秒、稳定 30 秒后复位（沿用 `restartDelayMs` 的数字），`Scope` 关闭就杀进程。桌面 app 退出时 server 随之退出，frpc 随之停止，"随 app 启停"成立。`ManagedTunnel` 一行不改，继续服务 Advanced 里的"自定义隧道命令"。

**打包。** frp 钉 **v0.71.1**（2026-10-14 发布的最新稳定版），frps 与 frpc 同版本；SHA-256、镜像 digest 记在 8a：

- 版本、各平台归档 URL 和 SHA-256 写在一个 fork 文件（`packages/shared/src/forkFrp.ts`）。darwin_arm64 的值见 8a；其他平台打包时从同次发布的 `frp_sha256_checksums.txt` 取，写进 `scripts/fork-fetch-frp.ts`。`docker-compose.yml` 里 frps 镜像写成 `fatedier/frps:v0.71.1@sha256:48720c81…3a18`（完整 digest 见 8a），测试读取它保证标签与 `forkFrp.ts` 一致。
- **0.61 系列到 v0.71.1 之间和本方案有关的变更**（8.0 汇总）：0.61.2 起 frpc 代理命令行也支持 `metadatas`（toml 里的 `metadatas.*` 本来就有）；0.68.1 修了 `httpUser` + `routeByHTTPUser` 的鉴权绕过（本方案要求 `http_user` 为空，不踩）；0.69.0 加了 `transport.wireProtocol`，默认仍是 v1，不设置就是旧线协议；0.70.0 把 WebSocket / WSS 隧道载荷改成二进制帧（实测经 Caddy 的 `/~!frp` 仍然登录成功）；0.70.1 起 HTTP vhost 不再接受 `Upgrade: h2c`（普通 HTTP/1.1 和 WebSocket upgrade 实测仍通）；0.71.0 堵住了 `subDomainHost` 下 `customDomains` 的大小写绕过。
- `scripts/fork-dist-mac.ts`（fork 自己的脚本）在 `build-desktop-artifact.ts --target dir` 之后、`@electron/osx-sign` 之前，下载归档、核对 SHA-256、把 `frpc` 放进 `.app/Contents/Resources/bin/`。FORK.md 描述的流水线本来就由内向外签名所有嵌套二进制，并逐个用 `file` 找出 Mach-O 校验（FORK.md 「打包与签名」第 2、3 条），frpc 自动被覆盖。[实测] v0.71.1 官方 darwin_arm64 用 `codesign --options runtime` 签名（`T3 Extend Code Signing`）后 `--verify --strict` 通过，`frpc -v` 打印 0.71.1，`flags=0x10000(runtime)`，**没有钥匙串弹窗**，不需要额外 entitlement。
- 桌面后端配置通过环境变量 `T3X_FRPC_PATH` 告诉 server 去哪找（`apps/desktop/src/backend/DesktopBackendConfiguration.ts`，上游文件，一行 `// fork:`）。
- 无头：按顺序找 `T3X_FRPC_PATH` → `<T3 home>/bin/frpc` → PATH；`t3x devices tunnel install` 从同一张表下载并校验后放进 `<T3 home>/bin/`。

### Q8 电脑上的设备清单同步

| 项           | 决定                                                                                                                                                                                                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 间隔         | 启动后立即一次，之后每 60 秒（`Schedule.spaced`），外加 RPC `devices.refresh` 立即同步一次。请求带 `If-None-Match: "<rev>"`，没变化时 304，几乎零流量                                                                                                                                                       |
| 持久化       | `ServerSecretStore` 文档 `fork-device-list`：`{rev, fetchedAt, devices[]}`，原子写入；不建 SQL 表，所以不需要数据库迁移（模式与推送注册一致，`apps/server/src/fork/push/PushRegistrations.ts:22-27`）。`fetchedAt` 只在**同步成功**（200 或 304）时更新                                                     |
| 陈旧上限     | `now - fetchedAt ≤ 24 小时`：正常。`> 24 小时`：`devices.status` 返回 `staleness: "warn"`，设置页 Devices 区显示警告。`> 7 天`：`staleness: "expired"`，**拒绝新的设备通行证**（`/oauth/t3x-device` 返回 503 `list_expired`），直到同步成功。本机使用和配对链接不受影响，已有会话到期（≤ 1 小时）后不能续期 |
| 局域网       | 7 天内，局域网上的设备照常用最后一份清单换会话；这是"VPS 挂了家里还能用"的前提                                                                                                                                                                                                                              |
| 撤销         | 每次同步成功后做一次**状态对账**（Q2「撤销链」）：`subject` 以 `t3x-device:` 开头、设备 id 不在新清单里的会话全部撤销。幂等，离线期间被移除、server 重启之后第一次同步也正确                                                                                                                                |
| 自己被移除   | 注册表返回 `device_unknown`，或清单里没有自己的 id：停隧道、删除 membership 和密钥、撤销所有 `t3x-device:*` 会话，界面显示"这台电脑已被移出服务器"，状态回到"未加入"                                                                                                                                        |
| 移除时的提示 | 移除一台设备后，对话框列出**还没同步过这次移除的电脑**：注册表对每台电脑记 `last_sync_at`（该电脑每次带签名的 `GET /devices` 成功时更新，304 也算），`last_sync_at < removedAt` 的就是（`removedAt` 由 `DELETE` 的响应给出）。这些电脑最晚在 7 天内撤销；对话框写明"它们重新连上 VPS 后才会撤销"            |

### Q9 邀请和子域名

**邀请字符串**：`t3x1.` + base64url(UTF-8 JSON)，约 200 字符：

```json
{
  "v": 1,
  "o": "https://t3.example.com",
  "r": "<registry id, 8 字符>",
  "i": "<邀请 id, 11 字符>",
  "s": "<密钥, 22 字符=128 位>",
  "k": "c|p|a",
  "e": 1793000000
}
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
5. **分配后不再变，移除后也不再分配**（改名只改显示名）。移除电脑时子域名写入墓碑（Q5 的 `tombstones`），分配新名字时同时避开 `devices` 和 `tombstones`；同一台电脑被移除后重新加入会得到 `mac-2`。管理员可以在 VPS 上显式 `./t3x release <子域名>` 回收。所以旧书签、旧缓存打到的永远不会是另一台电脑。手机同步到清单里没有某台电脑时，丢掉它的 profile 和缓存令牌（Q10）。

### Q10 客户端发现和保存

**为什么不再复用 `"t3-connect"`。** 第一版想复用这个标记以便少改上游。评审指出并经核实：它在 `resolver.ts:148` 无条件进 `remote.authorizeDpop`（官方 managed relay 客户端），而 HTTP 请求和 socket 续期还有两条独立入口 `authorizeDpopHttp`（`state/environmentHttpAuth.ts:145-165`）和 `renewDpopBeforeExpiry`（`connection/driver.ts:200-216`），**都只按 environmentId 分派**。任何漏接（同步竞态、重装、索引损坏）都会把设备环境交给官方 relay，向 Cloudflare 泄露 environmentId。所以改用新字面量，并让**缺省实现就是阻断**。

**接入点**（逻辑全在 fork 模块 `packages/client-runtime/src/fork/deviceKeys/`，上游每处只加一个调用或一个分支）：

| 位置                                                           | 做什么                                                                                                                                                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `connection/catalog.ts:26`（profile schema）                   | `authorization` 的字面量加 `"t3x-device"`                                                                                                                                                                                                      |
| `connection/model.ts`（`PreparedConnection`）                  | 加可选字段 `authorizer?: "t3x-device"`。**它是 resolver 在读到 profile 的那一刻盖的章**，下游不必再靠 environmentId 去猜                                                                                                                       |
| `connection/resolver.ts:148`                                   | 在 `t3-connect` 分支之前加一条：`profile.authorization === "t3x-device"` → 只调用 `DeviceKeyAuthorization.prepare(…)`，返回的 `PreparedConnection` 带 `authorizer: "t3x-device"`。**它失败就整个失败**，没有 `orElse`，没有 bearer、没有 relay |
| `state/environmentHttpAuth.ts:145`、`connection/driver.ts:200` | 遇到 `prepared.authorizer === "t3x-device"` 走 fork 的 `authorizeHttp` / `renew`；其余分支原样。device 标记缺失时 DPoP 分支仍会走原来的 relay 路径，所以**只能依赖 resolver 盖章**，这点由测试把守（见 8.4）                                   |
| 其他直接调用 `RemoteEnvironmentAuthorization` 的地方           | `state/session.ts:177`、`deviceHubAccess.ts:35`、`orchestration.ts:62`、`threads.ts:204`、`peerPairingCode.ts:44` 等。**8.4 开工第一步先 `grep` 列出全部**，逐个判断是否经过 `environmentHttpAuth`；列表和行数写回 6.2                         |
| `DeviceKeyAuthorization` 服务                                  | `Context.Reference`，**缺省值恒返回 `ConnectionBlockedError{reason:"configuration"}`**。只有 web / mobile 的 runtime 在各自一处提供真实实现；没提供、实现读不到设备数据、密钥损坏、membership 缺失，全部落到阻断                               |

**routes.ts 的决定**（逐处）：

| 位置                                        | 决定                                                                                                                                                                                                      |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mergeLearnedRoutes`（`routes.ts:215-229`） | 当前活跃路由的 profile 是 `t3x-device` 时，**学到的路由继承 `"t3x-device"`**，且不共用凭据（`sharedCredential` 为空）：局域网 / tailnet 路由同样走通行证，通行证的 `aud` 是 environmentId，换路由不用重签 |
| `sendsTokenInClear`（`routes.ts:343`）      | 对 `t3x-device` 返回 `false`，与原来对 `t3-connect` 的处理一致：会话是 DPoP 绑定的，明文 HTTP 上被偷到的令牌没有私钥无法使用；通行证 120 秒有效、一次性、不含秘密                                         |
| `routesAfterRemoving`（`routes.ts:425`）    | 学来的 `t3x-device` 路由，当且仅当被移除的**已保存路由**也是 `t3x-device` 时一并移除；绝不被 `RelayConnectionTarget` 的移除牵连，也不被 `credentialConnectionId` 分支误删                                 |
| `connectionRouteKind`                       | 不改：URL 推断，`https://<子域>.<域名>` 是 `public`，LAN 是 `lan`                                                                                                                                         |

**不能标成 relay / T3 Connect 的地方**：设备环境的 target 一律是 `BearerConnectionTarget`，所以 `presentation.ts:113,139`、`supervisor.ts:276,590`、`registry.ts:1032` 按 `RelayConnectionTarget` 判定的分支天然不会命中。`connectionMethod`（`baseSchemas.ts:300`，随 socket URL 发给 server，`ws.ts:706`）和错误映射（`connection/errors.ts:183-189`）由 fork 的授权模块**显式传 `"direct"`**，不要沿用 `authorization/service.ts:216` 里写死的 `"relay"`。8.4 加测试：设备环境的任何失败，`presentConnectionDiagnosis` 的 hop 都不是 `relay`，`hasRelayRoute` 为 false，没有任何 URL 指向官方 relay。

**列出电脑与获得会话**：

| 端           | 数据来源                                                                      | 刷新时机                                                                     |
| ------------ | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 手机         | 直接向**钉住的**注册表 `GET /v1/devices`（带 `If-None-Match`）                | App 回到前台（距上次 ≥ 30 秒）、设备页手动下拉、刚加入之后；不做后台定时轮询 |
| 桌面渲染进程 | 本机 server 的 RPC 流 `devices.subscribe`（先给快照，之后只在清单变化时推送） | 订阅期间无轮询；server 自己每 60 秒同步                                      |
| 无头 / CLI   | `t3x devices list`                                                            | 按需                                                                         |

**发现顺序与钉住**（手机和桌面渲染进程都一样，fork 授权模块里一个函数，顺序写死）：

1. 加入时钉住 **注册表源**（`https://host[:port]`）和 **registry id**（`/v1/info` 的 `registryId` 必须等于邀请里的 `r`），连同设备密钥存进 SecureStore / `ServerSecretStore`。之后所有注册表请求只发往钉住的源，响应里的 `registryId` 不等就丢弃。
2. 取清单（带签名的 `GET /devices`）。
3. **URL 检查**：电脑的 URL 必须是 `https://`、无用户信息、无路径、端口等于钉住的公网端口，主机名恰好是**钉住的域名下的一级子域名**。不满足的条目直接忽略，不发任何东西。
4. `GET <url>/.well-known/t3/environment`（匿名，现有模式 `authorization/service.ts:141-158`），返回的 `environmentId` 必须等于注册表给这台电脑记录的 `environmentId`。注册表还没有记录（电脑刚加入、尚未报告）则保持"待连接"，不连。
5. 只有走到这里，才签通行证并 `POST /oauth/t3x-device`。

**保存与同步到连接注册表**：每台电脑 `EnvironmentRegistry.register(BearerConnectionRegistration)`（`registry.ts:107-110`），profile 的 `authorization: "t3x-device"`，`credential` 是占位（resolver 在读凭据之前就走 fork 分支，永远读不到）。清单里有、本地没有 → `register`；清单里没有、本地索引里有 → `registry.remove(environmentId)`（`registry.ts:121`）**并清掉该环境的 fork 数据（缓存的会话令牌）**；URL 变了 → 替换路由。"设备管理的环境"索引存在每个客户端本地（web：fork store；手机：AsyncStorage），**但安全不依赖它**：漏掉索引只会让一台已移除的电脑多留一个本地条目，它的 profile 仍是 `t3x-device`，仍然只会走 fork 授权（该授权在清单里找不到它就阻断）。用户自己手动添加的环境不在索引里，绝不被同步删除。

**局域网**：连上公网路由后，电脑上报的 LAN / tailnet 地址由 `mergeLearnedRoutes` 作为学习路由加进来，排序优先于 public（`ROUTE_KIND_RANK`，`routes.ts:105`），回到家自动切回局域网 [已核实：FORK.md 「自建连接」第 236 行]。

### Q11 UI（概述；细节和验收见 8.4）

- **桌面**：Settings → Sharing & access 里新增 "Devices" 区，位置在原来 `SelfHostSettings` 的位置（`ConnectionsSettings.tsx` 里把那一处渲染换成 `DevicesSettings`，由它在 "Advanced" 折叠区里渲染 `SelfHostSettings`，只改一行）。**只在桌面渲染进程里渲染**（有 `desktopBridge`，且当前环境是本机主环境）；服务端同样只对 `desktop-bootstrap` 会话开放这些 RPC，所以普通浏览器和远程环境页看不到它。
  - 未加入：说明一句 + "Join my server" 按钮 → 对话框：电脑名、邀请粘贴框。粘贴后**先显示邀请指向的注册表域名，要求用户确认**："你要加入 `t3.example.com`。这是你自己的服务器吗？"含非 ASCII 的域名同时显示 punycode。确认后才向它发请求。
  - 已加入：顶部一行"已连接 t3.example.com · 这台电脑：`https://mac.t3.example.com`（在线 / 离线）"；设备清单（名称、种类、最近出现的相对时间、移除按钮）；"Invite a device" 按钮 → 对话框显示二维码 + 字符串 + 复制 + "有效至 14:32"（**绝对时间，不做每秒走字的倒计时**）；待用邀请列表里有"取消"。
  - 清单 24 小时未同步：区块顶部显示警告"这台电脑已 N 小时没连上你的服务器；超过 7 天将不再接受新设备登录"。
  - 移除设备：确认后，对话框列出**还没同步过这次移除的电脑**（Q8），写明"它们重新连上服务器后才会撤销"。
  - Advanced（折叠）：原来的"自定义公网地址 + 隧道命令"。
  - 命令面板里加 "Invite a device" 动作（同样只在桌面渲染进程）。
- **手机**：Settings 里一个 "Server devices" 入口，两个页面：加入页（相机扫描 + 粘贴 + 设备名；同样**先显示域名并确认**）、设备清单页（只读列表、最近出现、"离开此服务器"）。环境列表里托管的环境显示"由你的服务器管理"，移除入口换成"离开此服务器"，避免用户删了又被同步回来。
- **组件**：只用 `apps/web/src/components/ui` 现有的 Button、Dialog、已有的 `qr-code.tsx`；不用 `className` 重新着色。
- **多语言**：新建 `catalogs/zh-Hans/devices.ts`（web）和 mobile 对应文件；验收按用户的审美记忆：中文字不要显得过大、界面要有层次、守住上游风格，**中英文对照截图**。

### Q12 现有 fork 代码怎么处理

| 现有代码                                                      | 变化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/environment/PublicUrls.ts`                   | **保留**，服务 Advanced 的自定义地址。新增：`list` 再读一个由设备 membership 写入的小文件 `device-public-url.json`（同目录，原子写入，每次调用重新读），这样电脑自己的 `https://<子域>.<域名>` 也作为 `public` 端点上报，已用配对链接配对的浏览器 / 设备也能学到。不引入 layer 依赖                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/server/src/environment/DirectEndpoints.ts:167-169`      | **不变**                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/desktop/src/selfHost/DesktopSelfHost.ts`                | **保留**，界面挪进 Advanced。生成配对二维码时要能选到设备地址：`serverExposure.getAdvertisedEndpoints` 追加的是 `DesktopSelfHost.publicUrls`，需要让它也包含设备地址（读同一个文件，路径是否与 server 的 state 目录一致要在 8.4 核对）[推断]                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/desktop/src/selfHost/ManagedTunnel.ts`                  | **不变**，继续只管 Advanced 里用户自己写的隧道命令。与 `DeviceTunnel` 同时存在不冲突（不同 frpc 实例、不同代理名），界面在两者都开时提示一句                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `apps/server/src/auth/AuthAttemptLimiter.ts:101-112, 125-139` | `rejectedCodeStatus` 加一个 `case "/oauth/t3x-device": return 401`（带 `// fork:`）。今天它只覆盖 `/oauth/token`、`/api/auth/browser-session`、`/oauth/mcp/decision` 三条，漏了这条就等于允许无限撞通行证。同一个函数驱动检查和失败计数。另外 `clientKey` 加一条优先规则：回环对端且带合法的 `X-T3x-Client-IP` 时用它做桶键（8.0 实测 frps 会多追加一跳 XFF，规则见 3.11）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 推送注册（`apps/server/src/fork/push/`）                      | **不变**。注册以会话 id 为键，设备会话与之天然兼容；撤销设备会话时服务端自己删除注册（FORK.md 已写明）。手机通过各电脑的 `push.register` 注册，共用同一个 endpoint                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ntfy                                                          | **并入同一套 compose，默认安装**（用户选了自建 ntfy 做推送）：`ntfy.<域名>` 在通配 DNS 之内，不再需要单独的 A 记录；`setup.sh --no-ntfy` 关闭。**评审提出这是额外的暴露面**，记录如下，并按下面的方式收紧：(1) 镜像钉版本（`binwiederhier/ntfy:v2.36.0`，`docker-compose.yml:27`），随其他镜像一起升级，README 写升级步骤；(2) ntfy 的 80 端口只在 compose 内网，宿主机不发布，Caddy 是唯一入口，且是单独的显式站点 `ntfy.<域名>`，不在 on-demand 证书的 `ask` 范围内；(3) `ntfy/server.yml` 已有的锁定保持不变：`auth-default-access: deny-all`、匿名只能写 `up*`（`auth-access: "*:up*:write-only"`）、`enable-signup: false`、`enable-login: false`、不开附件；(4) 只创建一个只读 `up*` 的 `phone` 账号，随机密码写进 `secrets/ntfy-phone.txt`（0600）并打印一次，`./t3x ntfy` 可再次显示；(5) `up` 主题名本身是写入凭据，T3 不把完整地址写进日志；SSRF 防护（只向公网地址推送）不变。残余风险：知道主题名的人可以往里写垃圾，但手机上的连接库会丢弃无法用手机密钥解密的数据。 |

## 3. 协议规格

约定：所有 JSON 的时间是 Unix 秒（整数）；`b64u` = 无填充 base64url；所有 JWS 都是 `b64u(header).b64u(payload).b64u(sig)`，签名是 ES256 的 r‖s（64 字节），签名输入是 `SHA-256(b64u(header) + "." + b64u(payload))`，与 `packages/shared/src/dpop.ts:174-183` 一致，所以现有的 P-256 实现可以直接复用。

### 3.1 密钥与标识

| 项          | 格式                                                                                                                                                                                                              |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 设备公钥    | JWK：`{"kty":"EC","crv":"P-256","x":b64u,"y":b64u}`，只接受这四个字段                                                                                                                                             |
| 设备 id     | `b64u(SHA-256({"crv":…,"kty":…,"x":…,"y":…}))`（字段顺序固定，RFC 7638），43 字符；同 `computeDpopJwkThumbprint`                                                                                                  |
| 设备种类    | `computer`（电脑）／`phone`（手机）                                                                                                                                                                               |
| 显示名      | NFC，1–40 字符，无控制字符；在未移除的设备里大小写不敏感唯一，冲突自动加 ` (2)`                                                                                                                                   |
| registry id | 注册表首次启动时的 8 字符随机 base32；写进邀请、通行证的 `rid`、电脑和手机钉住的 membership，防止"同名但其实是另一个注册表"。**它不是秘密**（`/v1/info` 公开），所以只防填错地址，不防控制域名的人（4.2 情形 11） |

### 3.2 邀请

| 字段 | 含义                                          | 长度 / 取值                         |
| ---- | --------------------------------------------- | ----------------------------------- |
| `v`  | 版本                                          | `1`；未知版本客户端提示"请更新应用" |
| `o`  | 注册表公网源（`https://host[:port]`，无路径） | ≤ 80                                |
| `r`  | registry id                                   | 8                                   |
| `i`  | 邀请 id                                       | 11（64 位随机）                     |
| `s`  | 邀请密钥                                      | 22（128 位随机）                    |
| `k`  | 预期设备类型                                  | `c` / `p` / `a`                     |
| `e`  | 过期时间（仅供客户端提前判断）                | Unix 秒，创建后 15 分钟             |

字符串 = `"t3x1." + b64u(JSON)`。兑换时发 `i.s`，注册表比较 `SHA-256(s)`（`timingSafeEqual`），**用一条条件 UPDATE 在事务里一次性消费**（Q5 的 SQL），`devices.invite_id` 唯一约束兜底，所以并发兑换只有一个赢家。

### 3.3 注册表 API

基址 `https://<域名>[:端口]/v1`。"签名"= 带有效的 `T3X-Proof`（3.4），"电脑"= 签名者的设备种类必须是 `computer`。

| 方法与路径             | 认证                               | 请求                                                       | 成功响应                                                                                                                                         | 主要错误（`error`）                                                                                     |
| ---------------------- | ---------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------- |
| `GET /info`            | 无                                 | –                                                          | `{apiVersion:1, registryId, domain, publicPort}`                                                                                                 | –                                                                                                       |
| `POST /join`           | 邀请 + 自签名（PoP）               | `{invite:"i.s", device:{name, kind, jwk, environmentId?}}` | `{registryId, deviceId, name, subdomain?, url?, rev}`                                                                                            | `invite_invalid` / `invite_expired` / `invite_used` / `kind_mismatch` / `name_invalid` / `rate_limited` |
| `GET /devices`         | 签名（任意设备）                   | `If-None-Match: "<rev>"`                                   | `200 {registryId, rev, devices:[{id, name, kind, jwk, subdomain?, url?, environmentId?, createdAt, lastSeenAt, lastSyncAt?, online?}]}` 或 `304` | `device_unknown`（被移除）                                                                              |
| `POST /invites`        | 签名 + 电脑                        | `{kind:"computer"｜"phone"}`                               | `{id, invite:"t3x1.…", expiresAt}`                                                                                                               | `too_many_invites` / `rate_limited`                                                                     |
| `GET /invites`         | 签名 + 电脑                        | –                                                          | `{invites:[{id, kind, createdBy, expiresAt}]}`（未使用且未过期的）                                                                               | –                                                                                                       |
| `DELETE /invites/{id}` | 签名 + 电脑                        | –                                                          | `204`                                                                                                                                            | `not_found`                                                                                             |
| `DELETE /devices/{id}` | 签名 + 电脑                        | –                                                          | `200 {removedAt, rev}`；可删除自己（= 离开）。电脑的子域名同时写入墓碑                                                                           | `not_found` / `forbidden`（手机调用）                                                                   |
| `PATCH /devices/{id}`  | 签名；手机只能改自己，电脑可改任何 | `{name}`（只改显示名，不改子域名）                         | `{id, name}`                                                                                                                                     | `name_invalid` / `name_taken` / `forbidden`                                                             |
| `PATCH /devices/self`  | 签名                               | `{environmentId}`（电脑重新报告环境 id）                   | `{rev}`                                                                                                                                          | –                                                                                                       |

- `GET /devices` 同时刷新签名者的 `last_seen_at` 和 `last_sync_at`（304 也算；批量写盘）。电脑的 `online` 由 frps 插件的 `Login`/`Ping` 更新（30 秒一次，批量写盘，不是每次心跳一次 fsync）。
- 响应里的 `registryId` 必须等于客户端钉住的值，不符就丢弃。
- 清单里包含**所有**设备的公钥（电脑要用它验通行证）；手机也能看到，公钥不是秘密。
- 错误格式 `{error, error_description}`，状态码 400 / 401 / 403 / 404 / 409 / 429。
- 未认证的端点（`/info`、`/join`，以及验签之前的所有请求）都有按 IP 的限速，见 Q5。

内部端口（不经 Caddy，只在 compose 网络里）：`:8081/frps` 是 frps 插件回调，`:8082/ask` 是 Caddy 证书询问。

### 3.4 请求签名 `T3X-Proof`

JWS：头 `{alg:"ES256", typ:"t3x-req+jwt", kid:<设备 id>}`（`/join` 里改为 `jwk:<公钥>`，用来证明持有对应私钥）；载荷：

| 字段  | 内容                                                                                                                                                                      |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `htm` | HTTP 方法，大写                                                                                                                                                           |
| `htu` | **规范 URL**：注册表配置的公网源（`T3X_PUBLIC_ORIGIN`）+ 请求行里的路径 + 查询串（协议和主机小写，默认端口省略）。注册表自己重建后比对，**不读 `Host` / `X-Forwarded-*`** |
| `iat` | 签发时间，与注册表时钟差 ≤ 120 秒                                                                                                                                         |
| `jti` | 128 位随机；注册表记 `(设备 id, jti)` 到 `exp = iat + 240`，之后清理                                                                                                      |
| `bh`  | 请求体的 `b64u(SHA-256(body))`；没有请求体时省略                                                                                                                          |

校验顺序：解码 → 查设备（`/join` 例外）→ 验签 → 方法与 URL → 时间窗 → `bh` → 插入 `jti`（唯一约束冲突 = 重放）。一次失败不暴露是哪一步：统一 `401 invalid_proof`，具体原因只写进注册表日志。

### 3.5 通行证和令牌端点

`POST /oauth/t3x-device`（电脑的 server 上，表单编码）。**它与 `/oauth/token` 走同一条流水线**：

| 流水线环节        | `/oauth/token` 今天（`apps/server/src/auth/http.ts:352-413`）                                                | `/oauth/t3x-device`                                                                                                                                                                            |
| ----------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 路由 / 全局中间件 | HttpApi 的 `token` handler，经 `layerMakeRoutes`                                                             | fork 的 `HttpRouter.add("POST", "/oauth/t3x-device")`，同样挂在 `layerMakeRoutes` 里，所以全局的 CORS（`layerBrowserApiCors`）、请求追踪、`AuthAttemptLimiter` 中间件对它同样生效              |
| DPoP 验证         | `verifyRequestDpopProof({ request })`（`:365-381`，即 `auth/dpop.ts:55`），失败追加 `www-authenticate: DPoP` | 同一个函数，同样追加挑战头；**`DPoP` 头缺失一律 401**，永远不签 Bearer 会话                                                                                                                    |
| 响应头            | `appendCredentialResponseHeaders`：`cache-control: no-store`、`pragma: no-cache`                             | 同一组头；上游把这个 const 和 `appendDpopChallengeHeader` 加 `export`（各 1 行，`// fork:`）                                                                                                   |
| 错误形状          | `failEnvironmentAuthInvalid` 等（`http.ts` 已导出）                                                          | 同一批函数，所以状态码、`code: "auth_invalid"` 和 `traceId` 形状一致，另加 `t3x_reason`                                                                                                        |
| 会话签发          | `exchangeBootstrapCredentialForAccessToken` → `SessionStore.issue`                                           | 直接 `SessionStore.issue`，`method` 固定为 `dpop-access-token`（1 小时），参数见 Q2                                                                                                            |
| 限速              | `rejectedCodeStatus` 里的 `case`                                                                             | 加 `case "/oauth/t3x-device": return 401`。该函数同时驱动**检查**（先 `limiter.check`，锁定期间不进入 handler，不消耗 `jti`）和**失败计数**（响应是 401 就 `recordFailure`），一个 case 管两头 |

| 项         | 内容                                                                                                                                                                                                                                                                                             |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 请求头     | `DPoP: <proof>`（必须，由 `cnf.jkt` 对应的密钥签名；htm=`POST`，htu=本请求 URL）                                                                                                                                                                                                                 |
| 请求体     | `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`、`assertion=<通行证>`、`scope=<可选，取交集>`                                                                                                                                                                                           |
| 通行证头   | `{alg:"ES256", typ:"t3x-assertion+jwt", kid:<设备 id>}`                                                                                                                                                                                                                                          |
| 通行证载荷 | `{v:1, iss:<设备 id>, sub:<设备 id>, aud:<目标 environmentId>, rid:<registry id>, iat, exp, jti, cnf:{jkt}}`，`exp - iat ≤ 120`                                                                                                                                                                  |
| 成功响应   | 与 `/oauth/token` 的 `AuthAccessTokenResult` 相同：`{access_token, issued_token_type, token_type:"DPoP", expires_in:3600, scope}`                                                                                                                                                                |
| 失败响应   | 401：`t3x_reason` 取 `device_unknown`、`device_revoked`、`audience_mismatch`、`registry_mismatch`、`expired`、`time_window`、`replay`、`key_mismatch`。**503**（服务端状态问题，不计入限速）：`list_unavailable`（还没有清单）、`list_expired`（清单陈旧超过 7 天）；400：格式错误（同样不计入） |

server 校验顺序（失败即停；通行证自己的 `jti` 最后才消耗）：

1. 解码与 `typ/alg`；清单存在（否则 503 `list_unavailable`）且未过期（`now - fetchedAt ≤ 7 天`，否则 503 `list_expired`）。
2. `kid` 在当前清单里（否则 `device_unknown`）；用清单里的公钥验签；`iss == sub == kid`。
3. `aud` = 本环境 id；`rid` = membership 里的 registry id。
4. `|now - iat| ≤ 120` 且 `now < exp`。
5. `verifyRequestDpopProof({ request, expectedThumbprint: cnf.jkt })`（它自己也消耗 DPoP 的 `jti`）。
6. 在 `DeviceDirectory` 的信号量内：**重新确认设备仍在清单里**；`create("t3x-assertion-<hash(kid:jti)>")`，已存在即 `replay`（前缀要加进 `REPLAY_MARKER_PREFIXES`，`apps/server/src/auth/replayMarkers.ts:15`，否则标记永远不被清理）；`SessionStore.issue(...)`。第 6 步放在对账用的同一把信号量里，保证"对账之后不可能再为已移除的设备签发"（Q2「撤销链」）。
7. 手机会话的 scope = 请求的 scope 与"标准 scope 去掉 `access:write`、`relay:write`"的交集，**服务端取交集，不依赖界面**。

通行证每次兑换现签、绝不缓存；客户端只缓存兑换回来的会话令牌（`expiresAt - 60 秒` 时续期，沿用 `DPOP_ACCESS_TOKEN_REFRESH_SKEW_MS`，`connection/model.ts:113`）。

### 3.6 桌面渲染进程代签

RPC `devices.signAssertion`（server，条件见 Q3：**会话主体是 `desktop-bootstrap`**，目标在服务端自己的清单里且不是本机，清单未过期）：

| 方向 | 内容                                                                          |
| ---- | ----------------------------------------------------------------------------- |
| 请求 | `{audienceEnvironmentId, dpopThumbprint}`                                     |
| 响应 | `{assertion: <通行证 JWS>, expiresAt}`（`exp = iat + 60`）                    |
| 错误 | `NotLocalOwner`、`UnknownAudience`、`NotJoined`、`ListExpired`、`RateLimited` |

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
transport.heartbeatInterval = 30      # 必须显式写：TCPMux 默认开着时不写就没有 Ping [实测]
transport.heartbeatTimeout = 90
transport.poolCount = 0               # 新连接都要过 NewWorkConn；效果与延迟 8.1 实测（Q6）

[[proxies]]
name = "t3x"
type = "http"
localIP = "127.0.0.1"
localPort = <server 实际监听端口>
subdomain = "<子域名>"
```

测试时再加 `transport.tls.trustedCaFile`（Caddy 本地根 CA），生产环境不写（生产用系统 CA）。`transport.protocol = "wss"` 时外层 TLS 一直开启并校验 [实测]。

**ticket**：JWS `{alg:"ES256", typ:"t3x-ticket+jwt", kid:<设备 id>}` + 载荷 `{v:1, iss:<设备 id>, rid, sub:<子域名>, gen:<登记代次 = 设备行的 created_at>, iat, exp: iat+86400}`。

**frps 配置**（`infra/self-host/frps.toml` 重写）：

```toml
bindPort = 7000 # 不发布到宿主机；只有 Caddy 能经 compose 网络访问
vhostHTTPPort = 8080
subDomainHost = "{{ .Envs.T3X_DOMAIN }}"
transport.heartbeatTimeout = 90

[[httpPlugins]]
name = "t3x-registry"
addr = "registry:8081"
path = "/frps"
ops = ["Login", "NewProxy", "Ping", "NewWorkConn"]
```

**插件规则**（注册表 `plugin.mjs`，每个请求 1.5 秒内必须答完，见 Q6）：

| op            | 检查                                                                                                                                                                                                                                                | 失败                                   |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| `Login`       | **实时查库，无缓存**：ticket 签名合法、`exp` 未过、`rid` 匹配、`kid` 的设备行存在且是电脑、`sub` 等于该行子域名、`gen` 等于该行 `created_at`、`user` = 设备 id 前 16 位；通过则记录 `run_id → 设备 id`，更新 `last_tunnel_at`（内存 Map，批量落盘） | `reject: true, reject_reason: "t3x:…"` |
| `NewProxy`    | 实时查库；`proxy_type == "http"`、`subdomain` 等于该设备的子域名、`custom_domains/locations/http_user` 为空、该设备只有这一个代理                                                                                                                   | 拒绝                                   |
| `Ping`        | 实时查库：用 `user.run_id`/`user.metas` 找到设备，设备行仍存在；更新 `last_tunnel_at`                                                                                                                                                               | 拒绝（frpc 收到错误的 Pong 后断开）    |
| `NewWorkConn` | 实时查库，同 `Ping`。只在新建 work conn 时被问到（Q6），不能当作立即切断                                                                                                                                                                            | 拒绝                                   |

放行返回 `{"reject": false, "unchange": true}` [实测]。`reject_reason` 取值固定为：`t3x:revoked`（设备行不存在）、`t3x:ticket-expired`、`t3x:bad-ticket`（签名、`sub`、`gen`、`rid`、`user` 任一不符）、`t3x:busy`（超时或在途过多）。

**`DeviceTunnel` 怎么读 frpc 的日志** [实测]。日志里**没有** "login failed" 之类的字样，只匹配下面三句，冒号后面是插件给的 `reject_reason`：

| frpc 日志原文（子串）                    | 什么时候出现   |
| ---------------------------------------- | -------------- |
| `pong message contains error: <reason>`  | 心跳被拒       |
| `connect to server error: <reason>`      | 重新登录被拒   |
| `StartWorkConn contains error: <reason>` | work conn 被拒 |

| `<reason>`                                       | `DeviceTunnel` 做什么                                                       |
| ------------------------------------------------ | --------------------------------------------------------------------------- |
| `t3x:revoked`                                    | 立即触发 `devices.refresh`（会发现自己已被移除并自清理），**不再重启 frpc** |
| `t3x:ticket-expired` / `t3x:bad-ticket`          | 重新生成配置（新 ticket）并重启 frpc                                        |
| `t3x:busy` / `send <Op> request to plugin error` | 什么也不做：注册表忙或宕机，frpc 自己按退避重试（≤ 约 20 秒一次）           |
| 其他                                             | 记 warning，只显示在 `devices.status.tunnel.lastError`                      |

### 3.8 清单同步与撤销（server）

```
未加入 ──join──▶ 已加入·新鲜 ◀──────────┐
   ▲                 │ 同步失败          │ 同步成功
   │                 ▼                   │
   │      已加入·陈旧（< 7 天，24h 起告警）┤
   │                 │ 满 7 天            │
   │                 ▼                   │
   │      已加入·过期（拒绝新通行证）─────┘
   └── 自己被移除 / leave ────────────────
```

| 事件                           | 动作                                                                                                                                                                        |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| server 启动，已有 membership   | 读 `fork-device-list` 作为当前清单；启动 `DeviceTunnel`；立刻同步                                                                                                           |
| 每 60 秒 / `devices.refresh`   | `GET /v1/devices`；200 → 原子写入清单 → 在信号量内对账（撤销已消失设备的 `t3x-device:*` 会话）→ 发布变更流；304 → 只刷新 `fetchedAt`；网络错误 → 保留清单，不改 `fetchedAt` |
| `401 device_unknown`           | 自己被移除：进入"未加入"（Q8）                                                                                                                                              |
| 通行证到达                     | 用内存里的清单验证（不在请求路径上访问 VPS）；清单过期则 503                                                                                                                |
| `devices.invite/remove/rename` | 直接调注册表（用本机密钥签名），成功后立即触发一次同步                                                                                                                      |
| 本机 CLI 改了 membership       | server 在每次同步 tick 和 `devices.refresh` 开头重读 membership 文件，所以 `t3x devices join` 在 server 运行时也能生效，最迟 60 秒                                          |

### 3.9 server 的 RPC 与契约（`packages/contracts/src/forkDeviceKeys.ts`，仿照 `forkPush.ts`）

**谁能管理设备**：`devices.*` 的全部 RPC 都由 handler 在服务端检查"会话主体 == `desktop-bootstrap`"（handler 工厂拿到已验证的会话，对照 `makePushRpcHandlers(sessionId)` 的做法，`apps/server/src/fork/push/pushRpcHandlers.ts`），不满足返回 `NotLocalOwner`。同样不能管理的有：配对浏览器（**哪怕有 `access:write`**）、其他设备的会话（`t3x-device:…`，含其他电脑和手机）。**也不能读清单**（决定）：设备名和子域名是拓扑信息，只有本机 owner 需要在设置页看到；手机直接向注册表取清单，不经电脑。想要只读开放，是后面可以放宽的方向，反方向收紧很难。

另一条入口是本机 `t3x devices` CLI，走与 `t3 pair` 相同的本机 owner 路径：进程内直接打开状态目录（`apps/server/src/cli/auth.ts:27-48` 的 `runWithEnvironmentAuth` 就是这样），拿到文件权限就是 owner，不经过 HTTP 和会话。

| RPC                     | 谁能调              | 说明                                                                                           |
| ----------------------- | ------------------- | ---------------------------------------------------------------------------------------------- |
| `devices.status`        | `desktop-bootstrap` | `{state, registryHost, deviceId, name, url, tunnel:{status, lastError}, fetchedAt, staleness}` |
| `devices.subscribe`     | `desktop-bootstrap` | 流：先给 `{rev, devices[]}` 快照，清单或状态变化时再推送                                       |
| `devices.join`          | `desktop-bootstrap` | `{invite, name}`；已由界面确认过注册表域名                                                     |
| `devices.leave`         | `desktop-bootstrap` | 向注册表删除自己，再清本地                                                                     |
| `devices.invite`        | `desktop-bootstrap` | `{kind}` → `{id, invite, expiresAt}`                                                           |
| `devices.cancelInvite`  | `desktop-bootstrap` | `{id}`                                                                                         |
| `devices.remove`        | `desktop-bootstrap` | `{deviceId}` → `{removedAt, rev}`                                                              |
| `devices.rename`        | `desktop-bootstrap` | `{deviceId, name}`                                                                             |
| `devices.refresh`       | `desktop-bootstrap` | 立即同步                                                                                       |
| `devices.signAssertion` | `desktop-bootstrap` | 3.6                                                                                            |

- 这些 RPC 同时登记 `access:write` / `access:read` 作为**界面可用性提示**（`CLIENT_GUARDED_RPC_SCOPES`，`createEnvironmentRpcCommand`，仿 `apps/mobile/src/fork/push/pushCommands.ts`）；真正的授权是主体检查。补 `clientRpcPermissions` 的权限行为测试（AGENTS.md 要求），并加"有 `access:write` 的配对浏览器被拒"的用例。
- 手机在 server 一侧也进不了：手机会话没有 `access:write`，主体也不是 `desktop-bootstrap`。再往前，注册表也按设备种类拒绝手机的邀请 / 移除。三道独立的门。
- 不提供 MCP 工具：让 agent 能给自己的电脑加设备或移除设备，没有合理的使用场景，且风险高。定时任务同理不触及。
- 无头 CLI：`t3x devices join <邀请>` / `list` / `invite --kind phone` / `remove <名字>` / `leave` / `tunnel install`，调用同一个服务，输出邀请时同样打印二维码（复用 `renderTerminalQrCode`，`apps/server/src/startupAccess.ts:162`，`cli/pair.ts:247` 就是这样用的）。

### 3.10 server 状态存放

| 位置（`ServerSecretStore` 名）      | 内容                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------ |
| `fork-device-key`                   | 私钥 JWK（0600，原子写入）                                                     |
| `fork-device-membership`            | `{registryOrigin, registryId, deviceId, name, kind, subdomain, url, joinedAt}` |
| `fork-device-list`                  | `{rev, fetchedAt, devices[]}`                                                  |
| `t3x-assertion-<hash>`              | 重放标记（空内容，由 `replayMarkers` 清理）                                    |
| `<stateDir>/device-public-url.json` | 只含 `{url}`，供 `PublicUrls` 读取（不含秘密）                                 |
| `<stateDir>/fork-tunnel/frpc.toml`  | 每次启动重新生成（含 ticket，不含私钥），0600                                  |

### 3.11 隧道进来的请求：协议、规范 URL 和客户端 IP

**实测的事实** [实测：`curl` 经 HTTP/2 访问 `https://a.t3.localhost:18443/`，源站 `127.0.0.1:18700` 收到的头]：

```text
host: a.t3.localhost:18443
x-forwarded-for: 192.168.80.1, 192.168.80.4
x-forwarded-proto: http
x-forwarded-host: a.t3.localhost:18443
x-t3x-client-ip: 192.168.80.1
```

- `Host` 原样（主机名没被改；测试用了非 443 端口所以带 `:18443`，生产的 443 不带端口）。
- **`X-Forwarded-Proto` 是 `http`**：客户端明明走 HTTPS，frps 的 HTTP vhost 按自己的明文监听把 Caddy 写的值盖掉了。
- **`X-Forwarded-For` 多一跳**：最右边 `192.168.80.4` 是 Caddy 容器，是 frps 追加的；`192.168.80.1` 是 Docker 网关（本机 docker-proxy 的缘故，Caddy 看不到真实的 127.0.0.1；VPS 上 `{remote_host}` 才是公网地址）。
- `X-T3x-Client-IP` 能穿过 frps，等于第一跳。

#### 协议和规范 URL

**上游怎么推导**：`HttpServerRequest.toURL`（effect，参考副本 `.repos/effect-smol/packages/effect/src/http/HttpServerRequest.ts:1050-1058`）用 `Host` 头，协议只看 `x-forwarded-proto === "https"`，否则是 `http`。经过 frps 后，它得出的永远是 `http://<子域名>.<域名>/…`。三个调用点受影响 [已核实]：

| 调用点                                                                | 用来做什么                          | 经隧道不修会怎样                                                                                                                                         |
| --------------------------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/server/src/auth/dpop.ts:63`（`verifyRequestDpopProof`）         | 和客户端签进 DPoP 证明的 `htu` 比对 | **所有 DPoP 操作都因 `url_mismatch` 失败**：`/oauth/t3x-device`、WebSocket 升级、HTTP 请求、ticket。这是致命的                                           |
| `apps/server/src/auth/McpOAuth.ts:67`（`requestUrls`）                | MCP 的 OAuth issuer 和 resource     | 经隧道的 MCP 登录得到 `http://` 的 issuer（与上游的 `docs/internals/environment-auth.md` 说的"issuer 来自 Host 和 `X-Forwarded-Proto`"一致，同一个根因） |
| `apps/server/src/mcp/McpHttpServer.ts:83`（`mcpResourceMetadataUrl`） | MCP 401 里的 resource metadata 地址 | 同上                                                                                                                                                     |

其余 `toURL` 调用点（`http.ts:410,468,569`、`ws.ts:695,745,3362`、`EnvironmentAuth.ts:1245`、`auth/http.ts:75` 等）我读过的只取 `pathname` / `searchParams`，不受影响；`ServerBrowserStream.ts:56`、`DeviceHubProxy.ts:178` 没逐个读 [推断，8.2 开工 grep 复核]。`cloud/linkChecks.requestAbsoluteUrl` 只服务 T3 Connect，不碰。浏览器配对用的 cookie 没有 `Secure` 标志（`auth/http.ts:322-327`），所以不受协议误判影响。

**fork 怎么接进去**：新文件 `apps/server/src/fork/deviceKeys/requestOrigin.ts` 导出 `requestUrl(request)`，上游那三处各把 `HttpServerRequest.toURL(…)` 换成它（每处 1 行，带 `// fork:`）。规则，**三个条件同时成立才改写**，否则原样走上游的 `toURL`：

1. 本机已加入服务器，且有登记时由注册表分配、存在本机 membership 里的**隧道源** `https://<子域名>.<域名>[:端口]`（3.10）。
2. TCP 对端是回环地址（`request.remoteAddress`；frpc 总是从 `127.0.0.1` 转进来，和 `AuthAttemptLimiter.ts` 里 `isLoopbackAddress` 的判断一致）。
3. `Host` 头规范化后（`new URL("http://" + Host).host`，小写、省略默认端口）等于隧道源的 `host`。

满足时 `URL = new URL(request.url, 隧道源)`，也就是 `https`。这个分支**完全不读任何 `x-forwarded-*` 头**。没有新造 `X-T3x-Proto`：协议来自本机保存的配置，不来自请求里客户端也能写的东西。

- **为什么 `Host` 不是漏洞**：`Host` 是客户端写的，但这个分支只意味着"把这条请求当作发往我自己的隧道源"。公网上的人要走到这里必须经过 frps，而 frps 按 `Host` 路由，所以到得了这台电脑的请求，`Host` 只可能是它自己的子域名。本机进程可以伪造 `Host`，但本机进程本来就能读设备密钥。更重要的是，这个 URL 只用来和**客户端已经签好的** `htu` 比对：没有私钥的人不会因为改了 `Host` 就变出一份有效证明。
- **`Host` 对不上时**（回环对端，但 `Host` 不是隧道源）：不改写，走上游的 `toURL` 得到 `http://…`，DPoP 因 `url_mismatch` 被拒，**失败关闭**，不是绕过。若该 `Host` 以注册表域名结尾，每分钟最多记一条 warning（规范化后的 `Host`），便于排查。
- **不受影响的路径**：局域网直连（对端是局域网地址，条件 2 不成立）；Tailscale Serve 和 T3 Connect（对端回环，但 `Host` 是 tailnet 名或 Connect 主机名，条件 3 不成立，继续用它们自己带来的 `x-forwarded-proto: https`）；桌面本机（`Host` 是 `127.0.0.1:端口`）。
- 隧道源是同步读的（`McpOAuth.requestUrls` 是纯函数），所以 `requestOrigin.ts` 里有一个很小的同步持有者，由 `DeviceDirectory` 在 membership 加载、变化、清除时更新；测试里每个用例重置。这是 fork 里唯一的模块级可变状态，8.2 开工时如果能让 MCP 两处也走 Effect 就去掉它。

#### 客户端 IP 和限速键

`AuthAttemptLimiter.clientKey`（`apps/server/src/auth/AuthAttemptLimiter.ts:125-139`）今天先看 `X-Forwarded-For` 的**最右一项**。经 frps 之后最右一项永远是 Caddy 容器地址，所有人落进同一个桶，一个人失败 20 次就锁住全体。新规则（顺序）：

1. **TCP 对端是回环地址，并且 `X-T3x-Client-IP` 是一个合法的 IP 字面量**（`net.isIP`）→ 键为 `tunnel:<ip>`。
2. 否则原样：XFF 最右一项 → 回环且无转发头则不计数 → `socket:<地址>`。

- Caddy 必须**覆盖**客户端自带的同名头：站点里 `header_up X-T3x-Client-IP {remote_host}`（`header_up` 不加 `+` 前缀就是"设置"，不是"追加"）。frps 的 `bindPort` 和 `vhostHTTPPort` 都不发布到宿主机，所以只有 Caddy 能把请求送给 frps。
- 服务器**只在对端是回环时才认这个头**；非回环（局域网等）的请求带了它也被忽略，用 `socket:`。
- 本机进程伪造这个头只能挑选自己的桶，不影响别人；没有额外风险。
- 同一个头也是注册表自己限速的键，Caddy 的 `/v1/*` 路由同样覆盖写入（Q6 的 Caddyfile）。
- 本机 Docker Desktop 的端到端里，`{remote_host}` 是网关地址（`192.168.80.1`），所有测试客户端共享一个桶；写限速测试时要按这个预期。
- 上游改动：`clientKey` 的入参多一个 `tunnelClientIp`，调用处传 `request.headers["x-t3x-client-ip"]`（约 8 行，`// fork:`）。

## 4. 威胁模型

假设攻击者能看到公网上的所有流量（但看不到 VPS 上 Caddy 解密后的明文，除非 VPS 本身被攻破）、能猜 URL、能抓到某一个泄露的字符串、能诱导用户加入错误的服务器。"剩余风险"一列是实现后仍然存在的。

### 4.0 先说清楚的两条残余风险

1. **有 `terminal:operate` 的会话能读走那台电脑的设备密钥，在被移除之前冒充它。** `terminal:operate` 就是 server 用户的 shell，可以读 `secrets/fork-device-key`（`docs/internals/environment-auth.md` 开头也说过：不给默认 scope 里的管理权限并不是边界）。标准授权的设备（配对浏览器、其他电脑）都有它，所以"某台电脑被一个标准会话攻破 → 它的设备身份泄露 → 攻击者能以它的名义登录你所有的电脑"是承诺模型的一部分。手机会话没有 `access:write` 只防"诚实但被诱导的客户端"，不防它读文件。缓解只有：快速发现并移除该电脑；移除后其他电脑 1 分钟（离线者最晚 7 天）内拒绝它。
2. **VPS 被攻破（已接受）。** TLS 在 VPS 终止，攻击者能读明文、能往名单里加自己的钥匙。第 9 节的两项加固做完才能消除。

### 4.1 要求的八种情形

| #   | 情形                     | 能做什么                                                                        | 缓解                                                                                                                                                                                                                                                                                                                                           | 剩余风险                                                                                                                                                                                                                                                                    |
| --- | ------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 丢失的手机               | 拿到解锁的手机就能用 app，通过会话访问你的电脑（含终端）                        | 到任一台电脑的 Devices 移除（或 VPS 上 `./t3x revoke`）；能连 VPS 的电脑约 1 分钟内撤销，注册表拒绝其签名；SecureStore 用 `WHEN_UNLOCKED_THIS_DEVICE_ONLY`，锁屏时读不出密钥；手机会话没有 `access:write`，不能邀请或移除别人                                                                                                                  | 离线电脑最晚 7 天后才撤销；手机私钥是静态加密、不是不可导出，已解锁且被 root 的手机可能被取出（第 9 节第三项）                                                                                                                                                              |
| 2   | 泄露的邀请字符串         | 在 15 分钟内、被用掉之前，抢先加入成一台设备                                    | 单次使用（条件 UPDATE + 唯一约束）、15 分钟、128 位密钥、只存哈希；邀请指定设备类型；`./t3x invites` 和电脑界面都能看到待用邀请并取消；兑换时注册表日志记 IP 和设备名                                                                                                                                                                          | 抢到的人在你发现并移除之前是一台正式设备。邀请要当作密码来传递                                                                                                                                                                                                              |
| 3   | 被偷的会话令牌           | 单独拿着令牌没用：会话是 DPoP 绑定的，每次请求要用私钥签证明                    | 令牌只绑定一把 DPoP 密钥；通行证本身绑定 `cnf.jkt` 且 120 秒过期；会话 1 小时到期；撤销后立即失效                                                                                                                                                                                                                                              | 同时偷到令牌和 DPoP 私钥（同一台设备被攻破）；局域网明文 HTTP 上窃听到的 DPoP 证明 `jti` 一次性，无法重放                                                                                                                                                                   |
| 4   | 被偷的注册表数据库       | 得到所有设备的公钥、名字、子域名，以及邀请的 SHA-256                            | 库里没有私钥、没有会话令牌；邀请密钥 128 位，哈希不可逆，且 15 分钟后失效                                                                                                                                                                                                                                                                      | 设备清单（谁、叫什么、在线时间）泄露。能写数据库的人（即控制 VPS 的人）可以加钥匙——已接受的限度                                                                                                                                                                             |
| 5   | 被移除后仍在运行的电脑   | 继续占着隧道、继续回应请求                                                      | 插件在 `Login`、`NewProxy`、`Ping`、`NewWorkConn` **每次查实时库，无缓存**；ticket 绑定设备 id、子域名、登记代次，行被删后任何 ticket 都登不上；显式 30 秒心跳，被拒的 `Ping` 让 frpc 断开（实测 13 秒和约 30 秒）；`poolCount = 0` 让撤销之后的新连接直接被拒；它的 server 下次同步发现自己被移除，停隧道并清密钥；别的电脑撤销它的通行证会话 | **一个心跳（约 30 秒）内**隧道断开，其间已建立的连接和池里的连接仍可能服务请求（`NewWorkConn` 只在新建连接时问，实测拒绝后紧接着两次请求仍是 200）；它的 server 若被攻击者控制则可以不遵守"自清理"，但登不上隧道、也换不到别的电脑的会话（别的电脑已撤销，离线者最晚 7 天） |
| 6   | 重放通行证               | 重放同一张通行证以获取新会话                                                    | `jti` 在 `secrets/` 里一次性（先验证全部其它项，最后才消耗）；120 秒时间窗；`aud` 绑定一台电脑；`cnf.jkt` 要求同时拥有 DPoP 私钥；DPoP 证明自己也有 `jti` 一次性                                                                                                                                                                               | server 重启不丢标记（落盘）；时钟偏差超过 120 秒会被误拒（报 `time_window`，界面提示检查时间）                                                                                                                                                                              |
| 7   | 电脑冒用别的电脑的子域名 | 把别人的域名指向自己，截获手机的请求                                            | `NewProxy` 插件强制 `subdomain == 该设备登记的子域名`，且不允许 `custom_domains`、`locations`；`user` 必须等于设备 id 前缀；Caddy 的 `ask` 只给已登记名字发证书；手机连接前先核对 `/.well-known/t3/environment` 的 environmentId 等于注册表记录，再发任何凭据                                                                                  | 注册表本身被改（情形 8）                                                                                                                                                                                                                                                    |
| 8   | VPS 被攻破（**已接受**） | 读取所有经过 Caddy 的明文（含会话令牌与对话）；往名单里加自己的钥匙；冒充注册表 | 用户已明确接受。DPoP 绑定使被读到的令牌不能在别处重放，但攻击者在中间位置可以直接代理请求；保持 VPS 只开 80/443、自动更新、只给 root 一个人                                                                                                                                                                                                    | 全部。第 9 节的两项加固做完才能消除                                                                                                                                                                                                                                         |

### 4.2 补充情形

| #   | 情形                                               | 缓解 / 说明                                                                                                                                                                                                                                                                                                                                                  |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | 带终端权限的会话读取电脑的设备密钥                 | 见 4.0 第 1 条。注册表按种类拒绝手机邀请 / 移除、服务端只让 `desktop-bootstrap` 管理设备，都防不住"读文件"                                                                                                                                                                                                                                                   |
| 10  | 偷到电脑的 state 目录                              | 拿到设备私钥 = 这台电脑，与偷到 `~/.ssh/id_ed25519` 同级。移除该设备即失效                                                                                                                                                                                                                                                                                   |
| 11  | **恶意或被替换的注册表端点**                       | 钉住注册表源与 registry id，之后只向钉住的源发请求，响应 `registryId` 不符就丢弃。这只防"填错地址、换了别的服务器"。**防不住控制域名的人**：`/v1/info` 公开，id 可以抄；他还能伪造清单。这与"VPS 被攻破"同级，要靠第 9 节的"清单由设备签名"才能解决                                                                                                          |
| 12  | **域名 / DNS / TLS 配置错误**                      | 通配 DNS 指向别处，或证书签给了错误的主机：手机连接前先核对 well-known 的 environmentId 等于注册表记录，对不上就不发通行证；URL 必须是钉住域名下的一级 HTTPS 子域名；Caddy `ask` 只放行已登记名字。DNS 记录悬空不会带来接管，因为通配 DNS 本来就指向这台 VPS                                                                                                 |
| 13  | **邀请钓鱼**（对方给你一个指向他自己注册表的邀请） | 加入页先显示注册表域名（含非 ASCII 时的 punycode），要求用户确认后才发请求；加入后只会看到那个注册表里的电脑；只泄露你的设备公钥和设备名。无法防止用户自己确认了错误的域名                                                                                                                                                                                   |
| 14  | **子域名接管**                                     | 子域名在移除后留墓碑、永不再分配（管理员要回收只能在 VPS 上显式执行 `./t3x release <子域名>`）；ticket 绑定子域名和登记代次；旧书签打到的永远不会是另一台电脑                                                                                                                                                                                                |
| 15  | 滥用 Caddy 按需证书（用大量 SNI 耗尽证书额度）     | `ask` 只放行已登记的子域名，且只在 compose 内网监听；不使用 Caddy 的 interval/burst（文档不建议）。**`ask` 撤不回已签发的证书**（实测）：移除设备后旧证书继续服务到过期，但没有隧道时 frps 返回 404，访问控制靠插件和电脑自己的鉴权，不靠证书；证书和私钥都在 VPS 上，不在设备手里，所以 `release` 后复用子域名连证书一起复用也不是问题                      |
| 16  | 猜邀请 / 撞 `/v1/join` / 在鉴权前耗注册表的 CPU    | 128 位密钥；所有未认证端点（`/info`、`/join`、验签之前的每个请求）按客户端 IP 限速；邀请 id 与密钥分开，id 不是秘密                                                                                                                                                                                                                                          |
| 17  | frps 插件和 `ask` 端口暴露                         | 只绑 compose 内网地址，Caddy 里没有任何指向它们的路由，宿主机不发布                                                                                                                                                                                                                                                                                          |
| 18  | 偷到 frpc 的 ticket                                | 在设备仍登记的前提下，可在 ticket 有效期内（≤ 24 小时）在真电脑离线时登录隧道、占用其子域名。后果是拒绝服务或伪装站点；手机会因 environmentId 对不上而不发通行证。ticket 不放命令行，配置文件 0600                                                                                                                                                           |
| 19  | **注册表宕机或变慢**                               | 宕机：所有隧道在下一次 `Ping` / `Login` 失败后断开，frpc 约 20 秒内自己重连；变慢：frps 调插件没有超时，请求会一直挂着（实测 `Login` 睡 8 秒就卡 8 秒）。缓解：插件请求 1.5 秒时限、在途上限 64、独立监听器、不在插件路径上写库、healthcheck + `restart: unless-stopped`。残余：注册表重启会让隧道断几十秒；已经建立的 LAN 连接和 7 天内的通行证登录不受影响 |

## 5. 阶段计划

流程沿用 `tasks/todo.md` 的惯例：每阶段独立 worktree 实现 → 测试与 review 并行 → 修复 → `--no-ff` 合入。**8.3 与 8.4 在 8.2 的契约（`forkDeviceKeys.ts`）冻结后可以并行**，其余顺序依赖。规模：S ≈ 1 天以内，M ≈ 2–3 天，L ≈ 4–6 天（以一个实现者计）。**每个阶段的验收都包含它自己的安全验收，不留到最后。**

### 阶段 8.0 验证（S）：先确认 frp / Caddy / Node 的运行时行为 —— 已完成

- **结果**：第 8 节。frp 钉 v0.71.1；15 项里 11 项通过、4 项（6、13、14、15）要改，已按结果改过正文（0.5）。第 8c 节列出 8.0 覆盖不到、留到 8.1 / 8.2 开工时确认的事。
- **验收**：已满足。

### 阶段 8.1 VPS 端（L）

- **交付**：注册表服务（API、插件、`ask`、CLI）；重写后的 compose / Caddyfile / frps.toml；`setup.sh`、`./t3x`；ntfy 并入；旧的 README 和 `frpc.toml.example` 挪到 `infra/self-host/advanced/`；测试用 compose 覆盖文件。
- **新文件**（全在 `infra/self-host/`）：`registry/Dockerfile`（`FROM node:24-alpine`，`apk add --no-cache libqrencode-tools`，无 `npm install`）、`registry/server.mjs`、`db.mjs`、`proof.mjs`（JWS / 指纹 / 请求签名）、`invites.mjs`、`subdomain.mjs`、`plugin.mjs`、`ask.mjs`、`healthcheck.mjs`、`cli.mjs`、`registry/*.test.mjs`、`setup.sh`、`t3x`、`docker-compose.test.yml`、`Caddyfile.test`、`README.md`（重写）、`advanced/README.md`、`advanced/frpc.toml.example`。
- **上游接线**：无。
- **验收**：
  - 功能：
    - `node --test infra/self-host/registry` 全绿（Mac 上不需要 Docker）。
    - `docker compose -f docker-compose.yml -f docker-compose.test.yml up` 起得来，宿主机只绑 `127.0.0.1:18443`；`curl --cacert` 访问 `/v1/info` 通。
    - 脚本化的"假设备"（Node，使用 `proof.mjs`）完成：CLI 出邀请 → 加入 → 列出 → 邀请手机 → 移除。
    - v0.71.1 的 frpc 用 ticket 登录成功，访问 `https://a.t3.localhost:18443/` 到达本机一个小 HTTP 服务；换一个别人的子域名被 `NewProxy` 拒绝；移除后 **一个心跳（约 35 秒）内** frpc 日志里出现 `pong message contains error: t3x:revoked`，之后用户请求得到 frps 的 404。
    - **`poolCount = 0` 实测**：拒绝之后的**新连接**立即被拒（不再出现 8.0 里的两次 200）；新连接首字节延迟 ≤ 50 ms，否则退回 `poolCount = 1`（承诺不变）。
    - `setup.sh` 在干净的 compose 上打印邀请字符串和二维码；`--no-ntfy` 生效。`qrencode` 缺失时 `./t3x invite` 回退纯文本并给出明确错误（临时从镜像里删掉它来测）。
  - **安全**：
    - **规范 URL**：同一个签名请求，改 `Host` / `X-Forwarded-Host` / `X-Forwarded-Proto` 不影响验签结果；查询串被篡改、`bh` 被篡改、方法不符都被拒；多重 / 伪造的 `X-Forwarded-*` 不改变结果。
    - **邀请原子性**：两个并发 `/v1/join` 兑换同一邀请，恰好一个成功（另一个 `invite_used`）；`devices.invite_id` 的唯一约束在绕过应用代码直接插入时也拒绝第二个设备；过期、种类不符、密钥错各有用例。
    - **子域名墓碑**：移除一台电脑后，同名电脑重新加入拿到 `-2`；`ask` 对已移除的子域名返回 403（只挡新签发，已签发的证书继续握手成功、无隧道时 frps 返回 404，这是预期，不要写成"握手失败"）；`./t3x release` 之前永不再分配。
    - **限速**：`/v1/join` 失败 10 次 / 10 分钟 / IP 后返回 429，且 429 期间不检查邀请；`/v1/info` 与"验签之前"的请求按 IP 限速；已认证请求按设备限速；限速桶用 Caddy 覆盖写入的客户端 IP 头，不读请求自带的同名头。
    - 插件四个 op 都查实时库：用同一进程内先登录、再删设备，下一个 `Ping` 即被拒，重登的 `Login` 即被拒，新建的 work conn（`NewWorkConn`）即被拒。
    - **慢插件**：让 `Login` 处理函数睡过时限，注册表在 1.5 秒内回 `reject_reason: t3x:busy`（frpc 日志里出现 `connect to server error: t3x:busy`），**同时**公网 `/v1/info` 仍在毫秒内响应（事件循环没被堵）；在途超过 64 个时立即回 503。
    - **插件宕机**：停掉注册表容器，`Login` / `Ping` / `NewWorkConn` 都失败关闭（frpc 日志 `send <Op> request to plugin error`）、`NewProxy` 单独验证一次；重启后无需人工操作，frpc 在 ≈ 20 秒内自己重连并恢复。`healthcheck` 在插件端口卡死 3 次后让容器重启。
    - **限速头**：客户端带自己的 `X-T3x-Client-IP: 1.2.3.4` 经 Caddy 到源站，收到的是被 Caddy 覆盖后的值。
- 规模：registry ≈ 1,250 行（含插件时限、healthcheck、批量写）+ 测试 ≈ 1,600 行；compose / Caddy / 脚本 ≈ 380 行。

### 阶段 8.2 server 核心（L）：身份、注册表客户端、清单、通行证、撤销

- **交付**：电脑能加入、同步清单、验证通行证并签发 DPoP 会话、对账撤销、代渲染进程签名、被移除后自清理、7 天上限。**不含隧道**。
- **新文件**：
  - `packages/contracts/src/forkDeviceKeys.ts`（RPC 与数据类型）。
  - `packages/shared/src/forkDeviceKeys/`：`jws.ts`、`invite.ts`、`assertion.ts`、`subdomain.ts`、`proof.ts`（纯函数，noble P-256，被 server / client-runtime / mobile 共用）。
  - `apps/server/src/fork/deviceKeys/`：`DeviceIdentity.ts`、`RegistryClient.ts`、`DeviceDirectory.ts`（同步 + 对账 + 变更流 + 信号量）、`DeviceAssertionAuth.ts`（`/oauth/t3x-device`）、`requestOrigin.ts`（隧道源的协议与规范 URL，3.11）、`DeviceKeysService.ts`、`deviceRpcHandlers.ts`、`layer.ts`，以及各自的 `*.test.ts`。
  - `apps/server/src/cli/devices.ts`。
- **上游接线**：见 6.2 的 server 部分。
- **验收**：
  - 功能：对着真实的 8.1 注册表（进程内启动，不用 Docker）加入 → 清单同步 → 通行证换到会话；VPS 不通时进入陈旧状态，已有设备仍可登录；续期不踢掉 socket（`replaceActiveForSubjectAndMethod` 的验证项）。
  - **`/oauth/t3x-device` 与 `/oauth/token` 一致**：同一组失败（DPoP 缺失、DPoP 错、proof 重放、请求体格式错）下，两个端点的状态码、`cache-control: no-store`、`www-authenticate: DPoP`、`code: "auth_invalid"` 形状一致（表驱动的对照测试）；CORS 预检行为一致；`DPoP` 头缺失时**不会**签出 Bearer 会话；永远不返回 `token_type: "Bearer"`。
  - **限速（反向测试）**：同一客户端 20 次失败的通行证后，第 21 次得到 429 + `retry-after`，且被锁定期间**不执行验签、不消耗 `jti`**；503（`list_unavailable` / `list_expired`）和 400 不计入失败；本机无转发头的请求不计数；对 `/oauth/token` 的失败与对 `/oauth/t3x-device` 的失败共用同一个桶（按客户端分桶，与现状一致）；未加 `case` 时这些测试必须失败。
  - **客户端 IP（3.11）**：回环对端 + 合法 `X-T3x-Client-IP` → 桶键 `tunnel:<ip>`，两个不同 IP 各有各的桶，XFF 最右一项（Caddy 容器地址）被忽略；**非回环对端带这个头被忽略**；头不是 IP 字面量被忽略；回环对端不带该头时行为与现状完全一致（Tailscale / T3 Connect 不受影响）。
  - **隧道源与协议（3.11）**：回环对端 + `Host` = 隧道源主机 + `x-forwarded-proto: http` → DPoP `htu` 按 `https://…` 验证通过，`/oauth/t3x-device` 和 WebSocket 升级的 DPoP 都能过；`Host` 不符（回环对端）→ 不改写，DPoP `url_mismatch`；非回环对端带同样的 `Host` 和 `x-forwarded-proto: https` → 不改写，行为与上游一致；Tailscale / T3 Connect 形态（回环、别的 `Host`、`x-forwarded-proto: https`）→ 与上游一致；没有 membership 时整个分支不生效；整个分支不读 `x-forwarded-*`（改任意值结果不变）；MCP 的 issuer 在隧道源上是 `https://…`。
  - **撤销链**：移除设备后调用 `devices.refresh`，该设备的会话行 `revokedAt` 被写入；用旧的 WebSocket ticket 升级连接被拒（`WebSocketSessionRevokedError`）；已连接的 socket 被关闭；已被撤销的会话不能续期；在"通行证已验证、尚未签发"与"对账"之间并发时，对账之后不会再签出该设备的会话（信号量）；推送注册随之删除。
  - **`signAssertion` 边界**：非 `desktop-bootstrap` 主体被拒（配对浏览器含 `access:write`、其他电脑的 `t3x-device:computer:…` 会话、手机会话各一例）；带或不带 `x-forwarded-*` 头都不改变结果；目标不在服务端清单、目标是自己、清单过期各被拒；限速。
  - **手机 scope**：手机会话缺 `access:write` 与 `relay:write`；请求更宽的 scope 时被取交集；手机会话调用 `devices.*` 被拒。
  - **管理边界**：`devices.invite/remove/rename/status/subscribe` 对配对浏览器（有 `access:write`）和设备会话一律 `NotLocalOwner`；本机 `t3x devices` CLI 不经 HTTP 就能做同样的事。
  - **7 天上限**：用 `TestClock` 推进到 24 小时 → `staleness: "warn"`；推进到 7 天 → `/oauth/t3x-device` 返回 503 `list_expired`，同步成功后恢复；本机使用与配对链接在过期状态下不受影响；已签发的会话到期后不能续期。
  - 其他：`replay`、`audience_mismatch`、`time_window`、`key_mismatch`、`device_revoked` 各有反向用例；`vp run fork:guard`、`vp run check:changed` 通过。
- 规模：契约 ≈ 250 行；shared ≈ 450 行；server ≈ 1,800 行（含 `requestOrigin.ts` 和 `clientKey` 规则）；测试 ≈ 2,400 行。

### 阶段 8.3 隧道与无头 CLI（M）

- **交付**：server 托管 frpc（生成配置、签 ticket、退避、按 frpc 的三句日志和固定 `reject_reason` 分流、12 小时轮换）；`membership` 写出 `device-public-url.json`；`t3x devices tunnel install|status`；frp 版本表（v0.71.1，SHA-256 见 8a）和下载校验。
- **新文件**：`apps/server/src/fork/deviceKeys/DeviceTunnel.ts`、`frpcConfig.ts`、`frpBinary.ts`、对应测试；`packages/shared/src/forkFrp.ts`；`scripts/fork-fetch-frp.ts`。
- **上游接线**：`apps/desktop/src/backend/DesktopBackendConfiguration.ts`（`T3X_FRPC_PATH`）。
- **验收**：配置生成的快照测试（含 `heartbeatInterval = 30`、`poolCount = 0`、`wss`、子域名、不含私钥）；ticket 的签名 / 过期 / 绑定单测；用假 frpc 可执行文件逐句喂 3.7 的三句日志，验证 `t3x:revoked` → 触发 `devices.refresh` 且不重启、`t3x:ticket-expired` / `t3x:bad-ticket` → 换 ticket 重启、`t3x:busy` / `send <Op> request to plugin error` → 什么也不做、退避序列；真实 frpc 对 8.1 的 compose 连通并自动重连一次（重启 frps 容器）；`forkFrp` 版本与 compose 一致的测试；ticket 不出现在进程参数里。
- 规模：≈ 700 行 + 测试 ≈ 700 行。

### 阶段 8.4 客户端（L+）

- **交付**：`"t3x-device"` profile 与阻断式授权；client-runtime 同步器与"设备管理的环境"索引；web / 桌面 Devices 设置区（加入、邀请、移除、Advanced）；手机加入页、设备页、前台刷新；zh-Hans；中英文对照截图。
- **新文件**：
  - `packages/client-runtime/src/fork/deviceKeys/`：`DeviceKeyAuthorization.ts`（`Context.Reference`，缺省阻断）、`discovery.ts`（钉住、URL 检查、well-known 比对）、`deviceEnvironmentSync.ts`、`managedIndex.ts`。
  - `apps/web/src/components/settings/DevicesSettings.tsx`、`apps/web/src/fork/deviceKeysStore.ts`、`deviceKeysCommands.ts`；web zh-Hans 的 `devices.ts`。
  - `apps/mobile/src/fork/deviceKeys/`：`deviceKey.ts`（SecureStore）、`registryClient.ts`、`useDeviceSync.ts`、`JoinServerScreen.tsx`、`ServerDevicesScreen.tsx`、`deviceCommands.ts`；mobile 的 zh-Hans 文件。
- **上游接线**：见 6.2 的 client-runtime、web、mobile 部分（约 30 个上游文件里的大头）。
- **验收**：
  - 功能：resolver 分派逻辑；同步器的增 / 删 / 改 URL，不动用户手动添加的环境；SecureStore 密钥的生成、读取、损坏恢复；加入流程各错误态。桌面：在 Electron 里走一遍加入 → 邀请 → 移除（`test-t3-app`，`Replay (dev)` provider），中英文对照截图，Advanced 里原功能仍可用；手机只验证单元测试和 jest 渲染。Devices 区不引入定时器，邀请的过期用绝对时间。
  - **`t3x-device` 失败即阻断**：
    - 没有提供 `DeviceKeyAuthorization` 的 runtime（缺省实现）→ `ConnectionBlockedError`；
    - fork 数据缺失（没有设备密钥 / membership）、数据损坏（JSON 坏、指纹对不上）、注册表不可达 → `ConnectionBlockedError`；
    - 以上每一种情形下，**断言没有发出任何到官方 relay 的请求**（用会记录所有 HTTP 的假客户端断言 URL 白名单），没有任何 `Authorization: Bearer` 请求，没有 `RelayConnectionTarget`；
    - `authorizeDpopHttp` / `renewDpopBeforeExpiry` 的 `authorizer` 缺失场景：resolver 盖章是唯一来源，测试断言设备 profile 总会盖章；
    - 设备环境的任何失败，诊断 hop 都不是 `relay`，`connectionMethod` 是 `"direct"`；
    - 学习路由继承 `t3x-device`、`sendsTokenInClear` 为 false、`routesAfterRemoving` 的三个规则。
  - **发现顺序**：先注册表 → URL 检查 → well-known 比对 → 才发通行证。URL 不是 HTTPS、不在钉住域名的一级子域名、带端口 / 路径 / 用户信息，一律不发任何请求；well-known 返回的 environmentId 与注册表记录不符不发通行证；注册表没有 environmentId 则保持待连接。
  - **钉住**：`registryId` 不符的响应被丢弃；加入时邀请的 `r` 与 `/v1/info` 不符则拒绝加入；换了注册表域名的邀请不会改写已有的钉住。
  - **钓鱼确认**：粘贴邀请后、确认之前，不向任何地址发请求（假 HTTP 客户端断言）；对话框显示域名，非 ASCII 时同时显示 punycode。
  - **移除**：同步时手机丢掉被移除电脑的 profile 和缓存令牌；漏掉本地索引时该 profile 仍只走 fork 授权并因清单里没有而阻断。
  - 性能：设置页之外不挂载额外订阅。
- 规模：client-runtime ≈ 900 行；web ≈ 900 行 + 约 90 条译文；mobile ≈ 900 行 + 约 70 条译文；测试 ≈ 1,800 行。

### 阶段 8.5 打包、文档、端到端（M）

- **交付**：`fork-dist-mac.ts` 内置 frpc 并签名；FORK.md「自建连接」重写、`infra/self-host/README.md` 重写、`docs/user/remote-access.md` 新增 "Your own server" 一节并把旧的 "Your own public address" 标为 Advanced、`docs/internals/` 一页（为什么是通行证而不是挑战、为什么新增 `t3x-device`、信任边界、终端权限的限度）；端到端脚本 `scripts/fork-selfhost-e2e.ts` + `vp run fork:selfhost:e2e`。
- **新文件**：`scripts/fork-selfhost-e2e.ts`、`docs/internals/self-hosted-devices.md`。不需要 DNS 预载脚本：`*.t3.localhost` 本机 Node / curl / Go 都能直接解析（8.0 实测）。
- **上游接线**：`package.json`（脚本一行）。`docs/user/remote-access.md` 是上游文件，新增内容放在单独一节并标 fork。
- **验收**：第 7.2 节的端到端全绿（注意 `*.t3.localhost` 先解析到 `::1`：compose 只发布 `127.0.0.1` 时 IPv6 连接先被拒再回落 IPv4，harness 要么给 Node 加 `--dns-result-order=ipv4first`，要么同时发布 `[::1]:18443`，实现时选能跑通的那个）；DMG 重新打包后 `codesign --verify --strict` 覆盖到 `frpc`（8.0 已验证官方 v0.71.1 darwin_arm64 用 `--options runtime` 签名后能运行、无钥匙串弹窗）；FORK.md 中所有路径和命令可以照做；`vp run fork:guard` 通过。
- 规模：脚本 ≈ 600 行；文档 ≈ 400 行。

## 6. 文件清单

### 6.1 新文件（按位置）

| 位置                                                                                       | 内容                                 |
| ------------------------------------------------------------------------------------------ | ------------------------------------ |
| `infra/self-host/registry/*.mjs`、`Dockerfile`                                             | 注册表（8.1）                        |
| `infra/self-host/{setup.sh,t3x,docker-compose.test.yml,Caddyfile.test}`、`advanced/`       | 部署脚本、测试覆盖、旧文档（8.1）    |
| `packages/contracts/src/forkDeviceKeys.ts`                                                 | RPC 与数据类型（8.2）                |
| `packages/shared/src/forkDeviceKeys/`、`forkFrp.ts`                                        | 纯函数协议库、frp 版本表（8.2、8.3） |
| `apps/server/src/fork/deviceKeys/`                                                         | server 服务（8.2、8.3）              |
| `apps/server/src/cli/devices.ts`                                                           | 无头 CLI（8.2、8.3）                 |
| `packages/client-runtime/src/fork/deviceKeys/`                                             | 阻断式授权、发现与同步器（8.4）      |
| `apps/web/src/components/settings/DevicesSettings.tsx`、`apps/web/src/fork/deviceKeys*.ts` | 桌面 / web 界面（8.4）               |
| `apps/mobile/src/fork/deviceKeys/`                                                         | 手机（8.4）                          |
| `scripts/fork-fetch-frp.ts`、`scripts/fork-selfhost-e2e.ts`、`scripts/fork-selfhost-e2e/`  | 下载校验、端到端（8.3、8.5）         |
| `docs/internals/self-hosted-devices.md`                                                    | 一页决策说明（8.5）                  |

### 6.2 要改的上游文件（全部带 `// fork:`）

评审指出第一版的"≤ 40 行"不现实。新增 `"t3x-device"` 之后，连接栈、认证栈、两个客户端的 runtime 都要接。下面是逐文件的诚实估计；**8.4 收尾时要用 `git diff --stat` 对上游文件重新数一遍，写回这张表**。

| 文件                                                                             | 改什么                                                                                                                   | 估计行数 | 阶段 |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ | -------- | ---- |
| `packages/contracts/src/index.ts`、`rpc.ts`                                      | 并入 `devices.*` RPC 组                                                                                                  | 6        | 8.2  |
| `packages/contracts/src/clientRpcPermissions.ts`                                 | 受保护写入的 scope                                                                                                       | 4        | 8.2  |
| `apps/server/src/auth/RpcAuthorization.ts`、`RpcInstrumentation.ts`              | 权限与指标表                                                                                                             | 8        | 8.2  |
| `apps/server/src/ws.ts`                                                          | RPC handler（工厂拿已验证会话以检查主体）                                                                                | 8        | 8.2  |
| `apps/server/src/server.ts`                                                      | import、layer、`/oauth/t3x-device` 路由                                                                                  | 6        | 8.2  |
| `apps/server/src/auth/http.ts`                                                   | 把 `appendCredentialResponseHeaders`、`appendDpopChallengeHeader` 加 `export`                                            | 3        | 8.2  |
| `apps/server/src/auth/replayMarkers.ts:15`                                       | 重放标记前缀                                                                                                             | 2        | 8.2  |
| `apps/server/src/auth/AuthAttemptLimiter.ts:101-112, 125-139`                    | 一个 `case`；`clientKey` 多一条"回环对端 + `X-T3x-Client-IP` 优先"的规则（3.11）                                         | 10       | 8.2  |
| `apps/server/src/auth/dpop.ts:63`                                                | `HttpServerRequest.toURL` → fork 的 `requestUrl`（3.11）                                                                 | 1        | 8.2  |
| `apps/server/src/auth/McpOAuth.ts:67`、`apps/server/src/mcp/McpHttpServer.ts:83` | 同上，issuer / resource metadata 用隧道源                                                                                | 2        | 8.2  |
| `apps/server/src/environment/PublicUrls.ts`                                      | 额外读 `device-public-url.json`                                                                                          | 8        | 8.2  |
| `apps/server/src/cli/*`                                                          | 注册 `devices` 子命令                                                                                                    | 6        | 8.2  |
| `apps/desktop/src/backend/DesktopBackendConfiguration.ts`                        | `T3X_FRPC_PATH`                                                                                                          | 3        | 8.3  |
| `apps/desktop/src/ipc/methods/serverExposure.ts`                                 | 配对二维码可选到设备地址（需核实路径一致）                                                                               | 5        | 8.4  |
| `packages/client-runtime/src/connection/catalog.ts:26`                           | profile `authorization` 加 `"t3x-device"`                                                                                | 2        | 8.4  |
| `packages/client-runtime/src/connection/model.ts`                                | `PreparedConnection.authorizer?`                                                                                         | 3        | 8.4  |
| `packages/client-runtime/src/connection/resolver.ts:148`                         | 在 `t3-connect` 之前的 `t3x-device` 分支，失败即失败                                                                     | 8        | 8.4  |
| `packages/client-runtime/src/connection/routes.ts:215-229, 343, 425`             | 学习路由继承、`sendsTokenInClear`、`routesAfterRemoving`                                                                 | 14       | 8.4  |
| `packages/client-runtime/src/connection/driver.ts:200-216`                       | `authorizer === "t3x-device"` 时走 fork 的 renew                                                                         | 7        | 8.4  |
| `packages/client-runtime/src/state/environmentHttpAuth.ts:145-165`               | 同上，走 fork 的 `authorizeHttp`                                                                                         | 8        | 8.4  |
| 其他直接用 `RemoteEnvironmentAuthorization` 的 `state/*.ts`                      | `session.ts`、`deviceHubAccess.ts`、`orchestration.ts`、`threads.ts`、`peerPairingCode.ts` 等；8.4 开工先 grep，逐个判断 | 约 20–30 | 8.4  |
| `packages/client-runtime/src/connection/layer.ts`                                | 视情况（缺省实现是 `Context.Reference`，可能不用改）                                                                     | 0–3      | 8.4  |
| `apps/web/src/components/settings/ConnectionsSettings.tsx`                       | 渲染 `DevicesSettings`                                                                                                   | 2        | 8.4  |
| `apps/web/src/connection/runtime.ts`、`apps/mobile/src/connection/runtime`       | 提供真实的 `DeviceKeyAuthorization`                                                                                      | 10       | 8.4  |
| `apps/web` 设置搜索 / 命令面板入口                                               | 搜索条目、"Invite a device" 命令                                                                                         | 12       | 8.4  |
| `apps/mobile/src/Stack.tsx`、`App.tsx`                                           | 两个路由、前台同步                                                                                                       | 14       | 8.4  |
| web / mobile 的 `zh-Hans/index.ts`                                               | 并入新 catalog                                                                                                           | 2        | 8.4  |
| `package.json`                                                                   | `fork:selfhost:e2e` 脚本                                                                                                 | 1        | 8.5  |
| `scripts/fork-dist-mac.ts`（fork 自己的脚本，不算上游）                          | 放入并签名 frpc                                                                                                          | –        | 8.5  |

**合计约 175–200 行（留余量按 225 算），约 31 个上游文件**（server 与契约约 70，client-runtime 约 70–80，web / mobile / desktop 约 50；8.0 实测后比上一版多了 `dpop.ts`、`McpOAuth.ts`、`McpHttpServer.ts` 三个文件和 `clientKey` 的约 8 行）。改动里**每一处都只是一个调用、一个分支或一行 export**，逻辑在 `fork/` 里；这个数字比第一版的 40 行大四五倍，是为了换"设备环境永远走不到官方 relay"和"隧道进来的 DPoP 能验证通过"。

**不会动**：`packages/contracts/src/auth.ts` 和 `environmentHttp.ts`（不改 `/oauth/token` 的契约）、`auth/EnvironmentAuth.ts`、`auth/SessionStore.ts`、`registry.ts`、`supervisor.ts`、`presentation.ts`、`diagnosis.ts`、`connection/errors.ts`（设备环境的 target 是 Bearer，不会命中 relay 分支；`connectionMethod` 由 fork 模块显式传 `"direct"`）、任何数据库迁移、`apps/mobile/app.config.ts` 与 native 模块。

### 6.3 与共存保证的核对

| 项                  | 结论                                                                                                                  |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| 端口                | 没有新的本地监听端口；frpc 只出站；server 沿用 3873。测试用 `127.0.0.1:18443`，不碰官方的 3773                        |
| 目录                | 全部在 `~/.<fork home>/userdata` 下（`ServerSecretStore` / `stateDir`）；frp 缓存在 fork home 的 `bin/`，不是 `~/.t3` |
| URL scheme          | 不新增；深链形式将来使用 `FORK.scheme`                                                                                |
| git refs            | 无                                                                                                                    |
| 钥匙串 / 签名       | 不新增钥匙串项；frpc 用现有的 `T3 Extend Code Signing` 身份签名                                                       |
| 官方 T3 Code 的数据 | 不读不写 `~/.t3`；设备身份和官方应用没有任何交集                                                                      |
| `fork:guard`        | 新代码不含官方身份字面量；`.t3` 字符串（带引号的）要避免，frp 路径用 `FORK` 常量                                      |

### 6.4 每个平台各得到什么，以及 AGENTS.md「Hit every surface」核对

| 平台                     | 得到                                                                                                                                                                           |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 桌面（Electron）         | 完整：加入、邀请、移除、重命名、离开、Advanced；server 托管 frpc 并随 app 启停；渲染进程经本机 server 代签通行证连接其他电脑；内置 frpc 并签名；陈旧告警和"尚未同步的电脑"提示 |
| Web（server 提供的页面） | **没有 Devices 区**：`devices.*` 只对 `desktop-bootstrap` 开放，普通浏览器（含配对链接来的、哪怕有 `access:write`）不加入、不管理、也不读清单；继续用配对链接 + 一次性码       |
| 手机                     | 加入（扫码或粘贴）、设备清单、自动出现所有电脑（含之后加入的）、通行证登录、前台刷新、离开；**没有**邀请 / 移除                                                                |
| 无头 `t3x`               | `t3x devices join/list/invite/remove/leave/tunnel`；server 托管 frpc；没有渲染进程，不需要代签                                                                                 |

| AGENTS.md 清单项 | 是否适用，怎么处理                                                                                                                                         |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入口             | 适用。设置页之外：命令面板里加 "Invite a device" 动作（只在桌面渲染进程），无头 CLI；快捷键不加。命令面板条目放进 8.4 验收                                 |
| 客户端           | 适用，见上表。共享逻辑放 `packages/client-runtime/src/fork/` 和 `packages/shared`                                                                          |
| Providers        | 不适用：功能与 provider 无关，六个 adapter 都不动                                                                                                          |
| Agents / MCP     | **有意不提供**：agent 不应能给自己的电脑加设备或移除设备；定时任务同理。服务逻辑仍是 service 方法，传输层（`ws.ts`、HTTP 路由、CLI）保持很薄               |
| 契约             | 适用：`packages/contracts/src/forkDeviceKeys.ts`；server / web / mobile / desktop 一起跟随。`access:write` 的写入登记 `CLIENT_GUARDED_RPC_SCOPES`          |
| 反向状态         | 适用且已覆盖：加入 ↔ 离开；邀请 ↔ 取消邀请；加入 ↔ 移除；"这台电脑被移出"的显示；"看得到"：设备清单、待用邀请、`stale` 状态                                |
| 连接方式         | 适用：公网子域名是 `public` 路由，LAN / tailnet 来自学习路由，通行证以 environmentId 为 `aud` 所以三者通用；多设备、多环境（多台电脑）是核心场景           |
| 文档             | 适用：FORK.md「自建连接」会变得不准确，8.5 重写；`docs/user/remote-access.md` 新增一节；`docs/internals/` 只加一页决策说明（遵循"只写代码读不出来的原因"） |

## 7. 测试计划

测试规则沿用 AGENTS.md：测能出错的行为（协议、鉴权、持久化、竞态、外部格式解析）；在最低的一层写；用 `it.effect` 的 `TestClock` 和 `Deferred`，不写 `sleep` 轮询；浏览器测试用 `await using screen = await render(...)`。

### 7.1 逐层单元测试

| 层                          | 测什么                                                                                                                                                                                                                                                                                                   | 位置                                                          |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| 协议库（shared）            | 指纹（RFC 7638 向量）；JWS 签发 / 验证往返；通行证和 ticket 的字段校验（过期、`exp-iat>120`、缺 `cnf`、`aud` 错）；邀请编解码（版本未知、截断、base64 污染）；子域名派生（汉字、emoji、保留名、长度、冲突后缀）                                                                                          | `packages/shared/src/forkDeviceKeys/*.test.ts`                |
| **交叉向量**                | 同一组固定私钥生成的请求签名 / 通行证 / ticket 向量，分别被 shared（noble）和注册表（`node:crypto`）验证；一旦两边不一致测试就失败。向量文件放 shared，注册表测试读取它                                                                                                                                  | `packages/shared`（生成），`infra/self-host/registry`（读取） |
| 注册表（`node --test`）     | 邀请：并发兑换只有一个赢家、过期、种类不符、密钥错；加入：名字冲突、子域名分配；签名请求：重放、时间窗、`htu` 带查询串被篡改、`bh` 被篡改、手机调用邀请 / 移除被拒；`If-None-Match`；限速；`ask`：只放行登记的子域名；插件四个 op 的放行 / 拒绝、1.5 秒时限、在途上限、`reject_reason` 取值；SQLite 并发 | `infra/self-host/registry/*.test.mjs`                         |
| server：DeviceIdentity      | 首次生成、重启读回、文件权限 0600、损坏文件的处理                                                                                                                                                                                                                                                        | `apps/server/src/fork/deviceKeys/*.test.ts`                   |
| server：DeviceDirectory     | 同步 200 / 304 / 网络错误；`stale` 状态；对账（已消失设备的会话被撤销、仍在的不动、与消失同时到达的新通行证）；自己被移除后的自清理；变更流只在变化时发布                                                                                                                                                | 同上                                                          |
| server：DeviceAssertionAuth | 每个 `t3x_reason` 一个反向用例；成功路径会话内容（subject、scope、label、`jkt`）；**手机会话缺 `access:write`**；`jti` 重放；DPoP 头缺失或指纹不符；先全部验证、最后才消耗 `jti`                                                                                                                         | 同上                                                          |
| server：signAssertion       | 三个条件各自单独不满足时被拒（非 `desktop-bootstrap`、带转发头、目标不在清单或是自己）；限速                                                                                                                                                                                                             | 同上                                                          |
| server：DeviceTunnel        | frpc 配置快照（心跳、`poolCount`）；退避序列；三句日志 × `reject_reason` 的分流表；12 小时轮换；ticket 不出现在命令行参数里；frpc 不存在时的状态和提示                                                                                                                                                   | 同上（假 frpc 可执行文件）                                    |
| server：RPC 权限            | 新增受保护方法的 `CLIENT_GUARDED_RPC_SCOPES` 行为测试（AGENTS.md 明确要求）                                                                                                                                                                                                                              | 现有的权限测试文件里加行                                      |
| 限速                        | `/oauth/t3x-device` 的 401 计入、429 返回；`X-T3x-Client-IP` 只在回环对端且为合法 IP 时采用（3.11）；`requestOrigin` 的三条件逐个反例                                                                                                                                                                    | `AuthAttemptLimiter.test.ts` 加行；`requestOrigin.test.ts`    |
| client-runtime              | 缺省 `DeviceKeyAuthorization` 阻断；resolver 的 `t3x-device` 分支不回退；发现顺序与 URL 检查；钉住；同步器：增 / 删 / 改 URL，用户手动添加的环境不被动；占位凭据永远不会被读取；`routes.ts` 三处规则；诊断不出现 relay                                                                                   | `packages/client-runtime/src/fork/deviceKeys/*.test.ts`       |
| web                         | `DevicesSettings` 各状态（未加入、已加入、清单过期、被移出、加入失败的几种错误）；邀请对话框显示绝对过期时间且没有定时器；Advanced 折叠里的旧功能仍在                                                                                                                                                    | `*.browser.test.tsx`（`render` from `apps/web/test/render`）  |
| mobile                      | 密钥生成 / 读回 / 损坏恢复（mock SecureStore）；加入页的错误态；前台刷新的节流（≥30 秒）；移除后环境消失                                                                                                                                                                                                 | `apps/mobile/src/fork/deviceKeys/*.test.ts`                   |
| 打包                        | `forkFrp` 版本与 compose 一致；归档 SHA-256 校验失败时拒绝；`fork-dist-mac` 的 Mach-O 校验清单里包含 `frpc`                                                                                                                                                                                              | `packages/shared`、`scripts/`                                 |

### 7.2 本机能跑的端到端（不用真实 VPS）

`vp run fork:selfhost:e2e`（8.5 交付），先决条件只有 Docker Desktop 和 `scripts/fork-fetch-frp.ts` 能下载 8.0 选定版本的 frpc（SHA-256 校验后放进缓存；离线时用 `--frpc-path`）。

**环境搭建（每次运行，随后全部清理）**

| 项          | 做法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Docker      | `docker compose -p t3x-e2e -f docker-compose.yml -f docker-compose.test.yml up -d --build`。测试覆盖文件把 Caddy 的 `ports` 改成 **只** `127.0.0.1:18443:443`（不发布 80、7000、8080），换用 `Caddyfile.test`（`tls internal`，其余与生产一致），`T3X_DOMAIN=t3.localhost`、`T3X_PUBLIC_PORT=18443`。结束时 `down -v`。项目名固定为 `t3x-e2e`，不碰别的 compose 项目                                                                                                                                                                                                                                         |
| 域名        | `t3.localhost` 与 `*.t3.localhost`。**不改 `/etc/hosts`，也不需要 DNS 预载脚本**：8.0 实测 Node、curl、frpc（Go）在本机都能直接解析 `*.localhost`。唯一的坑：解析结果里 `::1` 在前，compose 只发布 `127.0.0.1` 时 IPv6 连接先被拒再回落到 IPv4（curl 实测如此）。harness 二选一：给 Node 子进程加 `NODE_OPTIONS=--dns-result-order=ipv4first`，或在 compose 里同时发布 `[::1]:18443:443`，实现时选能跑通的。frpc 直接用 `serverAddr = "t3.localhost"` + `serverPort = 18443`（8.0 就是这样登录成功的）。需要浏览器（Electron / Chromium）参与的场景用 `--host-resolver-rules="MAP *.t3.localhost 127.0.0.1"` |
| 信任内部 CA | `docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt` 取出根证书到临时目录。子进程环境里设 `NODE_EXTRA_CA_CERTS=<该文件>`；frpc 配置里写 `transport.tls.trustedCaFile`；浏览器场景用 `--ignore-certificate-errors-spki-list=<该证书 SPKI 哈希>`。**不写系统钥匙串，不改全局设置**，进程退出后随临时目录消失                                                                                                                                                                                                                                                                                   |
| 两台"电脑"  | 用本 worktree 的 server 入口启动两个实例，`--home-dir <mktemp -d>`（绝不使用 `~/.t3` 或 fork 的真实 home），端口各取空闲端口；`vp run dev` 的世界之外，harness 记录自己启动的每个 PID，结束时只杀这些 PID                                                                                                                                                                                                                                                                                                                                                                                                    |
| "手机"      | 一个 Node 脚本，使用 shared 协议库 + 与真实手机相同的 P-256 代码路径（私钥存在内存里，不是 SecureStore）。它模拟的是协议，不是 Android 界面                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

**场景（每条都断言事件，不用 sleep）**

1. VPS 一次性：`./t3x invite --kind computer` 出邀请（字符串 + 二维码非空）。
2. 电脑 A `t3x devices join <邀请>` → 清单里有 A；A 的隧道 `online`（等待注册表的 `last_tunnel_at` 变化，通过 `Deferred` 订阅 `devices.subscribe`，不轮询）；`https://a.t3.localhost:18443/.well-known/t3/environment` 返回 A 的环境 id。
3. A 邀请"手机" → 手机加入 → 清单里有手机 → 手机通过通行证拿到 A 的 DPoP 会话 → 用该会话调一次只读 RPC 成功；在 A 的 "Authorized clients" 里以手机的名字出现。
4. 电脑 B 加入；A 和 B 互相能看到并通过通行证互相登录（走 `devices.signAssertion` 的路径，需要一个 `desktop-bootstrap` 主体的会话，harness 如何得到它见第 10 节问题 5）。
5. 手机会话调用 `devices.invite` 被 server 拒绝；手机直接调注册表 `POST /invites` 被拒绝。
6. 移除手机（在 B 上操作）→ 在 A 上调用 `devices.refresh` → 手机的会话消失、已连接的 WebSocket 被关闭；手机再换通行证失败 `device_revoked`。（生产里同样的事在 60 秒内发生，这里用 `devices.refresh` 替代等待，证明的是对账逻辑，间隔本身由 `TestClock` 的单测覆盖。）
7. 移除 B（仍在运行）→ **一个心跳（约 35 秒）内** B 的 frpc 日志出现 `pong message contains error: t3x:revoked`，B 的 server 自清理后状态是"未加入"，`https://b.t3.localhost:18443/` 变 frps 的 404。其间已建立的连接可能仍然 200，不要断言"立刻拒绝"。
8. 子域名冒用：A 的 frpc 配成 `subdomain = "b"` → `NewProxy` 被拒。
9. 重放：同一张通行证第二次使用被拒；篡改 `aud`、`cnf.jkt` 被拒。
10. VPS 离线：`docker compose stop registry caddy`，局域网地址上（`127.0.0.1:<A 的端口>`，用现有直连路由）手机用缓存清单仍能换会话；恢复后同步继续。
11. 重连：`docker compose restart frps` → frpc 自动重连，ticket 仍有效，隧道恢复；把 ticket 的 `exp` 调成已过期 → frpc 日志 `connect to server error: t3x:ticket-expired` → DeviceTunnel 重新生成配置并重启。
12. 证书：访问一个**从未登记**的 `evil.t3.localhost:18443` → TLS 握手失败（`ask` 返回 403，`tlsv1 alert internal error`）。已移除电脑的子域名**不要**断言握手失败：旧证书继续有效，握手成功、frps 返回 404（8.0 实测）。
13. 慢插件和宕机：按 8.1 的两条验收各跑一次，端到端层面确认电脑 A 的隧道在注册表重启后自动恢复，不需要人工操作。

### 7.3 手动检查（一次，打包后）

- Electron 里（`test-t3-app`，用 `Replay (dev)` provider，零费用）：加入 → 邀请 → 移除的完整界面流程，中英文对照截图。
- 签名后的 DMG 里 `frpc` 的 `codesign --verify --strict`；**不启动签名包**（会写 fork 的真实数据库，沿用 P7 的做法）。8.0 已在单个二进制上验证过 `--options runtime` 签名能运行、无钥匙串弹窗，这里验证的是它在 `.app` 里被现有流水线一起签。

### 7.4 没有安卓设备访问之前无法测试的

| 项                                                                                                   | 为什么测不了            | 当前替代                                                                |
| ---------------------------------------------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------- |
| Android Keystore 对 `expo-secure-store` 的实际保护（锁屏后读不出、`WHEN_UNLOCKED_THIS_DEVICE_ONLY`） | 需要真机 / 模拟器       | 单测 mock；文档里写明未验证                                             |
| 相机扫描二维码（`expo-camera`）解码 200 字符的 QR                                                    | 同上                    | 对生成的 QR 做解码往返单测（用 shared 的编码器 + 解码库）               |
| 前台恢复触发刷新（`AppState`）、网络切换（Wi-Fi ↔ 蜂窝）下的路由切换                                 | 同上                    | 单测覆盖节流逻辑；路由切换逻辑是上游已有的                              |
| 手机 → 公网域名 → 局域网回切的整体体验、回到家自动切回局域网                                         | 需要同时有手机和 VPS    | 7.2 里用"模拟手机"验证协议部分                                          |
| 推送：设备会话下 `push.register`、ntfy 在通配域名下的 `ntfy.<域名>`                                  | 需要 UnifiedPush 与真机 | 沿用 `apps/server/scripts/verify-ntfy-push.ts` 对测试 compose 里的 ntfy |
| 中文界面在手机上的字号 / 层次                                                                        | 需要真机截图            | 用户的审美验收项，留到设备访问开放后                                    |
| 低端 Android 上的 P-256 签名耗时                                                                     | 需要真机                | noble 的 P-256 签名在手机 JS 里通常几十毫秒，一小时一次 [推断]          |

## 8. 阶段 8.0 的实测结果

2026-11-03，测试方在本机（macOS，Docker Desktop）用 **frp v0.71.1**（客户端与服务端同版本）、Caddy 本地 CA（`tls internal` / `local_certs`）、`node:24-alpine`（v24.18.1）跑了一遍。没有改仓库，没有动 `~/.t3` / `~/.t3extend`。下面是事实本身，不是链接；"设计影响"一列说明正文哪里按它改过。

### 8a 版本记录

| 项                               | 值                                                                                                                                                |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 选定版本                         | **frp v0.71.1**，发布于 2026-10-14（`published_at` 2026-10-14T09:52:45Z），最新稳定版（非 pre-release）                                           |
| `frp_0.71.1_darwin_arm64.tar.gz` | SHA-256 `d15d0324b99e14619c9aa46e37f6db588c06a09be4bc6f7948890b6b61077842`（对照同次发布的 `frp_sha256_checksums.txt`，`shasum -a 256 -c` 为 OK） |
| `fatedier/frps:v0.71.1`          | digest `sha256:48720c81f048e842f7f0b8053753c1a8514053d59d2dee8a953f67995de73a18`                                                                  |
| 其他平台归档                     | 打包时从同次发布的 `frp_sha256_checksums.txt` 取，写进 `scripts/fork-fetch-frp.ts` 的表，不在设计阶段猜                                           |

### 8b 15 项结果

| #   | 要验证                                                        | 结果     | 实测事实                                                                                                                                                                                                                                                                                            | 设计影响                                                                         |
| --- | ------------------------------------------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| 1   | wss → Caddy `/~!frp` → frps:7000，不开 `tls.force`            | 通过     | frpc 日志 `login to server success, get run id [acecc0aae91dfd0e]`、`[t3x] start proxy success`；websocket 路径 `/~!frp`                                                                                                                                                                            | Q6：不需要 `transport.tls.force`                                                 |
| 2   | `Login` 收到 `metas.t3x_ticket`；`reject_reason` 进 frpc 日志 | 通过     | Login 体里有 `"metas":{"t3x_ticket":"dummy-ticket-value"}`；`Ping`/`NewProxy`/`NewWorkConn` 在 `content.user.metas`。拒绝时 frpc 原文 `pong message contains error: t3x denied`、`connect to server error: t3x denied`                                                                              | ticket 放 `metadatas` 可行；3.7 用固定的 `t3x:…` reason                          |
| 3   | TCPMux 默认下心跳关闭；显式 30 秒后有 `Ping`                  | 通过     | 不写 `heartbeatInterval` 跑 25 秒：只有 `Login`/`NewWorkConn`/`NewProxy`，没有 `Ping`。写 30 后 08:32:34.863Z（登录当刻）、08:33:04.865Z、08:33:34.868Z、08:34:04.868Z，间隔 30.000–30.006 秒                                                                                                       | 配置必须显式写 `heartbeatInterval = 30`（3.7）                                   |
| 4   | 拒绝 `Ping` 后断开、重连、被 `Login` 拒绝；耗时               | 通过     | 08:37:10Z 改成拒绝，上一次成功 Ping 08:36:53Z；08:37:23.879Z `Ping` 被拒（**13.0 秒**）；18 ms 后重登又被拒。之后 frpc 不退出，约 2、4、9、19、20 秒重试。另一次观察到约 30 秒                                                                                                                      | 切断上界 = 一个心跳（约 30 秒）；承诺改写（0.3、Q6）                             |
| 5   | 首次登录成功后失败：重试还是退出；可匹配的文字                | 通过     | 进程一直活着（`loginFailExit = false`）。可匹配：`pong message contains error: `、`connect to server error: `、`StartWorkConn contains error: `。**没有** "login to the server failed"                                                                                                              | `DeviceTunnel` 只匹配这三句（3.7 日志表）                                        |
| 6   | HTTP vhost：Host、`X-Forwarded-Proto`、SSE/WS、XFF            | **要改** | `host` 原样；**`x-forwarded-proto: http`**（被 frps 改写）；`x-forwarded-for: 192.168.80.1, 192.168.80.4`（多一跳，最右是 Caddy 容器）；`x-t3x-client-ip: 192.168.80.1` 穿过 frps。SSE 首字节 2.5 ms，WebSocket 101 并能 echo                                                                       | 3.11：协议和 issuer 改从本机配置来，限速键改读 `X-T3x-Client-IP`                 |
| 7   | `ask` + `tls internal` + 显式站点 + catch-all 共存            | 通过     | `ask` 允许后握手 38 ms 拿到证书（SAN = 该名字），第二次 3 ms 不再问 `ask`；`t3.localhost/v1/info` 仍是注册表，`/` 是 Caddy 自己的 404；catch-all 没抢走显式站点                                                                                                                                     | Q6 的 Caddyfile 结构成立；不做证书预热                                           |
| 8   | `*.t3.localhost` 解析                                         | 通过     | Node `dns.lookup`、Python `getaddrinfo`、curl 都解析成 `::1` 和 `127.0.0.1`；curl 先连 `::1:18443` **被拒**（compose 只发布了 `127.0.0.1`），再落到 IPv4 成功；frpc（Go）`serverAddr = t3.localhost` 直接登录成功                                                                                   | 不需要 DNS 预载脚本；IPv6 先被拒的处理见 7.2                                     |
| 9   | `node:sqlite` 在 `node:24-alpine` 无标志可用                  | 通过     | `{"mode":{"journal_mode":"wal"},"n":{"n":200},"ms":0,"node":"v24.18.1"}`；`import { DatabaseSync } from "node:sqlite"` 不需要 `--experimental-sqlite`                                                                                                                                               | Q5 已改标 [实测]                                                                 |
| 10  | frpc 签名                                                     | 通过     | `codesign --force --options runtime --timestamp=none --sign "T3 Extend Code Signing"` 后 `--verify --strict` 通过，`frpc -v` 打印 0.71.1；`flags=0x10000(runtime)`，`Authority=T3 Extend Code Signing`，`Mach-O thin (arm64)`；**没有钥匙串弹窗**                                                   | 不需要额外 entitlement；8.5 照 `fork-dist-mac.ts` 现有流水线签                   |
| 11  | `proxy_name` 形式                                             | 通过     | `user = deviceid01234567`、`name = t3x` → `NewProxy` 里 `"proxy_name":"deviceid01234567.t3x"`，`"proxy_type":"http"`，`"subdomain":"a"`；frps 日志 `http proxy listen for host [a.t3.localhost]`                                                                                                    | 插件按 `<user>.<name>` 比对                                                      |
| 12  | 选版本、核对插件协议                                          | 通过     | 见 8a；`Login`/`NewProxy`/`Ping`/`NewWorkConn` 的 op 名和字段与文档一致。OIDC 没有做（3 和 5 都通过）                                                                                                                                                                                               | 全文改钉 v0.71.1；去掉 OIDC 备选的设计                                           |
| 13  | 插件挂了或很慢                                                | **要改** | 进程挂了：`Login`/`Ping`/`NewWorkConn` 都**失败关闭**（`send <Op> request to plugin error`；`NewWorkConn` 时用户请求得到 frps 的 404，等了 5.4 秒）。变慢：`Login` 睡 8 秒，8 秒后才 `login to server success`，插件日志 `waitedMs: 8003`。源码：`http.Client` 无 `Timeout`，`context.Background()` | 注册表自己设 1.5 秒时限、在途上限、独立监听器、healthcheck（Q6）                 |
| 14  | 撤销后 `NewWorkConn` 与既有连接                               | **要改** | 默认 `poolCount = 1`。08:39:19.370Z 改成拒绝后立刻打两个请求：**都是 HTTP 200**（25 ms、9 ms）；唯一的 `NewWorkConn` 是补池那次，被拒（`StartWorkConn contains error: t3x denied`），没挡住前两次。池子用完之后才被拒（frps 404）                                                                   | 不把 `NewWorkConn` 当切断点；承诺改成"最多一个心跳"；`poolCount = 0`（8.1 实测） |
| 15  | `ask` 与已签发证书、catch-all                                 | **要改** | `fresh.t3.localhost` 签发后从名单删除：握手仍成功（2 ms），不再问 `ask`；无隧道时 HTTP 是 frps 的 404，TLS 不报错。`a.t3.localhost` 名单清空后证书还在，隧道重连后仍 200。从未允许的 `never.t3.localhost`：`ask` 403，握手 `tlsv1 alert internal error`                                             | `ask` 撤不回证书；访问控制靠插件和电脑自己的鉴权（Q6、4.1 情形 5）               |

### 8c 留到阶段 8.1 / 8.2 开工时确认的

8.0 在本机跑，下面这些它覆盖不到，开工时各做一次，结果写回本节：

| 阶段 | 要确认                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------- |
| 8.1  | `poolCount = 0` 的撤销效果（拒绝后**新连接**是否立刻被拒）和新连接首字节延迟（阈值 50 ms）                              |
| 8.1  | Caddy 的 `header_up X-T3x-Client-IP` 是否真的覆盖客户端自带的同名头（8.0 只看到了它等于第一跳，没试伪造）               |
| 8.1  | 插件宕机时 `NewProxy` 单独被打到的表现（8.0 里宕机时 `Login` 先失败，没单独覆盖）                                       |
| 8.1  | Let's Encrypt 实网首次签发的耗时（8.0 用的是本地 CA）；生产 443 端口下 `Host` 不带端口                                  |
| 8.1  | `frps.toml` 里 `subDomainHost = "{{ .Envs.T3X_DOMAIN }}"` 的环境变量模板在 v0.71.1 下是否照常展开                       |
| 8.1  | `libqrencode-tools` 在 `node:24-alpine` 对应的 Alpine 版本里是否存在、可执行文件是否叫 `qrencode`                       |
| 8.1  | 公网 API 打满时插件的 p99；若超过 100 ms，把插件挪进 `worker_threads`                                                   |
| 8.2  | Linux 的 frpc（无头）：SHA-256 从 `frp_sha256_checksums.txt` 取，运行一次 `frpc -v`                                     |
| 8.2  | 回环对端 + 隧道源的 `Host` 改写后，DPoP 经 `https` 隧道真的验证通过（端到端里的第一个 `/oauth/t3x-device`）             |
| 8.2  | 续期时用 `replaceActiveForSubjectAndMethod` 压成每设备一行，是否会让已连接的 socket 掉线（`SessionStore.ts:1043-1100`） |

## 9. 以后再做的安全加固（2026-11-03 用户同意先记下，暂不做）

这三项和 `tasks/todo.md` 阶段 8 末尾的清单一致。当前设计为它们留了位置，不需要推翻重来：

| 加固项                                                                                                | 现在已经留下的接口                                                                                                 | 做的时候要改什么                                                                                                                                                                                                                                                                                |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 电脑自己解 HTTPS：VPS 只按 SNI 转发加密后的字节，每台电脑自动申请 / 续期自己的证书                    | 一台电脑一个子域名，一个设备 id；`aud` 用 environmentId 而不是 URL，所以改了传输层通行证仍然有效                   | Caddy 换成按 SNI 的四层转发（`caddy-l4` 或 frps 的 HTTPS vhost / `https` 代理类型）；电脑端内嵌 ACME 客户端并通过 HTTP-01/TLS-ALPN-01 经隧道完成验证；`X-T3x-Client-IP` 不再可用，限速改读 PROXY protocol；`ask` 端点不再需要                                                                   |
| 设备清单由设备签名：电脑只认签过名的清单，新增 / 移除都要已有设备签名                                 | 清单里已经带每台设备的 `jwk`；`rev` 单调递增；`kid` / `rid` 已在所有 JWS 里                                        | 清单变成 `{rev, prev, entries[], sig, signer}` 的链；注册表只存储转发，不再有写权限；电脑和手机从第一份已知清单（加入时钉住）起验证链；`./t3x revoke` 要变成"由管理员设备签名"的请求，或者保留一个只在 VPS 本机持有的管理员钥匙。**做完它，"注册表被替换 / 域名被劫持"（4.2 情形 11）才算解决** |
| 手机私钥改成不可导出：Android Keystore / iOS Secure Enclave 里的原生 P-256 钥匙，私钥永远不出安全芯片 | 选 P-256 就是为了这条路：Secure Enclave 只支持 P-256；设备密钥与 DPoP 密钥分开，换实现只换设备密钥；通行证格式不变 | 写原生模块（会改变 Android 的 native fingerprint，需要重新 `mobile:install`），JS 侧只拿到"请签这段数据"的接口；需要真机测试；迁移是"新密钥 → 用旧密钥签一份换钥请求 → 注册表替换公钥"，或直接当新设备重新加入                                                                                  |

前两项合起来，工作量大约在本阶段基础上再多一半。第三项需要真机，等 Android 设备访问开放后再排。

## 10. 需要主控拍板的问题

上一版的 7 个问题，主控已经逐条决定（见 0.4），不再列出。下面是修订后**新出现的、或我有保留的**，每项给出默认。

1. **注册表钉住只防"填错地址"，防不住控制域名的人。** 主控要求"加入时钉住注册表源和 registry id"，我做了；但 `registryId` 在公开的 `/v1/info` 和邀请里，抄一份就能冒充。真正能防住"注册表被替换 / 域名被劫持"的是第 9 节第二项（清单由设备签名）。我在 4.2 情形 11 里如实写成残余风险，没有把钉住包装成防线。**默认：接受这一点，不额外设计注册表公钥**（那会让邀请变长，且仍是 TOFU）。
2. **`desktop-bootstrap` 只来自桌面 app，所以无头服务器没有 Web 管理页。** 第 6 条的结果：`devices.*` 对配对浏览器一律拒绝，也不让它们读清单。无头机器只能用 `t3x devices` CLI 管理，这与 `t3 pair` 一致。**默认：这样，不再放宽。** 以后要给配对浏览器只读，是放宽的方向，容易加。
3. **7 天上限的实际撤销上界是 7 天加 1 小时，且依赖电脑本机时钟。** `fetchedAt` 用本机时钟比较，用户把系统时间往回拨可以让清单"不过期"。这要求攻击者已经在这台电脑上有权限（到那一步他能做的更多），我没有为此加单调时钟。**默认：接受。**
4. **上游接线约 175–200 行（余量按 225）、约 31 个文件。** 比第一版大得多；8.0 之后多了 `dpop.ts`、`McpOAuth.ts`、`McpHttpServer.ts` 三处"协议推导"和 `clientKey` 的规则，每处都是调用或分支。**8.4 的"其他直接用 `RemoteEnvironmentAuthorization` 的 `state/*.ts`"这一行还没读**，行数是估计的上沿。若 8.4 开工 grep 后超过 230 行，我会停下来再汇报，不会静默扩大。**默认：照此推进。**
5. **端到端要给"本机 owner"会话。** 7.2 的场景 3、4 要调 `devices.signAssertion`，需要一个 `desktop-bootstrap` 主体的会话。harness 里我打算用 `t3x auth session issue --subject desktop-bootstrap`（`cli/auth.ts` 有 `--subject` 参数，`subjectFlag`）。**我没核实这个 CLI 是否允许任意主体**；不允许的话，harness 改为读取 server 启动时打印的 bootstrap 凭据。需要 8.2 开工时确认，不影响设计。
6. **8.0 的结果已经回来（第 8 节），改动见 0.5。** 留到开工时确认的在 8c 节，其中对设计影响最大的两条：`poolCount = 0` 在 8.1 实测，效果不好就退回 1（承诺不变）；隧道源 `Host` 改写后经 `https` 隧道的第一个 DPoP 在 8.2 端到端里跑通。**默认：照 8c 节推进。**

### 我没有核实的前提（汇总）

- 第 8c 节列的事：8.0 在本机用本地 CA、docker-proxy 跑的，覆盖不到 Let's Encrypt 实网签发耗时、生产 443 端口下的 `Host`、Linux 的 frpc、`poolCount = 0`、Caddy 对伪造头的覆盖、`frps.toml` 环境变量模板。
- 客户端 layer 的组装点（`apps/web/src/connection/runtime.ts`、`apps/mobile/src/connection/runtime`）、`serverExposure.getAdvertisedEndpoints` 与 server state 目录是否一致、手机 `Stack.tsx` 路由写法、`state/*.ts` 里其他直接使用 `RemoteEnvironmentAuthorization` 的位置是否都经 `environmentHttpAuth`：都没有逐行读，8.4 开始前要先读。
- `ws.ts` 的 RPC handler 装配处是否能方便地拿到已验证的 `VerifiedSession`（`ws.ts:3460` 附近的 `session` 变量说明有，但没有读工厂调用处）。
- `libqrencode-tools` 在 `node:24-alpine` 对应的 Alpine 版本里是否存在、包里的可执行文件名是 `qrencode`：用户给定，8.1 验收时构建一次确认。
- 没有读 `~/.t3/userdata`、`~/.<fork home>/userdata`、凭据、钥匙串或 `.env`；没有运行任何进程、Docker 或 Tailscale。
