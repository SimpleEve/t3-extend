#!/usr/bin/env bash
# 在这台 VPS 上装好 T3 Extend 的注册表、隧道服务器、HTTPS 和（默认的）推送服务器。
#
#   ./setup.sh --domain t3.example.com [--email you@example.com] [--no-ntfy]
#
# 只需要 Docker 和 compose 插件：脚本不装任何软件包，不起系统服务，也不改防火墙。
# 80/tcp 和 443/tcp 要你自己放行。--email 可以不填：Let's Encrypt 现在不再发到期提醒。
#
# 这台 VPS 上已经有别的网站时（见 README 的“这台 VPS 上已经有别的网站”）：
#   T3X_COMPOSE_FILES=docker-compose.yml:docker-compose.host-network.yml ./setup.sh --domain ...
#   T3X_SITES_DIR      别的网站的 Caddy 站点文件放在哪里（默认是脚本所在目录里的 sites/，相对路径也相对脚本所在目录）
#   T3X_HOST_REGISTRY_PORT、T3X_HOST_ASK_PORT、T3X_HOST_FRPS_PORT、T3X_HOST_VHOST_PORT、T3X_HOST_NTFY_PORT
#                      宿主机网络下 Caddy 访问其他服务用的回环端口（默认见 docker-compose.host-network.yml）
# 重新运行时，没有再次给出的 T3X_COMPOSE_FILES、T3X_SITES_DIR 和 T3X_HOST_*，沿用已有 .env 里的值。
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
PROJECT=${T3X_PROJECT:-t3x}
# Not defaulted here: a rerun that is not given them again keeps what the existing .env has (see `settle`).
GIVEN_COMPOSE_FILES=${T3X_COMPOSE_FILES:-}
GIVEN_SITES_DIR=${T3X_SITES_DIR:-}

domain=""
email=""
public_port=443
ntfy=1
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
    --domain) domain=${2:-}; shift 2 ;;
    --email) email=${2:-}; shift 2 ;;
    --public-port) public_port=${2:-}; shift 2 ;;
    --no-ntfy) ntfy=0; shift ;;
    --dry-run) dry_run=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) fail "未知参数：$1（用 --help 查看用法）" ;;
  esac
done

# A rerun (an upgrade) keeps the choices the install made: what is not given again is read from the existing .env,
# so that, say, running ./setup.sh --domain ... alone does not move Caddy off the host network and drop the sites.
env_file="$DATA_DIR/.env"
env_value() {
  [ -f "$env_file" ] || return 0
  sed -n "s/^$1=//p" "$env_file" | head -n 1
}
# settle <variable> <.env key> <value given now> <default> [normalizer]: given, else what .env has, else the default.
# The normalizer is applied to the .env value too: a .env written by an earlier setup.sh may hold ./sites.
settle() {
  local var=$1 key=$2 given=$3 default=$4 normalize=${5:-} kept
  kept=$(env_value "$key")
  if [ -n "$kept" ] && [ -n "$normalize" ]; then kept=$("$normalize" "$kept"); fi
  if [ -n "$given" ]; then
    if [ -n "$kept" ] && [ "$kept" != "$given" ]; then
      echo "提示：$key 和已有的 $env_file 里不同，这次按新值 $given 来（原来是 $kept）。" >&2
    fi
    printf -v "$var" '%s' "$given"
  elif [ -n "$kept" ]; then
    printf -v "$var" '%s' "$kept"
  else
    printf -v "$var" '%s' "$default"
  fi
}

settle COMPOSE_FILES COMPOSE_FILE "$GIVEN_COMPOSE_FILES" docker-compose.yml

