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
4. **80/tcp 和 443/tcp 能从外网访问，并且没被别的服务占用**，包括云厂商控制台里的安全组。

这套服务对外只发布 Caddy 的 80 和 443（`docker-compose.yml` 里只有 `caddy` 有 `ports`）。registry、frps、ntfy 只在 compose 网络里监听。frps 的控制连接走 Caddy 的 443（路径 `/~!frp`，wss），**7000 和 8080 不对外开放**，所以和这台 VPS 上已有的 frps 不冲突。

## 安装

`setup.sh` 只用在 Linux VPS 上；想在 Mac 上试，看下面的「本地试用」。在 VPS 上，进到这个目录：

```
./setup.sh --domain t3.example.com --email you@example.com
```

| 参数        | 作用                                             |
| ----------- | ------------------------------------------------ |
| `--domain`  | 必填。你的域名，不带 `https://`、端口和路径。    |
| `--email`   | 生产部署必填。Let's Encrypt 用它发证书到期提醒。 |
| `--no-ntfy` | 不安装手机推送服务器。                           |
| `--dry-run` | 只打印会做什么，不写文件、不启动服务。           |

第一次会构建镜像，大约一分钟。结束时它会打印注册表信息和第一份**邀请**：一串以 `t3x1.` 开头的字符串，加一个二维码。

脚本可以重复运行，不会重置已有的数据。换域名等于重新开始：先删掉 `.env` 和注册表的数据卷。

**确认证书已经签好**：DNS 生效后，在任何一台电脑上运行 `curl -sS https://t3.example.com/v1/info`，返回一段包含 `registryId` 的 JSON 就说明 HTTPS 通了。如果报证书错误或连接超时，先确认两条 DNS 记录已经生效、80/443 从外网能访问，再看 `docker compose logs caddy`（在这个目录里运行，原因见「日常运维」）。每台电脑的子域名证书在第一次访问时才申请，只为已登记的名字申请。

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
| 看有哪些设备                         | `./t3x devices`                                        |
| 移除一台设备（丢了手机、不用的电脑） | `./t3x revoke <名字>`                                  |
| 看还没用掉的邀请                     | `./t3x invites`                                        |
| 改显示名（子域名不变）               | `./t3x rename <名字> <新名字>`                         |
| 释放已移除电脑的子域名               | `./t3x release <子域名>`                               |
| 推送服务器的地址和账号               | `./t3x ntfy`                                           |
| 注册表地址和设备数                   | `./t3x info`                                           |

移除后一分钟左右生效：这台设备拿不到新的访问权限，它和服务器之间的隧道在 frpc 的下一次心跳（约 30 秒）被拒绝。当时离线的电脑，要等它重新连上服务器才会撤销。

被移除电脑的子域名默认不再分配给别人。`./t3x release <子域名>` 只对已移除电脑留下的子域名有效，作用是让这个名字可以重新分配；对还在使用的子域名，或者从没用过的名字，它会报错并且什么也不做。

**直接敲 `docker compose` 时**：下面的 `docker compose …` 命令都要在这个目录（`infra/self-host`）里运行。`setup.sh` 把项目名和用到的 compose 文件写进了同目录的 `.env`（`COMPOSE_PROJECT_NAME`、`COMPOSE_FILE`），所以不用再带 `-p` 和 `-f`，操作的就是装好的那一套。如果安装时设过 `T3X_DATA_DIR`，每条命令还要加 `--env-file "$T3X_DATA_DIR/.env"`。换到别的目录运行，会报 `open …/docker-compose.yml: no such file or directory`，或者操作到另一个项目。

**查看日志**：`docker compose logs registry caddy frps`（在这个目录里运行）。容器异常退出或卡死时会自动重启；Docker 开机自启的话，整套服务也会跟着起来。

Caddy 默认不记访问日志，`Caddyfile` 里也没有 `log`；frps 以 info 级别运行，不打印请求头。想自己打开 Caddy 的访问日志，只加 `log` 就够了：它默认把 `Authorization` 记成 `REDACTED`，所以隧道票据（放在这个请求头里）不会出现在日志里。不要加 `log_credentials`，它会把请求头原样写出来。这几条每次跑 `vp run fork:selfhost:e2e` 都会实测一遍（场景 16：临时打开访问日志，发一次带哨兵票据的隧道升级，检查 Caddy、frps 和 registry 的全部输出）。另外，`/ws?wsTicket=…` 这类升级请求的票据放在地址里，打开访问日志会被记下来；它只能用一次（设备会话的票据还绑定 DPoP 密钥），但长期开着访问日志的话，留意谁能读这些日志。

**重载或重启会断开所有隧道几秒**：重载 Caddy，重启 Caddy 或 frps（包括升级时重跑 `setup.sh`），每台电脑的隧道都会断开，几秒内自动重连，不用重新加入。原因是 frpc 和 frps 之间的连接也经过 Caddy，重载时保留不住。经隧道打开着的实时页面（WebSocket、SSE）要刷新一下，Vite 这类开发服务器会自己刷新。

**升级**：更新这个目录的文件后重新运行 `./setup.sh`（参数同安装时），它会重新构建镜像并重启有变化的服务，数据保留。所有镜像都钉了版本和摘要，升级时 frps、Caddy、ntfy 和 registry 的基础镜像一起改。frps 的版本必须和电脑上 frpc 的版本一致（`packages/shared/src/forkFrp.ts` 里的 `FRP_VERSION`）。

**备份**：要备份的是 `registry_data` 数据卷（设备公钥、邀请、子域名；默认项目名下叫 `t3x_registry_data`，用 `docker volume ls` 确认）和 `secrets/ntfy-phone.txt`。`caddy_data` 里是证书，丢了可以重新申请，但 Let's Encrypt 有申请频率限制。丢了 `registry_data` 等于所有设备都要重新加入。

**卸载**：在这个目录里运行 `docker compose --profile ntfy down -v`，会停掉服务并删除所有数据卷。想保留数据就不要加 `-v`。

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

之后用 `./t3x` 时同样带上这三个环境变量。试用模式下邮箱可以不填。用完后清理，**在这个目录（`infra/self-host`）里运行**，因为 `-f` 的路径相对当前目录：

```
docker compose -p t3x-trial -f docker-compose.yml -f docker-compose.test.yml --env-file /tmp/t3x-trial/.env --profile ntfy down -v
```

## 出问题时

- `./t3x info` 显示注册表地址和设备数。
- 证书申请失败，先确认两条 DNS 记录已经生效、80/443 从外网能访问；中国大陆的服务器还要确认域名已备案。
- 电脑显示"连不上服务器"时，先在那台电脑上 `curl https://t3.example.com/v1/info`。

`advanced/` 里是 8.1 之前的共享 token 方案（Caddy + frps + frpc），对应桌面端设置里 Advanced 下的"公网地址"，仅供参考，不再维护。见 [advanced/README.md](advanced/README.md)。
