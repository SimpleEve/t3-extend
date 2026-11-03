#!/usr/bin/env bash
# Sets up T3 Extend's registry, tunnel server, HTTPS and (by default) push server on this VPS.
#
#   ./setup.sh --domain t3.example.com --email you@example.com [--no-ntfy]
#
# It needs Docker with the compose plugin, and nothing else: it installs no packages, starts no system
# service and does not touch the firewall. Open 80/tcp and 443/tcp yourself.
#
# For trying it somewhere that must stay untouched (see README "Try it locally"):
#   T3X_DATA_DIR   where .env and secrets/ go (default: next to this script)
#   T3X_COMPOSE_FILES  compose files to use, colon separated, relative to this script (default: docker-compose.yml)
#   T3X_PROJECT    compose project name (default: t3x)
#   --public-port  the port the HTTPS site is reachable on (default 443)
#   --dry-run      print what would happen and change nothing
set -euo pipefail

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
DATA_DIR=${T3X_DATA_DIR:-$SCRIPT_DIR}
PROJECT=${T3X_PROJECT:-t3x}
COMPOSE_FILES=${T3X_COMPOSE_FILES:-docker-compose.yml}

domain=""
email=""
public_port=443
ntfy=1
dry_run=0

usage() {
  sed -n '2,/^set -e/p' "$0" | sed '$d' | sed 's/^# \{0,1\}//'
}

fail() {
  echo "error: $*" >&2
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
    *) fail "unknown option: $1 (try --help)" ;;
  esac
done

[ -n "$domain" ] || fail "--domain is required, for example --domain t3.example.com"
domain=$(printf '%s' "$domain" | tr 'A-Z' 'a-z')
if ! printf '%s' "$domain" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'; then
  fail "'$domain' does not look like a domain name (no scheme, no port, no path)"
fi
case "$public_port" in
  '' | *[!0-9]*) fail "--public-port must be a number" ;;
esac
local_trial=0
case ":$COMPOSE_FILES:" in
  *:docker-compose.test.yml:*) local_trial=1 ;;
esac
if [ "$public_port" != 443 ] && [ "$local_trial" = 0 ]; then
  fail "--public-port is only for local trials (T3X_COMPOSE_FILES=docker-compose.yml:docker-compose.test.yml)"
fi
# Let's Encrypt wants an address for expiry notices; a local trial uses Caddy's own CA and needs none.
if [ "$local_trial" = 0 ] && [ -z "$email" ]; then
  fail "--email is required, for example --email you@example.com"
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

if [ "$ntfy" = 1 ]; then
  profiles=ntfy
  ntfy_site=./caddy/ntfy.caddy
else
  profiles=""
  ntfy_site=./caddy/ntfy-off.caddy
fi

env_text="# Written by setup.sh. Delete this file and run setup.sh again to change the domain.
T3X_DOMAIN=$domain
T3X_PUBLIC_ORIGIN=$origin
ACME_EMAIL=$email
COMPOSE_PROFILES=$profiles
T3X_NTFY_SITE=$ntfy_site
T3X_NTFY_URL=$ntfy_url"

if [ "$dry_run" = 1 ]; then
  echo "Dry run: nothing will be written or started."
  echo
  echo "Would write $DATA_DIR/.env:"
  printf '%s\n' "$env_text" | sed 's/^/  /'
  [ "$ntfy" = 1 ] && echo "Would create $DATA_DIR/secrets/ntfy-phone.txt with a random password (mode 0600)."
  echo "Would run: docker compose ${compose_args[*]} up -d --build --wait"
  [ "$ntfy" = 1 ] && echo "Would create the ntfy account 'phone' (read-only on up*)."
  echo "Would run: $SCRIPT_DIR/t3x invite --kind computer"
  exit 0
fi

command -v docker >/dev/null 2>&1 || fail "Docker is not installed. Install Docker and the compose plugin first: https://docs.docker.com/engine/install/"
docker compose version >/dev/null 2>&1 || fail "The Docker compose plugin is missing: https://docs.docker.com/compose/install/"

umask 077
mkdir -p "$DATA_DIR/secrets"
if [ -f "$DATA_DIR/.env" ]; then
  existing=$(sed -n 's/^T3X_DOMAIN=//p' "$DATA_DIR/.env")
  if [ "$existing" != "$domain" ]; then
    fail "$DATA_DIR/.env already sets up '$existing'. Changing the domain means starting over: remove .env and the registry volume first."
  fi
fi
printf '%s\n' "$env_text" >"$DATA_DIR/.env"

if [ "$ntfy" = 1 ] && [ ! -s "$DATA_DIR/secrets/ntfy-phone.txt" ]; then
  head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n' >"$DATA_DIR/secrets/ntfy-phone.txt"
  echo >>"$DATA_DIR/secrets/ntfy-phone.txt"
fi

echo "Starting the services (the first build takes a minute)..."
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
echo "Before the first computer can join, check:"
echo "  * a DNS record: $domain and *.$domain both point at this server"
echo "  * the firewall (and your cloud provider's security group) allows 80/tcp and 443/tcp, and nothing else is needed"
echo
echo "Invite your first computer: in T3 Extend on that computer, choose to join your own server and paste this:"
echo
T3X_DATA_DIR="$DATA_DIR" T3X_COMPOSE_FILES="$COMPOSE_FILES" T3X_PROJECT="$PROJECT" "$SCRIPT_DIR/t3x" invite --kind computer
if [ "$ntfy" = 1 ]; then
  echo
  echo "Push notifications for an Android phone: run ./t3x ntfy to see the server address and password."
fi
echo
echo "More invites any time: ./t3x invite --kind computer   or   ./t3x invite --kind phone"