# An absolute path: compose takes a bare name for a volume, and reads $, # and : in .env and in volumes itself.
absolute() {
  case "$1" in
    /*) printf '%s' "$1" ;;
    *) printf '%s' "$SCRIPT_DIR/${1#./}" ;;
  esac
}
[ -z "$GIVEN_SITES_DIR" ] || GIVEN_SITES_DIR=$(absolute "$GIVEN_SITES_DIR")
settle SITES_DIR T3X_SITES_DIR "$GIVEN_SITES_DIR" "$SCRIPT_DIR/sites" absolute
if [[ ! $SITES_DIR =~ ^/[A-Za-z0-9_./+@,-]+$ ]]; then
  fail "T3X_SITES_DIR（$SITES_DIR）只能由字母、数字和 _ . / + @ , - 组成：compose 会解释其他字符。"
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
# The ports Caddy uses on the host's loopback with docker-compose.host-network.yml; they go into .env so that
# `docker compose` by hand and a rerun use the same ones.
host_ports_text=""
case ":$COMPOSE_FILES:" in
  *:docker-compose.host-network.yml:*)
    for entry in T3X_HOST_REGISTRY_PORT:17080 T3X_HOST_ASK_PORT:17082 T3X_HOST_FRPS_PORT:17000 T3X_HOST_VHOST_PORT:17088 T3X_HOST_NTFY_PORT:17090; do
      key=${entry%%:*}
      settle port "$key" "${!key:-}" "${entry##*:}"
      if [[ ! $port =~ ^[0-9]{1,5}$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then
        fail "$key 必须是 1 到 65535 之间的端口号"
      fi
      host_ports_text="$host_ports_text
$key=$port"
    done
    ;;
esac
# The value goes into .env and into the Caddyfile, so only a plain address is accepted.
if [ -n "$email" ] && { [ "${#email}" -gt 254 ] || [[ ! $email =~ $email_pattern ]]; }; then
  fail "--email 必须是一个普通的邮箱地址，例如 you@example.com"
fi

origin="https://$domain"
ntfy_url="https://ntfy.$domain"
if [ "$public_port" != 443 ]; then
  origin="$origin:$public_port"
  ntfy_url="$ntfy_url:$public_port"
fi

compose_args=(-p "$PROJECT" --env-file "$DATA_DIR/.env")
IFS=: read -r -a files <<<"$COMPOSE_FILES"
for file in "${files[@]}"; do
  compose_args+=(-f "$SCRIPT_DIR/$file")
done
compose() {
  docker compose "${compose_args[@]}" "$@"
}

# Caddy's `email` line is a file of its own, so that a missing address leaves no empty `email` behind.
if [ -n "$email" ]; then
  acme_email_conf=./caddy/acme-email.caddy
else
  acme_email_conf=./caddy/acme-email-off.caddy
fi

if [ "$ntfy" = 1 ]; then
  profiles=ntfy
  ntfy_site=./caddy/ntfy.caddy
else
  profiles=""
  ntfy_site=./caddy/ntfy-off.caddy
fi

env_text="# 由 setup.sh 写入。换域名：删掉这个文件，再运行 setup.sh。
T3X_DOMAIN=$domain
T3X_PUBLIC_ORIGIN=$origin
ACME_EMAIL=$email
COMPOSE_PROFILES=$profiles
COMPOSE_PROJECT_NAME=$PROJECT
COMPOSE_FILE=$COMPOSE_FILES
T3X_NTFY_SITE=$ntfy_site
T3X_NTFY_URL=$ntfy_url
T3X_ACME_EMAIL_CONF=$acme_email_conf
T3X_NTFY_ENABLED=$ntfy
T3X_SITES_DIR=$SITES_DIR$host_ports_text"

if [ "$dry_run" = 1 ]; then
  echo "试运行：不会写任何文件，也不会启动服务。"
  echo
  echo "将写入 $DATA_DIR/.env："
  printf '%s\n' "$env_text" | sed 's/^/  /'
  [ "$ntfy" = 1 ] && echo "将创建 $DATA_DIR/secrets/ntfy-phone.txt，内容是随机密码（权限 0600）。"
  echo "将运行：docker compose ${compose_args[*]} up -d --build --wait"
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
if [ -f "$DATA_DIR/.env" ]; then
  existing=$(sed -n 's/^T3X_DOMAIN=//p' "$DATA_DIR/.env")
  if [ "$existing" != "$domain" ]; then
    fail "$DATA_DIR/.env 已经是为 '$existing' 装好的。换域名等于重新开始：先删掉 .env 和注册表的数据卷。"
  fi
fi
printf '%s\n' "$env_text" >"$DATA_DIR/.env"

if [ "$ntfy" = 1 ] && [ ! -s "$DATA_DIR/secrets/ntfy-phone.txt" ]; then
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$DATA_DIR/secrets/ntfy-phone.txt"
  echo >>"$DATA_DIR/secrets/ntfy-phone.txt"
fi

echo "正在启动服务（第一次构建大约要一分钟）..."
compose up -d --build --wait

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
