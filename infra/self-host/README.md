# 自建连接：用自己的服务器连回家里的 T3 Extend

在你自己的 VPS 上跑一个小服务，家里的电脑登记进去以后，手机和别的电脑就能通过 `https://你的域名` 连回来。流量不经过 T3 Connect 和 Cloudflare。

每台设备（电脑或手机）有自己的密钥，服务器只保存公钥。丢了一台设备，只需要移除它，其他设备不受影响，不用换任何共享密码。

> **服务器能看到明文。** HTTPS 在你的 VPS 上终止，所以 VPS 能看到你和 Agent 的对话、文件内容。请只用你自己独占 root 的机器。

> **中国大陆的服务器：域名必须在这家云厂商那里备案。** 没有备案的域名，80/443 会被服务器所在的云厂商拦截，浏览器和 Let's Encrypt 都到不了你的机器，证书也就签不出来。域名没有备案，请改用中国大陆以外的服务器（香港、日本等）。

## 你需要准备

1. **一台 Linux VPS**，有公网 IP，1 核 1 GB 内存就够。离你和手机越近越好。
2. **一个域名**，加两条 DNS 记录，都指向 VPS 的公网 IP：
   - `t3.example.com`
   - `*.t3.example.com`（通配，每台电脑会得到自己的子域名；推送服务器也用它）
