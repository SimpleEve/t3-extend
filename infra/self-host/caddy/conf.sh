#!/usr/bin/env bash
# 写出 Caddy 容器读的配置目录（compose 把整个目录挂进去，不是单个文件）。setup.sh、端到端测试和静态检查都用它。
#
#   caddy/conf.sh <目录> [--test] [--ntfy] [--email 地址]
#
# 目录里只有三个文件：Caddyfile（--test 用 Caddyfile.test）、ntfy.caddy（--ntfy 才有路由）、acme-email.caddy
# （有 --email 才有 email 一行）。开关在这些文件的内容里，不在 compose 的环境变量里：环境变量变了 Caddy 的定义就变了，
# 就得重建它；文件变了只需要重载。每个文件先写临时文件再 mv，换掉的是文件，不是目录。
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
dest=""
test_mode=0
ntfy=0
email=""
email_pattern='^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$'

while [ $# -gt 0 ]; do
  case "$1" in
    --test) test_mode=1; shift ;;
    --ntfy) ntfy=1; shift ;;
    --email) [ $# -ge 2 ] || { echo "--email 需要一个值" >&2; exit 1; }; email=$2; shift 2 ;;
    -*) echo "未知参数：$1" >&2; exit 1 ;;
    *) [ -z "$dest" ] || { echo "只能给一个目录" >&2; exit 1; }; dest=$1; shift ;;
  esac
done
[ -n "$dest" ] || { echo "用法：caddy/conf.sh <目录> [--test] [--ntfy] [--email 地址]" >&2; exit 1; }
if [ -n "$email" ] && [[ ! $email =~ $email_pattern ]]; then
  echo "邮箱必须是一个普通的邮箱地址" >&2
  exit 1
fi

mkdir -p "$dest"
# put <name> < content: the file appears whole under its name, or not at all.
put() {
  local tmp
  tmp=$(mktemp "$dest/.tmp.XXXXXX")
  cat >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$dest/$1"
}

if [ "$test_mode" = 1 ]; then put Caddyfile <"$here/Caddyfile.test"; else put Caddyfile <"$here/Caddyfile"; fi
if [ "$ntfy" = 1 ]; then put ntfy.caddy <"$here/caddy/ntfy.caddy"; else put ntfy.caddy <"$here/caddy/ntfy-off.caddy"; fi
if [ -n "$email" ]; then
  printf 'email %s\n' "$email" | put acme-email.caddy
else
  put acme-email.caddy <"$here/caddy/acme-email-off.caddy"
fi
