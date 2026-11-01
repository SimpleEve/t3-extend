# 自建连接：用自己的 VPS 代替 T3 Connect

T3 Connect 建立连接后，所有流量都经过 Cloudflare 边缘，在中国大陆通常很慢。这个目录是一套自建方案：在你自己的 VPS 上运行 Caddy 和 frps，在家里的电脑上运行 frpc，手机和别的电脑就能通过 `https://t3.example.com` 这样的地址连回家里的 T3 Extend。

```
手机 / 浏览器 ──HTTPS──▶ VPS: Caddy :443 ──▶ frps :7001 ══frp 隧道 (TLS)══▶ 家里: frpc ──▶ 127.0.0.1:3873 (T3 Extend)
```

- Caddy 自动申请 Let's Encrypt 证书，终止 TLS，原样转发 `Host`，并加上 `X-Forwarded-Proto`。WebSocket 和 SSE 不做额外处理就能通过。
- frps 的数据端口 7001 只在 docker 内部网络里，公网访问不到。家里的 frpc 通过控制端口 7000 连上来，连接用 TLS 加密，并用 token 认证。
- 配对方式不变：二维码或者 `https://t3.example.com/pair#token=<一次性码>`。

## 先读：信任模型

**TLS 在 VPS 上终止，VPS 能看到明文**，包括你和 Agent 的对话内容、文件，以及会话 token。所以这台 VPS 必须是你自己的，root 权限只有你有。不要用别人共享的机器，也不要用来路不明的"免费 frp 服务"。

T3 自己的认证不受影响：

- 配对码是一次性的，5 分钟过期，换到的是可以单独撤销的会话。
- 直连配对得到 Bearer 会话，30 天有效。设备丢了，到 Settings → Sharing & access 的 Authorized clients 里撤销它，或者在家里电脑上运行 `t3x auth session list` 和 `t3x auth session revoke <id>`。
- 一次性码兑换（`/oauth/token`）和浏览器登录（`/api/auth/browser-session`）有失败限速：1 分钟内失败 20 次就锁 60 秒，期间返回 429。经隧道来的请求在 server 看来都来自本机，所以这个限制是全局的。它防止有人猜码，代价是有人恶意试错时，你自己新配对设备也要等这 60 秒，已经配对的设备不受影响。

## 你需要准备

1. 一台 VPS。离你和手机越近越好：国内云服务器延迟最低（国内服务器的 80/443 端口通常需要域名备案），香港或日本的服务器不需要备案，延迟次之。1 核 1 GB 内存就够了。
2. 一个域名，加一条 A 记录：`t3.example.com → VPS 公网 IP`。
3. VPS 防火墙（包括云厂商控制台里的安全组）只放行：
   - `80/tcp`、`443/tcp`：Caddy，用于签发证书和 HTTPS 访问
   - `7000/tcp`：frps 控制端口，供家里的 frpc 连接
   - 不要放行 7001。compose 没有把它映射到宿主机，安全组里也不要开它。
4. VPS 上装好 Docker 和 Docker Compose 插件。

## 部署 VPS

```bash
# 在 VPS 上
git clone <你的 t3-extend 仓库> && cd t3-extend/infra/self-host   # 或者只拷贝这个目录
cp .env.example .env
openssl rand -hex 32          # 生成 FRP_AUTH_TOKEN
vi .env                       # 填 T3_DOMAIN、ACME_EMAIL、FRP_AUTH_TOKEN
docker compose up -d
docker compose logs -f caddy  # 看到 "certificate obtained successfully" 就是证书拿到了
```

`frps.toml` 和 `Caddyfile` 不需要改，域名和 token 都从 `.env` 读取。

Docker 发布的端口会绕过 ufw 规则，所以端口要在云厂商的安全组里控制，不要只依赖 ufw。

## 家里的电脑

### 1. 安装 frpc

- macOS：`brew install frpc`
- Linux / Windows：到 <https://github.com/fatedier/frp/releases> 下载与 VPS 上 frps 相同或更新的版本，把其中的 `frpc` 放进 PATH。

