#!/usr/bin/env bash
# 在这台 VPS 上装好 T3 Extend 的注册表、隧道服务器、HTTPS 和（默认的）推送服务器。
#
#   ./setup.sh --domain t3.example.com [--email you@example.com | --no-email] [--no-ntfy | --ntfy]
#
# 只需要 Docker 和 compose 插件：脚本不装任何软件包，不起系统服务，也不改防火墙。
# 80/tcp 和 443/tcp 要你自己放行。邮箱可以不填：Let's Encrypt 现在不再发到期提醒。
#
# 这台 VPS 上已经有别的网站时（见 README 的“这台 VPS 上已经有别的网站”）：
#   T3X_COMPOSE_FILES=docker-compose.yml:docker-compose.host-network.yml ./setup.sh --domain ...
#   T3X_SITES_DIR      别的网站的 Caddy 站点文件放在哪里（默认是脚本所在目录里的 sites/，相对路径也相对脚本所在目录）
#   T3X_HOST_REGISTRY_PORT、T3X_HOST_ASK_PORT、T3X_HOST_FRPS_PORT、T3X_HOST_VHOST_PORT、T3X_HOST_NTFY_PORT
#                      宿主机网络下 Caddy 访问其他服务用的回环端口（默认见 docker-compose.host-network.yml）
#   --recreate-caddy   Caddy 的定义变了（镜像、挂载、环境变量）时才需要：重建 Caddy，这台 VPS 上别的网站会断几秒；
#                      不加的话 setup.sh 不动正在跑的 Caddy。配置内容变了（升级、开关推送服务器、改邮箱）只重载，不断网站。
#
# 重新运行（升级）时，没有再次给出的选择沿用已有 .env 里的：T3X_COMPOSE_FILES、T3X_SITES_DIR、T3X_PROJECT、
# T3X_HOST_*、邮箱、推送服务器。再次给出就按新值，并打印一行提示；给空值（--no-email、T3X_SITES_DIR= 等）是改回默认。
#
# 想在不能被弄脏的机器上试用（见 README 的“本地试用”）：
#   T3X_DATA_DIR       .env 和 secrets/ 放在哪里（默认是脚本所在目录）
#   T3X_COMPOSE_FILES  用哪些 compose 文件，冒号分隔，相对脚本所在目录（默认 docker-compose.yml）
#   T3X_PROJECT        compose 项目名（默认 t3x）
#   --public-port      HTTPS 站点对外的端口（默认 443）
#   --dry-run          只打印会做什么，不改任何东西
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DATA_DIR=${T3X_DATA_DIR:-$SCRIPT_DIR}
case "$DATA_DIR" in
  /*) ;;
  *) DATA_DIR="$PWD/${DATA_DIR#./}" ;;
esac

domain=""
email=""
email_given=0
public_port=443
ntfy=1
ntfy_given=0
recreate_caddy=0
dry_run=0

usage() {
  sed -n '2,/^set -e/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

fail() {
  echo "错误：$*" >&2
  exit 1
}

while [ $# -gt 0 ]; do
  case "$1" in
    --domain) [ $# -ge 2 ] || fail "--domain 需要一个值"; domain=$2; shift 2 ;;
    --email) [ $# -ge 2 ] || fail "--email 需要一个值（不要邮箱用 --no-email）"; email=$2; email_given=1; shift 2 ;;
    --no-email) email=""; email_given=1; shift ;;
    --public-port) [ $# -ge 2 ] || fail "--public-port 需要一个值"; public_port=$2; shift 2 ;;
    --no-ntfy) ntfy=0; ntfy_given=1; shift ;;
    --ntfy) ntfy=1; ntfy_given=1; shift ;;
    --recreate-caddy) recreate_caddy=1; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) fail "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

# A rerun (an upgrade) keeps the choices the install made: what is not given again is read from the existing .env, so
# that running ./setup.sh --domain ... alone does not move Caddy off the host network, drop the sites, bring back a push
# server that was left out, or forget the e-mail. A variable that is set but empty counts as given: back to the default.
env_file="$DATA_DIR/.env"
# Only the format setup.sh writes is read: KEY=value, comments, blank lines. `export`, quotes, trailing comments and the
# like would be read differently by compose than by this script, so they are refused rather than guessed at.
env_line_pattern='^([A-Z][A-Z0-9_]*)=([^[:space:]"#$`\'"'"']*)$'
load_env() {
  [ -f "$env_file" ] || return 0
  local n=0 line var
  while IFS= read -r line || [ -n "$line" ]; do
    n=$((n + 1))
    case "$line" in '' | '#'*) continue ;; esac
    if [[ ! $line =~ $env_line_pattern ]]; then
      fail "$env_file 第 $n 行看不懂：「${line}」。setup.sh 只读它自己写的格式（KEY=值，值里不能有空格、引号、# 或 \$，也不能写 export）。改成这个格式，或者删掉这个文件再运行 setup.sh（数据卷不受影响）。"
    fi
    var=kept_${BASH_REMATCH[1]}
    [ -z "${!var+x}" ] || fail "$env_file 里 ${BASH_REMATCH[1]} 出现了两次（第 $n 行）。删掉多余的一行再运行 setup.sh。"
    printf -v "$var" '%s' "${BASH_REMATCH[2]}"
  done <"$env_file"
}
env_value() {
  local var=kept_$1
  printf '%s' "${!var:-}"
}
# settle <variable> <.env key> <given now: 1|0> <value given> <default> [normalizer]
settle() {
  local var=$1 key=$2 is_given=$3 given=$4 default=$5 normalize=${6:-} kept
  kept=$(env_value "$key")
  if [ -n "$kept" ] && [ -n "$normalize" ]; then kept=$("$normalize" "$kept"); fi
  if [ "$is_given" = 1 ]; then
    [ -n "$given" ] || given=$default
    if [ -n "$normalize" ]; then given=$("$normalize" "$given"); fi
    if [ -n "$kept" ] && [ "$kept" != "$given" ]; then
      echo "提示：$key 和已有的 $env_file 里不同，这次按新值 $given 来（原来是 ${kept}）。" >&2
    fi
    printf -v "$var" '%s' "$given"
  elif [ -n "$kept" ]; then
    printf -v "$var" '%s' "$kept"
  else
    printf -v "$var" '%s' "$default"
  fi
}
# 1 if the environment variable is set, even to an empty value.
is_set() {
  [ -n "${!1+x}" ] && echo 1 || echo 0
}

load_env

settle PROJECT COMPOSE_PROJECT_NAME "$(is_set T3X_PROJECT)" "${T3X_PROJECT:-}" t3x
[[ $PROJECT =~ ^[a-z0-9][a-z0-9_-]*$ ]] || fail "T3X_PROJECT（${PROJECT}）只能由小写字母、数字、- 和 _ 组成，并以字母或数字开头。"

settle COMPOSE_FILES COMPOSE_FILE "$(is_set T3X_COMPOSE_FILES)" "${T3X_COMPOSE_FILES:-}" docker-compose.yml
# Checked before anything is created or written: names without a path, files that exist next to this script.
[[ $COMPOSE_FILES =~ (^:|::|:$) ]] && fail "T3X_COMPOSE_FILES（${COMPOSE_FILES}）里有空的文件名：用冒号分隔，开头、结尾和中间都不能多一个冒号。"
IFS=: read -r -a files <<<"$COMPOSE_FILES"
for file in "${files[@]}"; do
  [[ $file =~ ^[A-Za-z0-9][A-Za-z0-9._-]*\.ya?ml$ ]] ||
    fail "T3X_COMPOSE_FILES（${COMPOSE_FILES}）里的「${file}」不是一个 compose 文件名：用冒号分隔，只写文件名（相对这个目录），不带路径。"
  [ -f "$SCRIPT_DIR/$file" ] || fail "T3X_COMPOSE_FILES 里的 $SCRIPT_DIR/$file 不存在。"
done

# An absolute path: compose takes a bare name for a volume, and reads $, # and : in .env and in volumes itself.
absolute() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s' "$SCRIPT_DIR/${1#./}" ;;
  esac
}
settle SITES_DIR T3X_SITES_DIR "$(is_set T3X_SITES_DIR)" "${T3X_SITES_DIR:-}" "$SCRIPT_DIR/sites" absolute
if [[ ! $SITES_DIR =~ ^/[A-Za-z0-9_./+@,-]+$ ]]; then
  fail "T3X_SITES_DIR（${SITES_DIR}）只能由字母、数字和 _ . / + @ , - 组成：compose 会解释其他字符。"
fi

local_trial=0
case ":$COMPOSE_FILES:" in
  *:docker-compose.test.yml:*) local_trial=1 ;;
esac

# The production compose file publishes 80 and 443 on every interface and asks Let's Encrypt for certificates.
if [ "$(uname -s)" = Darwin ] && [ "$local_trial" = 0 ] && [ "$dry_run" = 0 ]; then
  fail "setup.sh 只用在 Linux VPS 上。在这台 Mac 上运行会把 80 和 443 端口开放给局域网，还会去申请真实的证书。想在这台机器上试用，看 README.md 的“本地试用”（需要 T3X_COMPOSE_FILES=docker-compose.yml:docker-compose.test.yml）。"
fi

# [[ =~ ]] matches the whole value, newlines included; grep would match any single line of it.
domain_pattern='^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
email_pattern='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'

[ -n "$domain" ] || fail "必须提供 --domain，例如 --domain t3.example.com"
domain=$(printf '%s' "$domain" | tr 'A-Z' 'a-z')
if [[ ! $domain =~ $domain_pattern ]]; then
  fail "'$domain' 不像一个域名（不要带协议、端口和路径）"
fi
case "$public_port" in
  '' | *[!0-9]*) fail "--public-port 必须是数字" ;;
esac
if [ "$public_port" != 443 ] && [ "$local_trial" = 0 ]; then
  fail "--public-port 只用于本地试用（需要 T3X_COMPOSE_FILES=docker-compose.yml:docker-compose.test.yml）"
fi

# The e-mail and the push server: what the install chose, unless given again.
if [ "$email_given" = 0 ]; then
  email=$(env_value ACME_EMAIL)
elif [ "$(env_value ACME_EMAIL)" != "$email" ] && [ -f "$env_file" ]; then
  echo "提示：邮箱和已有的 $env_file 里不同，这次按新值「${email:-不要邮箱}」来（原来是「$(env_value ACME_EMAIL)」）。" >&2
fi
kept_ntfy=$(env_value T3X_NTFY_ENABLED)
case "$kept_ntfy" in
  0 | 1) ;;
  '')
    # An older .env: the push server was installed if its compose profile was on.
    case ",$(env_value COMPOSE_PROFILES)," in *,ntfy,*) kept_ntfy=1 ;; *) kept_ntfy=0 ;; esac
    [ -f "$env_file" ] || kept_ntfy=""
    ;;
  *) fail "$env_file 里的 T3X_NTFY_ENABLED 是「$kept_ntfy」，只能是 0 或 1。改成 0 或 1（装了推送服务器是 1），或者删掉这个文件再运行 setup.sh（数据卷不受影响）。" ;;
esac
if [ "$ntfy_given" = 0 ] && [ -n "$kept_ntfy" ]; then
  ntfy=$kept_ntfy
elif [ "$ntfy_given" = 1 ] && [ -n "$kept_ntfy" ] && [ "$kept_ntfy" != "$ntfy" ]; then
  echo "提示：推送服务器和已有的 $env_file 里不同，这次按新的来（现在：${ntfy}，原来：${kept_ntfy}）。" >&2
fi
# The value goes into .env and into the Caddyfile, so only a plain address is accepted.
if [ -n "$email" ] && { [ "${#email}" -gt 254 ] || [[ ! $email =~ $email_pattern ]]; }; then
  fail "邮箱必须是一个普通的邮箱地址，例如 you@example.com（--email 和 .env 里的 ACME_EMAIL 都一样）"
fi

# Another domain means starting over; say so before anything is created.
existing_domain=$(env_value T3X_DOMAIN)
if [ -n "$existing_domain" ] && [ "$existing_domain" != "$domain" ]; then
  fail "$env_file 已经是为 '$existing_domain' 装好的。换域名等于重新开始：先删掉 .env 和注册表的数据卷。"
fi

# Caddy's configuration directory, written by caddy/conf.sh and mounted whole into the container.
CADDY_CONF_DIR="$DATA_DIR/caddy-conf"
if [[ ! $CADDY_CONF_DIR =~ ^/[A-Za-z0-9_./+@,-]+$ ]]; then
  fail "Caddy 配置目录（$CADDY_CONF_DIR）的路径只能由字母、数字和 _ . / + @ , - 组成：compose 会解释其他字符。换一个 T3X_DATA_DIR。"
fi

# The ports Caddy uses on the host's loopback with docker-compose.host-network.yml; they go into .env so that
# `docker compose` by hand and a rerun use the same ones.
host_ports_text=""
case ":$COMPOSE_FILES:" in
  *:docker-compose.host-network.yml:*)
    for entry in T3X_HOST_REGISTRY_PORT:17080 T3X_HOST_ASK_PORT:17082 T3X_HOST_FRPS_PORT:17000 T3X_HOST_VHOST_PORT:17088 T3X_HOST_NTFY_PORT:17090; do
      key=${entry%%:*}
      settle port "$key" "$(is_set "$key")" "${!key:-}" "${entry##*:}"
      if [[ ! $port =~ ^[0-9]{1,5}$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
        fail "$key 必须是 1 到 65535 之间的端口号"
      fi
      host_ports_text="$host_ports_text
$key=$port"
    done
    ;;
esac

origin="https://$domain"
ntfy_url="https://ntfy.$domain"
if [ "$public_port" != 443 ]; then
  origin="$origin:$public_port"
  ntfy_url="$ntfy_url:$public_port"
fi

compose_args=(-p "$PROJECT" --env-file "$DATA_DIR/.env")
for file in "${files[@]}"; do
  compose_args+=(-f "$SCRIPT_DIR/$file")
done
compose() {
  docker compose "${compose_args[@]}" "$@"
}

if [ "$ntfy" = 1 ]; then profiles=ntfy; else profiles=""; fi

env_text="# 由 setup.sh 写入。换域名：删掉这个文件，再运行 setup.sh。
T3X_DOMAIN=$domain
T3X_PUBLIC_ORIGIN=$origin
ACME_EMAIL=$email
COMPOSE_PROFILES=$profiles
COMPOSE_PROJECT_NAME=$PROJECT
COMPOSE_FILE=$COMPOSE_FILES
T3X_NTFY_URL=$ntfy_url
T3X_NTFY_ENABLED=$ntfy
T3X_CADDY_CONF_DIR=$CADDY_CONF_DIR
T3X_SITES_DIR=$SITES_DIR$host_ports_text"

# What caddy/conf.sh writes: ntfy and the e-mail are the contents of files, never a compose variable.
conf_args=()
[ "$local_trial" = 0 ] || conf_args+=(--test)
[ "$ntfy" = 0 ] || conf_args+=(--ntfy)
[ -z "$email" ] || conf_args+=(--email "$email")
# The digest of the directory's files (names and contents): what Caddy has loaded is recorded in this file, so that a
# change is noticed whether the files were replaced by git, by rsync or by hand. .caddy-conf.applied is only written
# after a successful start or reload.
applied_file="$DATA_DIR/.caddy-conf.applied"
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum | awk '{print $1}'; else shasum -a 256 | awk '{print $1}'; fi
}
conf_digest() {
  (
    cd "$CADDY_CONF_DIR"
    find . -type f | LC_ALL=C sort | while IFS= read -r f; do
      printf '%s\n' "$f"
      cat "$f"
    done
  ) | sha256
}

# Caddy is brought up on its own, and never recreated unless asked: it carries every other website on this server, and
# recreating it (compose does that when its definition changed, or when it decides so after a dependency was updated)
# takes them all down for several seconds.
services=(registry frps)
[ "$ntfy" = 0 ] || services+=(ntfy)

if [ "$dry_run" = 1 ]; then
  echo "试运行：不会写任何文件，也不会启动服务。"
  echo
  echo "将写入 $DATA_DIR/.env："
  printf '%s\n' "$env_text" | sed 's/^/  /'
  if [ "$ntfy" = 1 ] && [ ! -s "$DATA_DIR/secrets/ntfy-phone.txt" ]; then
    echo "将创建 $DATA_DIR/secrets/ntfy-phone.txt，内容是随机密码（权限 0600）。"
  fi
  echo "将写入 Caddy 的配置目录 $CADDY_CONF_DIR：$SCRIPT_DIR/caddy/conf.sh ${conf_args[*]:-}"
  echo "将运行：docker compose ${compose_args[*]} up -d --build --wait --no-deps ${services[*]}"
  [ "$ntfy" = 1 ] || echo "将停止并删除已有的推送服务器容器（数据卷保留）。"
  if [ "$recreate_caddy" = 1 ]; then
    echo "将运行：docker compose ${compose_args[*]} up -d --wait caddy（定义变了才重建；配置内容变了就重载）"
  else
    echo "将运行：docker compose ${compose_args[*]} up -d --wait --no-recreate caddy（Caddy 已经在跑时不重建它；配置内容变了就重载）"
  fi
  [ "$ntfy" = 1 ] && echo "将创建推送服务器的账号 'phone'（对 up* 只读）。"
  echo "将运行：$SCRIPT_DIR/t3x invite --kind computer"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "没有安装 Docker。先安装 Docker 和 compose 插件：https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "缺少 Docker compose 插件：https://docs.docker.com/compose/install/"

umask 077
mkdir -p "$DATA_DIR/secrets"
# Docker would create a missing bind-mount source as root.
mkdir -p "$SITES_DIR"
printf '%s\n' "$env_text" >"$DATA_DIR/.env"
"$SCRIPT_DIR/caddy/conf.sh" "$CADDY_CONF_DIR" ${conf_args[@]+"${conf_args[@]}"}

if [ "$ntfy" = 1 ] && [ ! -s "$DATA_DIR/secrets/ntfy-phone.txt" ]; then
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$DATA_DIR/secrets/ntfy-phone.txt"
  echo >>"$DATA_DIR/secrets/ntfy-phone.txt"
fi

echo "正在启动服务（第一次构建大约要一分钟）..."
compose up -d --build --wait --no-deps "${services[@]}"
if [ "$ntfy" = 0 ] && [ -n "$(compose --profile ntfy ps -aq ntfy 2>/dev/null)" ]; then
  # The service is in the ntfy profile, which is off now; --profile brings it back into view just to remove it. The
  # volumes (ntfy_data, ntfy_cache: the accounts and the cache) stay, so --ntfy later finds them again.
  compose --profile ntfy rm -sf ntfy
  echo "已停止并删除推送服务器的容器（数据卷 ntfy_data 和 ntfy_cache 保留，--ntfy 装回来时还在；要删掉用 docker compose --profile ntfy down -v）。"
fi

caddy_before=$(compose ps -aq caddy 2>/dev/null | head -n 1 || true)
if [ "$recreate_caddy" = 1 ]; then
  compose up -d --wait caddy
else
  compose up -d --wait --no-recreate caddy
fi
caddy_id=$(compose ps -aq caddy 2>/dev/null | head -n 1 || true)
wanted_digest=$(conf_digest)
if [ -z "$caddy_before" ] || [ "$caddy_before" != "$caddy_id" ]; then
  # Caddy was just created: it started from the files as they are now.
  printf '%s\n' "$wanted_digest" >"$applied_file"
else
  running_hash=$(docker inspect -f '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$caddy_id" 2>/dev/null || true)
  wanted_hash=$(compose config --hash caddy 2>/dev/null | awk '{print $2}' || true)
  if [ -n "$running_hash" ] && [ -n "$wanted_hash" ] && [ "$running_hash" != "$wanted_hash" ]; then
    # A changed definition (image, mounts, environment) is only applied by recreating, and that takes every other website
    # on this server down for seconds; the old container may not even have the configuration directory. Say so.
    echo "注意：Caddy 的定义变了（镜像、挂载或环境变量），但它正在跑，没有重建，也没有重载。重建时这台 VPS 上别的网站会断几秒。要应用，选个合适的时间重新运行 ./setup.sh（参数同前）并加上 --recreate-caddy。" >&2
  elif [ "$(cat "$applied_file" 2>/dev/null || true)" != "$wanted_digest" ]; then
    # The files changed (an upgrade, ntfy switched, an e-mail): a graceful reload, the other websites keep answering.
    # Caddy keeps the old configuration if the new one is refused; say so and fail instead of going on.
    echo "Caddy 的配置内容变了，正在重载（别的网站不受影响，T3 的隧道会断几秒后自动重连）..."
    if ! reload_output=$(compose exec -T caddy caddy reload --config /etc/caddy/conf/Caddyfile --adapter caddyfile 2>&1); then
      printf '%s\n' "$reload_output" >&2
      fail "Caddy 重载失败，它继续用旧配置。看上面的报错（常见原因是 $SITES_DIR 里的站点文件写错了），改好后重新运行 ./setup.sh。"
    fi
    printf '%s\n' "$wanted_digest" >"$applied_file"
  fi
fi

if [ "$ntfy" = 1 ]; then
  ntfy_password=$(tr -d '\n' <"$DATA_DIR/secrets/ntfy-phone.txt")
  if ! compose exec -T ntfy ntfy user list 2>/dev/null | grep -q '^user phone'; then
    NTFY_PASSWORD="$ntfy_password" compose exec -T -e NTFY_PASSWORD ntfy ntfy user add phone
  fi
  compose exec -T ntfy ntfy access phone 'up*' read-only
fi

T3X_DATA_DIR="$DATA_DIR" T3X_COMPOSE_FILES="$COMPOSE_FILES" T3X_PROJECT="$PROJECT" "$SCRIPT_DIR/t3x" info

echo
echo "第一台电脑加入之前，先确认："
echo "  * DNS：$domain 和 *.$domain 都指向这台服务器"
echo "  * 防火墙（包括云厂商控制台里的安全组）放行了 80/tcp 和 443/tcp，其他端口都不需要开"
echo
echo "邀请第一台电脑：在那台电脑的 T3 Extend 里打开「设置 → 共享与访问 → 你的服务器」，选「加入我的服务器」，粘贴下面这份邀请："
echo
T3X_DATA_DIR="$DATA_DIR" T3X_COMPOSE_FILES="$COMPOSE_FILES" T3X_PROJECT="$PROJECT" "$SCRIPT_DIR/t3x" invite --kind computer
if [ "$ntfy" = 1 ]; then
  echo
  echo "Android 手机的推送通知：运行 ./t3x ntfy 查看推送服务器的地址和密码。"
fi
echo
echo "随时可以再生成邀请：./t3x invite --kind computer   或   ./t3x invite --kind phone"