3. **VPS 上装好 Docker 和 compose 插件**（[安装说明](https://docs.docker.com/engine/install/)）。脚本不会替你安装任何东西，也不会改防火墙。
4. **80/tcp 和 443/tcp 能从外网访问，并且没被别的服务占用**，包括云厂商控制台里的安全组。如果这台 VPS 上已经有别的网站占着它们，看 [这台 VPS 上已经有别的网站](#这台-vps-上已经有别的网站)。

这套服务对外只发布 Caddy 的 80 和 443（`docker-compose.yml` 里只有 `caddy` 有 `ports`）。registry、frps、ntfy 只在 compose 网络里监听。frps 的控制连接走 Caddy 的 443（路径 `/~!frp`，wss），**7000 和 8080 不对外开放**，所以和这台 VPS 上已有的 frps 不冲突。

## 安装

`setup.sh` 只用在 Linux VPS 上；想在 Mac 上试，看下面的「本地试用」。在 VPS 上，进到这个目录：

```
./setup.sh --domain t3.example.com
```

| 参数               | 作用                                                                                        |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `--domain`         | 必填。你的域名，不带 `https://`、端口和路径。                                               |
| `--email`          | 可选。登记到 Let's Encrypt 的证书账号。它现在不再发证书到期提醒，不填也不影响签证书。       |
| `--no-email`       | 去掉已经登记的邮箱（`--email ''` 同义）。                                                   |
| `--no-ntfy`        | 不安装手机推送服务器。已经装了的要装回来用 `--ntfy`。                                       |
| `--recreate-caddy` | 重建 Caddy。只在 Caddy 的定义变了（镜像、挂载、环境变量）时用，见「日常运维」里的「升级」。 |
| `--dry-run`        | 只打印会做什么，不写文件、不启动服务。                                                      |

第一次会构建镜像，大约一分钟。结束时它会打印注册表信息和第一份**邀请**：一串以 `t3x1.` 开头的字符串，加一个二维码。

脚本可以重复运行，不会重置已有的数据。重新运行时，没有再次给出的选择沿用上一次装的：`--email`、`--no-ntfy`、`T3X_COMPOSE_FILES`、`T3X_SITES_DIR`、`T3X_PROJECT` 和 `T3X_HOST_*`；再给一次就按新的来，并打印一行提示；变量设成空值（`T3X_SITES_DIR=`）表示改回默认。换域名等于重新开始：先删掉 `.env` 和注册表的数据卷。

**确认证书已经签好**：DNS 生效后，在任何一台电脑上运行 `curl -sS https://t3.example.com/v1/info`，返回一段包含 `registryId` 的 JSON 就说明 HTTPS 通了。如果报证书错误或连接超时，先确认两条 DNS 记录已经生效、80/443 从外网能访问，再看 `docker compose logs caddy`（在这个目录里运行，原因见「日常运维」）。每台电脑的子域名证书在第一次访问时才申请，只为已登记的名字申请；推送服务器 `ntfy.t3.example.com` 的证书也是第一次访问时才申请，所以刚装好后它的第一次连接会慢一点。

## 第一台电脑

1. 在 VPS 上运行 `./t3x invite --kind computer`，得到一份邀请（15 分钟内有效，只能用一次，请当作密码传递）。
2. 在那台电脑的 T3 Extend 里，打开「设置 → 共享与访问 → 你的服务器」，选「加入我的服务器」，粘贴邀请。确认对话框里显示的是你的域名后再加入。
3. 加入后，这台电脑会得到 `https://<名字>.t3.example.com` 这样的地址。

之后的电脑和手机都从桌面端邀请：在「你的服务器」里选「邀请设备」，电脑粘贴邀请，手机扫二维码或粘贴。没有界面的电脑用 `t3x devices join <邀请>`。手机想收到推送通知（Android），运行 `./t3x ntfy`，它会显示推送服务器地址和手机用的账号密码；用 `--no-ntfy` 安装的服务器会提示未安装。

## 日常运维

在 VPS 上这个目录里运行 `./t3x <命令>`：

| 想做的事                             | 命令                                                   |
| ------------------------------------ | ------------------------------------------------------ |
| 生成邀请（电脑、手机或都行）         | `./t3x invite [--kind computer\|phone\|any] [--no-qr]` |
| 看有哪些设备（含电脑的可见性设置）   | `./t3x devices`                                        |
| 移除一台设备（丢了手机、不用的电脑） | `./t3x revoke <名字>`                                  |
| 看还没用掉的邀请                     | `./t3x invites`                                        |
| 改显示名（子域名不变）               | `./t3x rename <名字> <新名字>`                         |
| 释放已移除电脑的子域名               | `./t3x release <子域名>`                               |
| 推送服务器的地址和账号               | `./t3x ntfy`                                           |
| 注册表地址和设备数                   | `./t3x info`                                           |

移除后一分钟左右生效：这台设备拿不到新的访问权限，它和服务器之间的隧道在 frpc 的下一次心跳（约 30 秒）被拒绝。当时离线的电脑，要等它重新连上服务器才会撤销。

电脑可以在自己的设置里对其他设备隐藏自己（「设置 → 共享与访问 → 你的服务器 → 可见性」，或 `t3x devices visibility`）。被隐藏的设备拿不到这台电脑的条目，也没法移除或改名它；`./t3x devices` 照样列出全部设备并标出谁对谁隐藏，`./t3x revoke` 对隐藏的电脑同样有效。这个设置需要 registry 升级到带可见性的版本；升级时数据库自动迁移到 schema 2，**迁移之后不能再回滚到旧版 registry 镜像**（旧版会因为 schema 太新拒绝启动）。

被移除电脑的子域名默认不再分配给别人。`./t3x release <子域名>` 只对已移除电脑留下的子域名有效，作用是让这个名字可以重新分配；对还在使用的子域名，或者从没用过的名字，它会报错并且什么也不做。

**直接敲 `docker compose` 时**：下面的 `docker compose …` 命令都要在这个目录（`infra/self-host`）里运行。`setup.sh` 把项目名和用到的 compose 文件写进了同目录的 `.env`（`COMPOSE_PROJECT_NAME`、`COMPOSE_FILE`），所以不用再带 `-p` 和 `-f`，操作的就是装好的那一套。如果安装时设过 `T3X_DATA_DIR`，每条命令还要加 `--env-file "$T3X_DATA_DIR/.env"`。换到别的目录运行，会报 `open …/docker-compose.yml: no such file or directory`，或者操作到另一个项目。

**查看日志**：`docker compose logs registry caddy frps`（在这个目录里运行）。容器异常退出或卡死时会自动重启；Docker 开机自启的话，整套服务也会跟着起来。

Caddy 默认不记访问日志，`Caddyfile` 里也没有 `log`；frps 以 info 级别运行，不打印请求头。想自己打开 Caddy 的访问日志，只加 `log` 就够了：它默认把 `Authorization` 记成 `REDACTED`，所以隧道票据（放在这个请求头里）不会出现在日志里。不要加 `log_credentials`，它会把请求头原样写出来。这几条每次跑 `vp run fork:selfhost:e2e` 都会实测一遍（场景 16：临时打开访问日志，发一次带哨兵票据的隧道升级，检查 Caddy、frps 和 registry 的全部输出）。另外，`/ws?wsTicket=…` 这类升级请求的票据放在地址里，打开访问日志会被记下来；它只能用一次（设备会话的票据还绑定 DPoP 密钥），但长期开着访问日志的话，留意谁能读这些日志。

**重载或重启会断开所有隧道几秒**：重载 Caddy，重启 Caddy 或 frps（包括升级时重跑 `setup.sh`），每台电脑的隧道都会断开，几秒内自动重连，不用重新加入。原因是 frpc 和 frps 之间的连接也经过 Caddy，重载时保留不住。经隧道打开着的实时页面（WebSocket、SSE）要刷新一下，Vite 这类开发服务器会自己刷新。

**升级**：更新这个目录的文件后重新运行 `./setup.sh --domain <你的域名>`（上一次的选择自动沿用，不用重新带），它会重新构建镜像并重建有变化的服务（registry、frps、ntfy），数据保留。Caddy 要分两种情况：

- **配置内容变了**（Caddyfile 随升级变了、开关推送服务器、加了或去掉邮箱、改了 `sites/` 里的站点文件）：`setup.sh` 把 Caddy 要读的配置整个写进数据目录里的 `caddy-conf/`（compose 把这个目录整个挂进容器，不是单个文件），记下里面内容的摘要；摘要变了，就在 Caddy 里执行平滑重载。别的网站不会断；T3 的隧道会断几秒后自动重连。重载被拒绝时 Caddy 继续用旧配置，`setup.sh` 把 Caddy 的报错原样打印出来并以非零状态退出，改好后重新运行就会再试。`caddy-conf/` 是 `setup.sh` 生成的，不要手改，也不进仓库。
- **Caddy 的定义变了**（Caddy 镜像升级、换了站点目录、compose 文件的组合变了，或者你自己的 `docker-compose.local.yml` 改了挂载）：`setup.sh` 不会重建正在跑的 Caddy，只打印一行提示。重建时**这台 VPS 上别的网站会断几秒**，所以选个合适的时间重新运行 `./setup.sh`（参数同前），加上 `--recreate-caddy`。

**从旧版（Caddy 的配置是单个文件挂载）升级，要重建一次 Caddy**：配置目录的挂载让 Caddy 的定义变了，运行 `./setup.sh --domain <你的域名> --recreate-caddy`，别的网站会断几秒（本地试用栈上量到 1.3 秒，没有连接时；有人在用时 Caddy 会等连接关闭，线上实测过 7 秒）。之后所有升级和开关都只是重载。退回旧版也一样要加 `--recreate-caddy`：不加的话，旧版的 `setup.sh` 会保留正在跑的新结构的 Caddy，别的网站同样会断几秒。关掉推送服务器（`--no-ntfy`）时 `setup.sh` 会停止并删除 ntfy 的容器、重载 Caddy 去掉它的路由，数据卷（账号和缓存）保留，`--ntfy` 装回来时还在；要连数据一起删，用 `docker compose --profile ntfy down -v`（这也会删掉所有其他数据卷，见「卸载」）。

**备份**：要备份的是 `registry_data` 数据卷（设备公钥、邀请、子域名；默认项目名下叫 `t3x_registry_data`，用 `docker volume ls` 确认）和 `secrets/ntfy-phone.txt`。`caddy_data` 里是证书，丢了可以重新申请，但 Let's Encrypt 有申请频率限制。丢了 `registry_data` 等于所有设备都要重新加入。

**卸载**：在这个目录里运行 `docker compose --profile ntfy down -v`，会停掉服务并删除所有数据卷。想保留数据就不要加 `-v`。

## 这台 VPS 上已经有别的网站

80 和 443 只能被一个程序监听。VPS 上原来是 nginx 之类在占着它们、后面挂着别的网站时，可以让这里的 Caddy 接管这两个端口，顺带把那些网站也转发过去：每个网站写成 `sites/` 里的一个文件。

**1. 写站点文件。** 文件放在这个目录的 `sites/` 里（想放别处，安装时设 `T3X_SITES_DIR=/某个目录`，相对路径相对于这个目录），文件名随意，以 `.caddy` 结尾，内容就是 Caddyfile 里的一个站点。目录是空的也能正常启动，`sites/` 里别的文件（比如那里的说明文件）不会被读。两个例子：

转发到 `127.0.0.1` 上的服务（`sites/blog.caddy`）：

```
blog.example.com {
	reverse_proxy 127.0.0.1:3000
}
```

静态目录加密码（`sites/files.caddy`），哈希用 `docker run --rm -it caddy:2.11.7 caddy hash-password` 生成（版本号和 `docker-compose.yml` 里的 Caddy 一致）：

```
files.example.com {
	root * /srv/files
	basic_auth {
		me <哈希>
	}
	file_server
}
```

Caddy 会为每个站点自己申请证书；想继续用原来的证书，在站点里写 `tls <证书文件> <私钥文件>`。

**站点文件里的宿主机路径，Caddy 容器默认看不到。** 上面的 `/srv/files`、原来的证书目录都在宿主机上。最简单的办法是自己写一个 `docker-compose.local.yml` 放在这个目录里，把用到的目录挂进去，路径两边写成一样，站点文件里就照宿主机的路径写：

```yaml
services:
  caddy:
    volumes:
      - /srv/files:/srv/files:ro
      - /etc/letsencrypt:/etc/letsencrypt:ro
```

再把它加进 `T3X_COMPOSE_FILES`（见第 3 步）。这是你这台机器自己的配置，不在仓库里，也不要提交。沿用 certbot 的证书时要挂整个 `/etc/letsencrypt`，因为 `live/` 里是指向 `archive/` 的软链接。

少数网站需要 Caddy 的全局选项，例如用 IP 访问的网站要 `default_sni <IP>`（浏览器用 IP 访问时不发 SNI）。全局选项不能写在站点文件里：放进同一目录里以 `.options` 结尾的文件，例如 `sites/ip.options`，内容一行 `default_sni 203.0.113.7`，Caddy 会把它读进 Caddyfile 开头的全局选项块。

**2. 停掉原来占 80/443 的服务**，例如 `sudo systemctl disable --now nginx`。从这一刻到 Caddy 起来，那些网站打不开，所以站点文件先写好再停，下一步马上运行。

**3. 用宿主机网络的覆盖文件安装。** 网站的后端通常只监听宿主机的 `127.0.0.1`，在 compose 网络里的 Caddy 连不到它们，所以这种装法让 Caddy 直接用宿主机的网络：

```
export T3X_COMPOSE_FILES=docker-compose.yml:docker-compose.host-network.yml
./setup.sh --domain t3.example.com
```

有自己的覆盖文件时写成 `docker-compose.yml:docker-compose.host-network.yml:docker-compose.local.yml`。`setup.sh` 把 compose 文件、站点目录（`T3X_SITES_DIR`，相对路径会按这个目录转成绝对路径）和用到的端口写进 `.env`，之后直接敲 `docker compose` 操作的就是这一套。**升级时直接重新运行 `./setup.sh --domain t3.example.com` 就行**：没有再次给出的 `T3X_COMPOSE_FILES`、`T3X_SITES_DIR`、`T3X_HOST_*`、邮箱和推送服务器沿用 `.env` 里的值，不用重新带上；这次给出的值和 `.env` 不同，就按新值来，并打印一行提示。重跑不会重建正在跑的 Caddy，所以不会让别的网站断线；Caddy 的定义变了才需要 `--recreate-caddy`（见「日常运维」里的「升级」）。`docker-compose.host-network.yml` 做了两件事：Caddy 直接占宿主机的 80 和 443（没有 `ports`）；registry、frps、ntfy 仍然在 compose 网络里，Caddy 要访问的端口只发布到 `127.0.0.1`，默认用不常用的端口：

| 服务和用途                     | 宿主机上的地址    | 改端口的变量             |
| ------------------------------ | ----------------- | ------------------------ |
| registry 的公开 API            | `127.0.0.1:17080` | `T3X_HOST_REGISTRY_PORT` |
| registry 回答 Caddy 的证书询问 | `127.0.0.1:17082` | `T3X_HOST_ASK_PORT`      |
| frps 的控制连接                | `127.0.0.1:17000` | `T3X_HOST_FRPS_PORT`     |
| frps 的 HTTP 虚拟主机          | `127.0.0.1:17088` | `T3X_HOST_VHOST_PORT`    |
| ntfy                           | `127.0.0.1:17090` | `T3X_HOST_NTFY_PORT`     |

端口被占时，换个端口重新运行 `setup.sh`，例如 `T3X_HOST_REGISTRY_PORT=27080 ./setup.sh --domain t3.example.com`（其余设置沿用），它会把新端口写进 `.env` 并重建受影响的服务。frps 给 registry 插件用的端口（registry 的 8081）只有 frps 自己访问，不发布。

这种装法下 Caddy 直接收到客户端的连接，`X-T3x-Client-IP` 拿到的就是真实客户端地址，registry 的限流照常按它算。另外，registry 的端口在宿主机回环上，Caddy 的管理接口也在 `127.0.0.1:2019`，这台 VPS 上的本机进程能直接访问它们，所以**这台 VPS 必须是你自己的**，不能有别人或不可信的程序在上面跑。这和上面「服务器能看到明文」的前提是同一个。

**4. 改了站点文件要重载 Caddy**：

```
docker compose exec caddy caddy reload --config /etc/caddy/conf/Caddyfile --adapter caddyfile
```

新文件有错时重载会失败，Caddy 继续用原来的配置。**重载会让所有电脑的隧道断开几秒**，原因见「日常运维」里「重载或重启会断开所有隧道几秒」；它们会自动重连。

**网站在 Cloudflare 代理后面时**，Caddy 看到的连接来自 Cloudflare，访客的真实 IP 在请求头 `Cf-Connecting-Ip` 里；Caddy 会把这个头原样转发给后端。

## 本地试用

想在自己的电脑上先试一遍，不租 VPS、不买域名，也不碰系统：Docker 里跑一套完整的服务，只监听本机回环地址（`127.0.0.1` 和 `::1` 的 18443 端口），局域网和外网都访问不到。证书用 Caddy 自己的根证书，浏览器会提示不受信任。端口 18443 写死在 `docker-compose.test.yml` 里；要换端口，另写一个覆盖文件（`ports: !override`，同时发布 `127.0.0.1` 和 `[::1]`）再加进 `T3X_COMPOSE_FILES`，不要改仓库里的那个。想一次跑完整个流程的自动化检查，用仓库根目录的 `vp run fork:selfhost:e2e`，它自己选端口和项目名。

**不要在 Mac 上直接运行生产命令。** 生产配置会把 80 和 443 开到局域网，还会去 Let's Encrypt 申请真证书，所以 `setup.sh` 在 Mac 上遇到生产配置会直接拒绝（`--dry-run` 不受限）。试用必须带上测试覆盖文件 `docker-compose.test.yml`，下面的命令已经带上了：

```
export T3X_DATA_DIR=/tmp/t3x-trial
export T3X_COMPOSE_FILES=docker-compose.yml:docker-compose.test.yml
export T3X_PROJECT=t3x-trial
./setup.sh --domain t3.localhost --public-port 18443
```

| 设置                | 作用                                                                                    |
| ------------------- | --------------------------------------------------------------------------------------- |
| `T3X_DATA_DIR`      | `.env` 和 `secrets/` 放在哪里，默认是脚本所在目录。试用时指向一个临时目录，不弄脏仓库。 |
| `T3X_COMPOSE_FILES` | 用哪些 compose 文件，冒号分隔。带上 `docker-compose.test.yml` 就是本地试用模式。        |
| `T3X_PROJECT`       | compose 项目名，默认 `t3x`。换一个名字，试用和正式部署的容器、数据卷互不干扰。          |
| `--public-port`     | 对外的 HTTPS 端口，只在试用模式下可以改，默认 443。                                     |
| `--dry-run`         | 只打印会做什么，不写文件、不启动服务。                                                  |

之后用 `./t3x` 时同样带上这三个环境变量。用完后清理，**在这个目录（`infra/self-host`）里运行**，因为 `-f` 的路径相对当前目录：

```
docker compose -p t3x-trial -f docker-compose.yml -f docker-compose.test.yml --env-file /tmp/t3x-trial/.env --profile ntfy down -v
```

## 出问题时

- `./t3x info` 显示注册表地址和设备数。
- 证书申请失败，先确认两条 DNS 记录已经生效、80/443 从外网能访问；中国大陆的服务器还要确认域名已备案。
- Caddy 起不来，日志里写着 `address already in use`：80 或 443 还被别的服务占着，先停掉它（见上面「这台 VPS 上已经有别的网站」）。
- 电脑显示"连不上服务器"时，先在那台电脑上 `curl https://t3.example.com/v1/info`。

`advanced/` 里是 8.1 之前的共享 token 方案（Caddy + frps + frpc），对应桌面端设置里 Advanced 下的"公网地址"，仅供参考，不再维护。见 [advanced/README.md](advanced/README.md)。
