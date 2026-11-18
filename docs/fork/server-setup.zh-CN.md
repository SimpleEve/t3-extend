# 搭建 T3 Extend server，让手机和别的电脑连上来

[English](./server-setup.md) | 简体中文

这份指南从零开始：怎么把 T3 Extend 的 server 跑起来，怎么选一种访问方式，让手机、别的电脑和浏览器连到它。读者已经拿到了 T3 Extend，但不需要了解它的内部。

先统一几个词：

- **host**：跑 server 和 agent 的那台电脑。项目、provider 的登录和 agent 的工作都留在它上面。
- **客户端**：用来操作 host 的界面，包括桌面版、浏览器里的网页版和 Android 应用。
- **配对链接**：一串带一次性码的地址或二维码，客户端用它换一个可以单独撤销的会话。**它相当于凭证**，不要贴进截图、日志或工单。

界面名称按简体中文界面写，英文界面的对应名称见[文末的对照表](#界面名称对照)。命令一律写 `t3x`，这是 T3 Extend 的命令行名字，和官方 T3 Code 的 `t3` 互不干扰。上游文档里写 `t3` 的地方，在 T3 Extend 里都换成 `t3x`。

## 1. 先选访问方式

| 方式       | 适合                                                 | 要准备                                                         | 安全性                                                                              | 手机                                        |
| ---------- | ---------------------------------------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| 本机       | 只在 host 自己身上用                                 | 什么都不用                                                     | 默认只有本机能访问                                                                  | 不适用                                      |
| 局域网配对 | 家里或办公室，设备在同一个网络                       | host 打开"网络访问"（或 `--lan`）                              | 明文 http，同一网络里的人能读到流量；配对码是唯一的锁                               | 可以，Android 允许明文 http                 |
| Tailscale  | 设备分散在不同网络，已经在用 Tailscale               | 两端加入同一个 tailnet；tailnet 开 MagicDNS 和 HTTPS 证书      | 走 Tailscale 的加密；HTTPS 端口用 8443                                              | 手机要装 Tailscale 并加入同一个 tailnet     |
| 自建服务器 | 任何地方都要连回家里的电脑，不想让手机装 VPN         | 一台自己的 Linux VPS、一个域名、两条 DNS 记录、VPS 上有 Docker | HTTPS 在你的 VPS 上终止，**VPS 能看到明文**；每台设备一把密钥，丢了一台只移除那一台 | 可以，还能走不依赖 Google 的推送（Android） |
| SSH        | 桌面版去连一台远程 Linux，或另一台 Apple Silicon Mac | 能 SSH 到那台机器，那台机器装好 provider                       | 走 SSH；远端跑的是官方 T3 Code 的 server，没有 T3 Extend 的转发和推送               | 不可以，SSH 环境由桌面版建立                |

怎么选：

- 只在家里用，选局域网配对。
- 已经有 Tailscale，选 Tailscale，不用再买服务器。
- 出门在外要用，又不想装 VPN，或者想用 Android 推送，选自建服务器。
- 想用桌面版去驱动一台远程 Linux，选 SSH。

这几种可以同时存在。一台 host 有多条路线时，客户端按速度排序，用第一条能连上的（见上游文档的[Reach one machine several ways](../user/remote-access.md#reach-one-machine-several-ways)）。

### T3 Connect 在 T3 Extend 里默认用不了

T3 Connect 需要官方的 relay 地址和登录服务的公开配置，这些在官方构建时由官方的 `.env` 带进去。T3 Extend 没有这份 `.env`，所以：

- T3 Connect 的开关和命令（`t3x connect`、`t3x up --connect`）不可用，`t3x connect` 会提示 T3 Connect 在这个构建里不可用。
- guest link 和 passkey 同样默认不可用。
- 登录回跳绑定的是官方的 URL scheme，即使你自己提供 `.env`，Connect 登录也可能失败。

T3 Extend 用上面的几种方式代替它：自建服务器就是 T3 Connect 的替代，它不经过官方 relay，也不经过 Cloudflare。

## 2. 装好 server

### 桌面版

T3 Extend 目前只有 macOS（Apple silicon）的桌面版。拿到 `T3-Extend-<版本>-arm64.dmg` 后，按[上游文档的步骤](../user/install.md#t3-extend-on-macos)装进"应用程序"，第一次打开要在"隐私与安全性"里放行，并允许它用钥匙串。

桌面版自带后端，打开 app 就有一个 server，同时它也能作为 host：别的设备可以连到它。默认只有本机能访问，要让别的设备连进来，按下面各节开启。

T3 Extend 和官方 T3 Code 可以装在同一台电脑上，数据、命令、端口都分开：

|                 | 官方 T3 Code | T3 Extend     |
| --------------- | ------------ | ------------- |
| T3 home         | `~/.t3`      | `~/.t3extend` |
| 默认端口        | 3773         | 3873          |
| Tailscale HTTPS | 443          | 8443          |
| 命令行          | `t3`         | `t3x`         |

默认端口被占用时，server 会顺延到别的端口，实际端口以配对链接和日志里的为准。共存的细节见[上游文档](../user/install.md#running-next-to-official-t3-code)和 [FORK.md](../../FORK.md#共存保证)。

Android 应用是一个 APK，不在应用商店里，也没有 iOS 版。把 APK 拷到手机上打开，或者在电脑上运行 `adb install -r <apk>`。它和官方 T3 Code 的应用并排安装，互不替换（见[上游文档](../user/install.md#mobile-app)）。

### 命令行 `t3x`

桌面版带着 `t3x` 命令。新装的 app 第一次启动会装好它；以后想装、想移除，到「设置 → 关于」里操作。装好后打开一个新终端就能用：

```bash
t3x                # 在这个终端里启动 server，并在浏览器里打开网页版
t3x serve          # 在这个终端里启动 server，不开浏览器，打印配对信息（后台服务跑的就是它）
t3x serve --lan    # 同上，同时允许局域网和 tailnet 里的设备连进来
t3x pair           # 给已经在运行的 server 生成配对二维码和链接
t3x --help         # 列出所有子命令
```

几个说明：

- **没有桌面版的机器**（比如一台 Linux 服务器）：T3 Extend 目前没有发布 server 的安装包，官方的 `install.sh` 装的是官方的 `t3`，不要用它。这类机器能用的办法是从源码仓库运行，需要先装好依赖；本文只验证过桌面版自带的 `t3x`。
- `t3x` 的帮助文字里有些地方仍然写 `t3`，是上游的原文，不影响使用。
- 数据目录用 `--base-dir <目录>`（等价于环境变量 `T3CODE_HOME`）指定，默认是 `~/.t3extend`。

### 开机后台运行

默认情况下，退出桌面版（Cmd+Q）就等于关掉 server，手机会掉线。想让 server 一直在，有两种做法。

**桌面版的开关（macOS 打包版）**

打开「设置 → 维护 → 在后台保持运行」。它相当于 `t3x service install`，关掉就是 `t3x service uninstall`。打开后：

- 退出 app 时，后台服务接着跑，手机保持连接，推送也不断。
- 服务直接用 app 自带的运行时，不下载任何东西。app 要留在"应用程序"文件夹里，从磁盘映像里直接打开的拷贝会被拒绝。
- 同一份数据只能有一个 server。app 开着时，用的是 app 自己的 server，后台服务暂停；退出 app 后服务重新启动，手机会重连。
- 移动或删除了 app，这一行会提示；从新位置打开 app，把开关关掉再打开即可。装了新版本的 app 后，这一行会给出"修复"。
- 退出时服务没能启动，下次打开 app 会提示原因并给"重试"；app 崩溃或被强制退出时，服务会一直停着，直到下次打开再退出 app，或者重新登录。

macOS 的后台服务在你登录后启动、登出后停止，所以要让 Mac 保持登录，并且不休眠。

**命令行**

```bash
t3x service install     # 安装并启动
t3x service status      # 看状态和日志位置
t3x service restart
t3x service uninstall
t3x up --lan            # 安装服务并允许局域网和 tailnet 连入（写入 service.env 的 T3CODE_LAN=true）
```

限制：只有**桌面版安装的 `t3x`、并且在 macOS 上**，服务才会用 app 自带的运行时。其他情况（npm 装的、没有桌面版的机器）`t3x service install` 需要下载 server 安装包，而 T3 Extend 的仓库目前没有发布安装包，会失败。可以用环境变量 `T3CODE_RELEASE_BASE_URL` 指向你自己的发布镜像。`t3x update` 同理会失败。

服务的环境变量写在 T3 home 下的 `service.env`（T3 Extend 里是 `~/.t3extend/service.env`），例如 `T3CODE_PORT=3873`，改完运行 `t3x service restart`。

其余细节见上游的[后台运行文档](../user/background-service.md)，桌面版开关的说明在[该文档的 macOS 一节](../user/background-service.md#t3-extend-desktop-app-on-macos)。

## 3. 本机

host 自己用不需要任何设置：打开桌面版，或者在终端里运行 `t3x`。server 默认只监听本机，别的设备访问不到。

## 4. 局域网配对

**适合**：手机、另一台电脑、浏览器和 host 在同一个网络里。

> **明文 http 的风险。** 局域网里的地址是 `http://`，同一网络里的人能读到流量，包括配对码和之后的会话。开了网络访问，同一网络里知道端口的人都能到达它，配对码是唯一的锁。只在你信任的网络里用，不要在公共 Wi-Fi 上开。

### 在 host 上开启

- 桌面版：「设置 → 共享与访问」，打开"网络访问"。开关会重启 app，已经通过局域网连上的设备会断开，可以在同一个地方关掉。
- 命令行：`t3x serve --lan`（前台运行），或者 `t3x up --lan`（装成后台服务并开启）。

开启后 server 监听本地网络和 Tailscale 的地址，不监听公网地址。

### 生成配对链接

- 桌面版：「设置 → 共享与访问 → 已授权的客户端 → 创建链接」，选一个对方能访问到的地址（本机回环地址 `127.0.0.1` 只有本机自己能用）。设置页里创建的链接，只能在创建它的客户端上、该页面保持打开时复制；离开或刷新页面后要重新创建。
- 命令行：对已经在运行的 server 运行 `t3x pair`，终端里会打印二维码和链接。常用选项：`--ttl <时长>`（默认 5 分钟）、`--label <名字>`、`--scope <范围>`（可重复，限制这个链接能做什么；不写 `--scope` 就是全部权限，包括管理访问，建议只给需要的）。

每台新设备都用新的一次性链接，配对之后不需要原来的码就能重连。

### 客户端怎么加入

- **浏览器**：直接打开链接，形如 `http://<host 的局域网地址>:3873/pair#token=…`。
- **桌面版**：打开终端里打印的 `t3extend://pair` 链接，app 会让你确认服务器地址再添加；或者「设置 → 环境 → 添加环境」，粘贴链接。
- **Android 应用**：扫二维码（系统相机或应用里的"扫描二维码"），或者「设置 → 环境 → 添加环境」粘贴链接。直接输入 IP 而不写协议时，手机端按 http 处理；host 用 https 时要写上 `https://`。

### 撤销

- 桌面版：「设置 → 共享与访问 → 已授权的客户端」里撤销某个设备的会话，或者撤销还没用掉的链接。撤销链接只阻止新的配对，要让已经配对的设备失效，要撤销它的会话。
- 命令行：`t3x auth session list` 看会话，`t3x auth session revoke <会话 id>` 撤销；`t3x auth pairing list` 和 `t3x auth pairing revoke <id>` 管还没用掉的链接。

用配对码换会话的请求有失败限速：同一个客户端地址 1 分钟内失败 20 次，会被锁 60 秒（返回 429），不影响别的设备。

更多（路线排序、权限范围）见上游文档的[局域网配对](../user/remote-access.md#pair-over-a-lan-or-private-network)和[管理与撤销](../user/remote-access.md#manage-or-revoke-access)。

## 5. Tailscale

**适合**：设备在不同网络，已经在用 Tailscale。T3 Extend 用 HTTPS 端口 **8443**，**不用 443**：443 是官方 T3 Code 的端口，T3 Extend 永远不会对它创建、修改或删除任何东西。

### 准备

- host 和客户端加入同一个 tailnet。手机也要装 Tailscale 并登录同一个 tailnet。
- tailnet 里打开 MagicDNS 和 HTTPS 证书，见 [Tailscale 的 HTTPS 设置](https://tailscale.com/docs/how-to/set-up-https-certificates)。
- Linux 上，T3 Extend 还需要有权限管理 Tailscale，非 root 用户见 [operator 权限](https://tailscale.com/docs/reference/troubleshooting/linux/linux-operator-permission)。

缺了其中任何一项，T3 Extend 照常启动，只是加不上 HTTPS 路由。

### 在 host 上开启

- 桌面版：「设置 → 共享与访问」，打开"Tailscale HTTPS"。在同一个地方关掉，就撤掉这条路由。
- 命令行：`t3x serve --tailscale-serve` 启动带 HTTPS 的 server；对已经在运行的 server 用 `t3x pair --tailscale`，同时生成配对链接。端口被占时用 `--tailscale-serve-port <端口>` 换一个；传 443 会被换成 8443。

配对链接形如 `https://<机器名>.<tailnet>.ts.net:8443/`。`t3x pair --tailscale` 建的映射会在重启后保留，手动移除：

```bash
tailscale serve --https=8443 --set-path=/ off
```

### 客户端怎么加入、怎么撤销

客户端的加入和撤销步骤与上一节一样：链接用同样的方式打开，在"已授权的客户端"里撤销会话。

### 用 Tailscale 的 IP 直连

开了网络访问（或 `--lan`）之后，server 也监听 Tailscale 的地址，可以直接用 `http://100.x.x.x:3873` 配对。这是明文 http，只是走在 Tailscale 的加密通道里。这种方式下，远程环境里的 localhost 转发不会启用（见第 7 节）。

### 从旧版留下的 443 路由

旧版 T3 Extend 曾经在 443 上留过路由。它不会自动清掉。先 `tailscale serve status` 确认 443 指向 `http://127.0.0.1:3873`（T3 Extend 的 server），再运行 `tailscale serve --https=443 --set-path=/ off`。指向别处（比如 3773）的是官方 T3 Code 的，不要动。完整说明见[上游文档](../user/install.md#running-next-to-official-t3-code)。

## 6. 自建服务器

**适合**：不管在哪都要连回家里的电脑。你在自己的 VPS 上跑一个小服务（registry + frps + Caddy），host 登记进去之后，手机和别的电脑通过 `https://<名字>.t3.example.com` 连回来，流量不经过 T3 Connect 和 Cloudflare。

三点要先知道：

- **VPS 能看到明文。** HTTPS 在你的 VPS 上终止，它能看到你和 agent 的对话、文件内容。只用你自己独占 root 的机器，不要用共享机器或来路不明的"免费 frp 服务"。
- **每台设备一把密钥。** 电脑和手机各有一把 P-256 密钥，VPS 只保存公钥。移除一台设备，其他设备不受影响，也没有共享密码要换。
- **中国大陆的服务器，域名必须在这家云厂商那里备案**，否则 80/443 会被云厂商拦截，证书签不出来。没有备案就用大陆以外的服务器（香港、日本等）。

### 流程和关键决定

1. **准备**：一台有公网 IP 的 Linux VPS（1 核 1 GB 就够）、一个域名、两条都指向 VPS 的 DNS 记录（`t3.example.com` 和通配 `*.t3.example.com`，每台电脑会得到自己的子域名，推送服务器也用它）、装好 Docker 和 compose 插件，80/tcp 和 443/tcp 对外可达且没被别的服务占用（包括云厂商的安全组）。
2. **装服务**：把仓库里的 `infra/self-host/` 放到 VPS 上，在那个目录里运行 `./setup.sh --domain t3.example.com`。它第一次要构建镜像，约一分钟，结束时打印第一份**邀请**（以 `t3x1.` 开头的字符串加二维码）。脚本可以重复运行，不会重置数据。
3. **确认 HTTPS 通了**：在任何一台电脑上运行 `curl -sS https://t3.example.com/v1/info`，返回含 `registryId` 的 JSON 就行。
4. **加入第一台电脑**（下一小节）。
5. **之后的设备**都从已经加入的桌面版邀请。

几个决定它们的原因：

- 对外只发布 Caddy 的 80 和 443。frps 的控制连接走 Caddy 的 443（路径 `/~!frp`），7000 和 8080 不对外开放。
- 默认带一个推送服务器（ntfy），用 `--no-ntfy` 可以不装。
- VPS 上已经有别的网站占着 80/443 时，可以让这里的 Caddy 接管，顺带转发那些网站。这是一种单独的装法，VPS 部署部分的全部细节、日常运维、升级、备份、卸载和本地试用，都在 [infra/self-host/README.md](../../infra/self-host/README.md)，这里不重复。其中有几节常用：[日常运维](../../infra/self-host/README.md#日常运维)、[这台 VPS 上已经有别的网站](../../infra/self-host/README.md#这台-vps-上已经有别的网站)、[本地试用](../../infra/self-host/README.md#本地试用)。

### 加入第一台电脑（桌面版）

1. 在 VPS 上、`infra/self-host` 目录里运行 `./t3x invite --kind computer`，得到一份邀请。邀请 15 分钟内有效、只能用一次，请当作密码传递。
2. 在那台电脑的桌面版里，打开「设置 → 共享与访问 → 你的服务器」，选"加入我的服务器"，粘贴邀请。确认对话框里显示的是你自己的域名之后再加入。
3. 加入后，这台电脑得到 `https://<名字>.t3.example.com` 这样的地址。

这台电脑的 server 要一直运行，别人才能通过这个地址连到它：桌面版开着，或者打开了"在后台保持运行"。电脑休眠、关机或断网时，它的地址就连不上，已经连上的会话会断开。

### 没有桌面版的电脑

用命令行：

```bash
t3x devices join <邀请>        # 加入，--name <名字> 指定显示名，默认是主机名
t3x devices tunnel install     # 下载钉死版本的 frpc（带 SHA-256 校验）
t3x devices tunnel status      # 看隧道客户端是否安装、是否已连上
t3x devices list               # 只读本地保存的设备清单，不联网
t3x devices invite             # 给别的设备生成邀请，默认给手机；--kind computer 给电脑
t3x devices remove <名字>      # 移除一台设备
t3x devices leave              # 这台电脑退出
```

### 加入手机和别的电脑

- **别的电脑**：在已加入的桌面版里选"邀请设备"，类型选电脑，复制邀请；在新电脑的桌面版「设置 → 共享与访问 → 你的服务器」里选"加入我的服务器"，粘贴。没有界面的电脑用 `t3x devices join`。
- **手机（Android）**：在已加入的桌面版里选"邀请设备"，类型选手机，会显示二维码；也可以在 VPS 上运行 `./t3x invite --kind phone`。手机上打开「设置 → 你的服务器」，选"扫描二维码"，或者"粘贴邀请"。手机会让你确认服务器的域名，确认后才发请求。

所有已加入的电脑，会作为环境出现在你其他的电脑和手机上，之后加入的也一样。新加入的设备被别的电脑认出来要几秒到一分钟，期间会显示"等待那台电脑确认…"。

手机只能看设备列表，不能邀请或移除设备。手机的密钥只存在这台手机上，换新手机要重新加入，并移除旧的那台。

### 用浏览器连

浏览器不加入"你的服务器"，不持有设备密钥，继续用配对链接。在已加入的桌面版里创建配对链接时，可以选这台电脑自己的地址（以主机名显示）；也可以用命令行：

```bash
t3x pair --base-url https://<名字>.t3.example.com
```

命令会先从这台电脑探测这个地址：如果它答复的是另一个环境，命令报错；连不上或答复的不像 T3 server 时只给出提示，链接在地址真正指到这个 server 之后才能用。

### 撤销

任选一种：

- 桌面版：在已加入的电脑上，「设置 → 共享与访问 → 你的服务器」里点设备旁的"移除"。
- VPS 上：`./t3x revoke <名字>`，`./t3x devices` 列出所有名字。
- 没有界面的电脑：`t3x devices remove <名字>`。

约一分钟内生效。被移除的设备拿不到新的访问权限，它的隧道在下一次心跳（约 30 秒）被拒绝。**移除时离线的电脑**，要等它重新连上服务器才会被撤销。被移除的电脑显示"加入我的服务器"，需要新邀请才能回来；它的子域名默认不再分配给别人，要用 `./t3x release <子域名>` 才能收回。

在某台电脑上用 `t3x devices remove` 或 `t3x auth session revoke` 这类从另一个进程发起的移除，运行中的 server 要到下一次同步（约 60 秒）才断开旧连接。

### 要知道的行为

- 一台电脑连不上服务器时，会继续用上一份设备清单。3 分钟没同步，设置页提示"连不上服务器"；24 小时后警告；7 天后不再接受新设备登录，同步上之后恢复。
- 电脑退出再加入，它的子域名会变，比如从 `mac` 变成 `mac-2`。
- 重载或重启 VPS 上的 Caddy、frps（包括升级时重跑 `setup.sh`），所有隧道会断开几秒后自动重连，不用重新加入。

### 旧方案

`infra/self-host/advanced/` 里是更早的共享 token 方案，对应桌面版「设置 → 共享与访问 → 高级」下的"公网地址"，只供参考，不再维护。见 [advanced/README.md](../../infra/self-host/advanced/README.md)。

## 7. 远程环境里的 localhost 转发

**用途**：你在桌面版里连着一个远程环境 B（比如通过自建服务器或 Tailscale 连到另一台 Mac）。B 的终端或 agent 起了一个只监听 `localhost` 的开发服务，你想在桌面版的内置浏览器里直接打开 `http://localhost:<端口>`。开启转发后，页面在你本机渲染，请求在后台转到 B 的回环地址。

要点：

- **只有桌面版**可以用，并且要求远程环境 B 是 **macOS** 上的 T3 Extend。Linux、Windows 的环境不提供，SSH 建立的环境跑的是官方的 server，也不提供。你的连接还要有预览和终端的权限。
- 只在加密连接和同一台电脑上的连接上启用。明文 http 的局域网地址、Tailscale 的 `100.x` 地址走明文 http、以及 T3 Connect 的 relay，转发都不会开启。
- 已经验证过的连接方式：同一台电脑上的连接、Tailscale 直连（用 tailnet 的 IPv6 地址）、自建服务器。局域网 https、Tailscale 的 MagicDNS 名字和 Tailscale Serve 没有测过。
- 用私有 CA 签发证书的 `https://` 地址（公司 CA、`mkcert`）暂不支持。

### 怎么用

1. 在 B 的 T3 终端里起服务，或者让 B 上的 agent 起。
2. 在桌面版里，对着 B 的线程打开一个浏览器标签页，输入 `localhost:<端口>`，或者在"本地服务"列表里选，或者点终端里的链接。地址栏旁边会出现一个小图标，表示 localhost 正在转发，地址栏仍然显示 `localhost`。

转发作用于整个环境，不是某一个标签页。从图标的菜单里可以"停止转发，使用这台电脑的 localhost"，也可以"恢复转发"；这台电脑会记住这个选择。转发开着时，该环境标签页里的其他网站绕过系统代理直连。

### 手动放行端口

默认只转发 T3 终端和 agent 起的服务。**脱离父进程的服务**，比如 `nohup … &` 之后脚本退出的，认不出来源，标签页里会出现一张卡片，上面有"允许转发 localhost:端口"。点它就把这个端口加进该环境的放行列表。

放行之后：

- 这个端口上的任何服务都会被转发，**对这个环境的所有设备和标签页生效**，所以只放行你信任的端口。
- 放行记录保存在 B 的 server 上，按端口记，全环境共用，最多 64 条。
- agent 不能放行，只有你本人能放行。
- 开了调试参数（如 `--inspect`）的服务、调试器用的端口、T3 自己和 agent 运行时的进程，无论是否放行都不转发。

### 在设置里查看和移除

「设置 → 浏览器 → 本机服务转发」列出所有放行的端口，每条旁边有"移除"。也可以在转发图标的菜单里选"管理已放行的端口…"，或者对当前端口选"取消放行 localhost:端口"。移除马上生效，依靠放行才通过的连接会被关掉，包括 keep-alive 连接和热更新用的 WebSocket。

### 安全提醒

转发开着时，转发标签页里的页面可以访问该环境里被转发的服务，这些服务看到的请求就像来自环境自己。**不要在这些标签页里打开你不信任的网站。**

更多见上游文档的[Localhost on a remote environment](../user/remote-access.md#localhost-on-a-remote-environment)。

## 8. 手机推送（Android）

T3 Extend 的 Android 应用可以不经过 T3 Connect、Firebase 和 Google Play 服务收到提醒：agent 完成、失败、需要批准或需要输入时推一条，点开就是对应的线程。做法是 UnifiedPush 加自建的 ntfy。

整个链路：host 把提醒加密后发给你的 ntfy 服务器，手机上的 ntfy 应用收到密文交给 T3 Extend，T3 Extend 解密并用手机当前的界面语言显示。ntfy 服务器只经手密文。

### 准备

1. **一个公网地址上的 ntfy 服务器。** 自建服务器那一节的 `setup.sh` 默认装好了，地址是 `https://ntfy.t3.example.com`。host 只会往公网地址推送：局域网、本机、tailnet 上的推送服务器会被拒绝，解析到这些地址的域名同样会被拒绝。
2. **查看推送服务器的地址和账号。** 在 VPS 上、`infra/self-host` 目录里运行 `./t3x ntfy`，它显示服务器地址，以及手机用的账号（`phone`）和密码。用 `--no-ntfy` 装的服务器会提示没有安装。
3. **手机上的推送应用。** 从 F-Droid 装 **ntfy**，打开它，在设置里把默认服务器设成上面的地址，并用 `phone` 账号登录。

### 在 T3 Extend 里打开

打开「设置 → 通知」，打开"推送通知"并允许通知。只装了一个推送应用时会自动选中它，装了多个要自己选。

推送服务器应答之后，这一页会显示推送应用和服务器的主机名，每个已配对的环境下面会写这台手机有没有注册上。在环境下点"发送测试通知"，几秒内应该收到一条。

### 要知道的

- 手机把推送地址和加密密钥交给每一个已配对的环境，所以只会收到已配对环境的提醒，每个环境只推送自己的线程。
- 正在看的线程不提醒；完成的提醒要等一小会儿确认没有后续才发。
- 移除环境、关掉它、或者撤销这台手机的会话，都会停止来自它的提醒。
- 如果一个环境显示"未注册"，后面的文字会说原因（连不上、没应答、拒绝了注册）。连不上或没应答的会自动重试；被拒绝的，把"推送通知"关掉再打开。
- 在系统设置里强行停止应用，会暂停推送，直到你再次打开它。
- 有些 Android 系统（比如 OPPO 的 ColorOS）会在推送应用离开屏幕后切断它的连接。到「设置 → 应用」里依次找到 ntfy 和 T3 Extend，进"电池管理"，选"允许完全后台活动"。

完整说明见上游文档的[Push without Google](../user/mobile-notifications.md#push-without-google)。

## 9. 常见问题和排错

**先在 host 上确认 server 在跑**：桌面版开着，或 `t3x service status` 显示服务在运行。电脑休眠、关机或断网，所有访问方式都连不上它。

| 现象                                                               | 先看这里                                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 手机或别的电脑打开配对链接连不上                                   | 链接里的地址如果是 `127.0.0.1`，只有本机能用，换一个对方能访问的地址重新创建。局域网里要先在 host 上开"网络访问"（或 `--lan`）。                                                   |
| 配对码被拒，或返回 429                                             | 一次性码用过就失效，重新生成一个。同一个客户端地址 1 分钟内失败 20 次会被锁 60 秒。                                                                                                |
| 自建服务器：`curl https://t3.example.com/v1/info` 报证书错误或超时 | 确认两条 DNS 记录已生效、80/443 从外网能访问；大陆服务器还要确认域名已备案。再在 `infra/self-host` 目录里看 `docker compose logs caddy`。                                          |
| 自建服务器：Caddy 起不来，日志里写着 `address already in use`      | 80 或 443 还被别的服务（比如 nginx）占着，先停掉它，或者按"这台 VPS 上已经有别的网站"那一节让 Caddy 接管。                                                                         |
| 桌面版提示连不上你的服务器                                         | 先在那台电脑上运行 `curl https://t3.example.com/v1/info`。再看 VPS 上 `./t3x info`。设置页的提示在 3 分钟没同步后出现。                                                            |
| 新加入的设备显示"等待那台电脑确认…"                                | 正常，对方每分钟同步一次设备清单，最多等一两分钟。一直不变就检查对方电脑的 server 是否在跑、能否连上服务器。                                                                       |
| 隧道每隔一段时间断几秒                                             | 重载或重启 Caddy、frps 会让所有隧道断开几秒后自动重连，不用重新加入。                                                                                                              |
| 被移除的电脑还连着                                                 | 它离线时错过了移除，要等它重新连上服务器才会撤销。                                                                                                                                 |
| Tailscale HTTPS 开不了                                             | 检查 tailnet 是否开了 MagicDNS 和 HTTPS 证书；Linux 上检查 operator 权限。端口被占时用 `--tailscale-serve-port` 换一个，不要用 443。                                               |
| "在后台保持运行"这一行提示 app 位置有问题                          | 移动或删除过 app，或是从磁盘映像里直接打开的。把 app 放进"应用程序"，把开关关掉再打开。                                                                                            |
| 打开 app 时提示后台服务没能停下，然后退出                          | app 不会在服务还占着数据的时候起第二个 server。运行 `t3x service uninstall` 移除服务。                                                                                             |
| `t3x service install` 下载失败                                     | T3 Extend 目前没有发布 server 安装包。macOS 上用桌面版的开关或桌面版装的 `t3x`；其他情况用 `T3CODE_RELEASE_BASE_URL` 指向你自己的镜像。                                            |
| 远程环境的标签页里 localhost 打不开                                | 看标签页里的卡片说了什么。常见原因：服务不是 T3 终端或 agent 起的（点"允许转发"）、服务只监听了非本地地址（让它也监听 `127.0.0.1`）、连接是明文 http 或 T3 Connect（转发不启用）。 |
| 手机收不到推送                                                     | 先在「设置 → 通知」里用"发送测试通知"。再检查推送服务器是不是公网地址、ntfy 应用的服务器和账号对不对、手机有没有限制 ntfy 的后台活动。                                             |

排查时顺序大致是：host 的 server 在不在、地址对方能不能到、凭证有没有失效。上游的 [Remote access](../user/remote-access.md) 和 [后台运行](../user/background-service.md) 文档里有更多细节，自建服务器本身的排查见 [infra/self-host/README.md 的"出问题时"](../../infra/self-host/README.md#出问题时)。

## 界面名称对照

| 简体中文界面                       | 英文界面                                          |
| ---------------------------------- | ------------------------------------------------- |
| 共享与访问                         | Sharing & access                                  |
| 你的服务器                         | Your server                                       |
| 加入我的服务器                     | Join my server                                    |
| 邀请设备                           | Invite a device                                   |
| 退出此服务器                       | Leave this server                                 |
| 移除                               | Remove                                            |
| 网络访问                           | Network access                                    |
| 已授权的客户端                     | Authorized clients                                |
| 创建链接                           | Create link                                       |
| 撤销                               | Revoke                                            |
| 环境                               | Environments                                      |
| 添加环境                           | Add environment                                   |
| 在后台保持运行                     | Keep running in the background                    |
| 维护                               | Maintenance                                       |
| 浏览器                             | Browser                                           |
| 本机服务转发                       | Localhost forwarding                              |
| 允许转发 localhost:端口            | Allow forwarding localhost:\<port\>               |
| 取消放行 localhost:端口            | Stop allowing localhost:\<port\>                  |
| 管理已放行的端口…                  | Manage allowed ports…                             |
| 停止转发，使用这台电脑的 localhost | Stop forwarding and use this computer's localhost |
| 恢复转发                           | Resume forwarding                                 |
| 本地服务                           | Local servers                                     |
| 扫描二维码                         | Scan QR code                                      |
| 粘贴邀请                           | Paste invite                                      |
| 通知                               | Notifications                                     |
| 推送通知                           | Push notifications                                |
| 发送测试通知                       | Send test notification                            |
| 关于                               | About                                             |