### 2. 配置 frpc

```bash
cp infra/self-host/frpc.toml.example ~/frpc.toml
vi ~/frpc.toml    # 填 serverAddr（VPS IP 或域名）和 auth.token（和 VPS 的 FRP_AUTH_TOKEN 相同）
frpc verify -c ~/frpc.toml
```

`localPort` 默认是 3873，也就是 T3 Extend 桌面版后端的端口。headless 用 `t3x serve --port 3873` 固定端口。

### 3. 让 frpc 一直运行，两种方式选一种

- **交给 T3 Extend 管（推荐）**：Settings → Sharing & access → Tunnel command，填 `frpc -c ~/frpc.toml`，保存后打开开关。应用打开期间它一直运行，退出后会退避重启，退出应用时停止。这一行会显示运行状态、重启次数、最近一条错误和最近的输出。这条命令保存在本机，只能在这台电脑的桌面应用里修改，远程设备改不了。
- **自己管**：手动运行 `frpc -c ~/frpc.toml`，或者把它配置成 launchd / systemd 服务。

## 在 T3 Extend 里配对

### 桌面版

1. Settings → Sharing & access → Public addresses，添加 `https://t3.example.com`。只接受 `https://` 开头、不带路径的地址。
2. 在 Authorized clients 里创建配对链接，点 Share，在地址下拉框里选 `t3.example.com`。手机扫二维码，或者把链接粘贴到手机上的 Add environment。
3. 已经在家里用局域网配对过的手机不用重新配对。下次连上时，它会从 server 学到这个公网地址；离开家里的网络后，会自动改走公网地址。回家后能连上局域网，就切回局域网。

Network access（局域网访问）不需要打开。frpc 通过 127.0.0.1 连接后端。

删除公网地址后，server 不再上报它。设备下次连接时会丢掉学到的这条路由，但已配对的会话还在。如果要彻底断开某台设备，到 Authorized clients 里撤销它。

### headless（`t3x serve` / `t3x up`）

```bash
t3x up --public-url https://t3.example.com            # 保存到 server 的状态目录，装成服务后仍然有效
t3x pair --base-url https://t3.example.com            # 打印二维码、Pairing URL 和 App link
t3x up --clear-public-urls                            # 删除保存的公网地址
```

`--public-url` 可以重复写多次，每次传入的列表会替换之前保存的列表。也可以用环境变量 `T3CODE_PUBLIC_URLS=https://a.example.com,https://b.example.com`，它和保存的列表合并，但不会写入保存的列表。

## 排查

| 现象                       | 检查                                                                                                                 |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 浏览器打不开地址，证书错误 | A 记录是否生效（`dig t3.example.com`），80/443 是否放行，`docker compose logs caddy`                                 |
| 502 Bad Gateway            | frpc 没连上：看 Tunnel command 的状态和错误，或者 `docker compose logs frps`；token 是否一致；家里 T3 是否在运行     |
| 能打开页面但配对失败       | 先在家里电脑上访问 `curl https://t3.example.com/.well-known/t3/environment`，看返回的 environmentId 是否就是这台机器 |
| 配对时提示 429             | 最近失败次数太多，等一分钟再试                                                                                       |
| 手机出门后连不上           | 在家里先连一次，让它学到公网地址；或者用公网地址重新配对一次                                                         |

## 零代码的备选方案：Headscale + 自建国内 DERP

如果你不想让 VPS 看到明文，可以用 Headscale 自建 Tailscale 控制面，在国内 VPS 上部署 DERP 中继，手机和电脑都安装官方 Tailscale 客户端并指向你的 Headscale。流量由 WireGuard 端到端加密，DERP 只转发密文。T3 把它当作普通的 tailnet 路由，不需要额外配置，还可以用 `t3x pair --tailscale` 生成配对链接。代价是每台设备都要安装 Tailscale 并保持 VPN 开启，不能像扫码那样直接用。
