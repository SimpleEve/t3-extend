#!/bin/sh
# Installs the T3 Extend CLI (`t3x`) from a GitHub Release archive of SimpleEve/t3-extend. Needs only
# sh, tar, sha256sum or shasum, and curl or wget; no Node, npm, or compiler.
#
#   curl -fsSL https://raw.githubusercontent.com/SimpleEve/t3-extend/main/scripts/install-t3x.sh | sh
#
# Environment:
#   T3X_VERSION           exact version to install (default: the latest release)
#   T3X_HOME              T3 Extend home directory (default: ~/.t3extend)
#   T3X_INSTALL_BIN_DIR   where the `t3x` command goes (default: ~/.local/bin)
#   T3X_RELEASE_BASE_URL  mirror for releases/download (default: GitHub)
#   T3X_LATEST_URL        page that names the latest release (default: GitHub)
#
# The archive is unpacked into $T3X_HOME/runtime/versions/<version>, the layout `t3x service install`
# and `t3x update` use, so the service reuses this download and an update repoints this launcher.
# This script is T3 Extend's own: it never reads or writes official T3 Code's home or its `t3`
# command, and it refuses a T3X_HOME that is official T3 Code's. The variables above are not the
# server's T3CODE_* ones on purpose: an exported T3CODE_HOME for the official app must not redirect it.
set -eu

repo="SimpleEve/t3-extend"
base_url="${T3X_RELEASE_BASE_URL:-https://github.com/${repo}/releases/download}"
latest_url="${T3X_LATEST_URL:-https://github.com/${repo}/releases/latest}"
t3x_home="${T3X_HOME:-$HOME/.t3extend}"
case "$t3x_home" in
  /*) ;;
  *) t3x_home="$PWD/$t3x_home" ;;
esac
bin_dir="${T3X_INSTALL_BIN_DIR:-$HOME/.local/bin}"
case "$bin_dir" in /*) ;; *) bin_dir="$PWD/$bin_dir" ;; esac
while [ "${t3x_home%/}" != "$t3x_home" ] && [ "$t3x_home" != / ]; do t3x_home="${t3x_home%/}"; done
while [ "${bin_dir%/}" != "$bin_dir" ] && [ "$bin_dir" != / ]; do bin_dir="${bin_dir%/}"; done

fail() {
  printf '\nt3x install: %s\n' "$1" >&2
  exit 1
}
step() { printf '  %s\n' "$1" >&2; }

# Official T3 Code's home, by name and by where it resolves, however this one is spelled.
official_home="$HOME/.t3"
resolve_dir() { (CDPATH='' cd -P -- "$1" 2>/dev/null && pwd) || printf '%s' "$1"; }
if [ "$t3x_home" = "$official_home" ] || [ "$(resolve_dir "$t3x_home")" = "$(resolve_dir "$official_home")" ]; then
  fail "${t3x_home} is official T3 Code's home. T3 Extend uses ~/.t3extend; leave T3X_HOME unset or point it elsewhere."
fi

# Sleeps 1, 2, then 4 s before retrying a 408, 429, 5xx, or network error.
backoff() {
  case "$1" in 408 | 429) ;; 4??) return 1 ;; esac
  [ "$2" -lt 4 ] && sleep "$((1 << ($2 - 1)))"
}

# Exit 44 on a 404 so callers can tell "no such asset" from a network failure.
fetch() {
  if command -v curl >/dev/null 2>&1; then
    attempt=1
    while :; do
      code=0; status="$(curl -sSL -H "Accept: ${3:-*/*}" -w '%{http_code}' "$1" -o "$2")" || code=$?
      case "$code:$status" in 0:2??) break ;; esac
      backoff "$status" "$attempt" || break
      attempt=$((attempt + 1))
    done
    [ "$code" -eq 0 ] || return 1
    case "$status" in
      2??) return 0 ;;
      404) return 44 ;;
      *) printf 'GET %s returned HTTP %s\n' "$1" "$status" >&2; return 1 ;;
    esac
  elif command -v wget >/dev/null 2>&1; then
    wget -q --server-response --header="Accept: ${3:-*/*}" "$1" -O "$2" 2>"$2.headers" && rm -f "$2.headers" && return 0
    if grep -q ' 404 ' "$2.headers" 2>/dev/null; then rm -f "$2.headers"; return 44; fi
    cat "$2.headers" >&2; rm -f "$2.headers"; return 1
  else
    fail "curl or wget is required"
  fi
}

case "$(uname -s)" in
  Darwin) platform="darwin" ;;
  Linux) platform="linux" ;;
  *) fail "unsupported operating system $(uname -s); T3 Extend's CLI is built for macOS (Apple silicon) and Linux" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) fail "unsupported architecture $(uname -m)" ;;
esac
if [ "${platform}-${arch}" = darwin-x64 ]; then
  fail "there is no t3x CLI for Intel Macs: Node single-executables do not run there."
fi
command -v tar >/dev/null 2>&1 || fail "tar is required"
if command -v sha256sum >/dev/null 2>&1; then
  checksum() { sha256sum < "$1" | cut -d' ' -f1; }
elif command -v shasum >/dev/null 2>&1; then
  checksum() { shasum -a 256 < "$1" | cut -d' ' -f1; }
else
  fail "sha256sum or shasum is required"
fi

version="${T3X_VERSION:-}"
if [ -z "$version" ]; then
  step "Finding the latest release..."
  tmp_index="$(mktemp)"
  fetch "$latest_url" "$tmp_index" application/json || fail "could not look up the latest release; set T3X_VERSION"
  version="$(sed -n 's/.*"tag_name": *"v\([0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' "$tmp_index" | head -n 1)"
  rm -f "$tmp_index"
  [ -n "$version" ] || fail "could not find a release; set T3X_VERSION"
fi
case "$version" in
  [0-9]*.[0-9]*.[0-9]* | [0-9]*.[0-9]*.[0-9]*-*) ;;
  *) fail "'${version}' is not a version like 1.2.3" ;;
esac
case "$version" in */* | *..*) fail "'${version}' is not a version like 1.2.3" ;; esac

archive="t3-${version}-${platform}-${arch}.tar.gz"
versions_dir="${t3x_home}/runtime/versions"
target_dir="${versions_dir}/${version}"

if [ -f "${target_dir}/.install-complete" ] && [ "$(cat "${target_dir}/.install-complete")" = "$version" ]; then
  step "Version ${version} is already downloaded."
else
  mkdir -p "$versions_dir"
  staging="$(mktemp -d "${versions_dir}/.staging-XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM

  step "Installing T3 Extend ${version} (${platform}-${arch})..."
  fetch_status=0
  fetch "${base_url}/v${version}/SHA256SUMS" "${staging}/SHA256SUMS" || fetch_status=$?
  if [ "$fetch_status" -eq 44 ]; then
    fail "there is no release v${version} of ${repo}"
  elif [ "$fetch_status" -ne 0 ]; then
    fail "could not download the release checksums"
  fi
  expected="$(grep " \*\{0,1\}${archive}\$" "${staging}/SHA256SUMS" | cut -d' ' -f1)"
  [ -n "$expected" ] || fail "t3x ${version} has no release archive for ${platform}-${arch}"
  step "Downloading ${archive}..."
  fetch "${base_url}/v${version}/${archive}" "${staging}/${archive}" || fail "could not download ${archive}"

  step "Verifying the download..."
  actual="$(checksum "${staging}/${archive}")"
  [ "$actual" = "$expected" ] || fail "checksum mismatch for ${archive}"

  step "Extracting..."
  tar -xzf "${staging}/${archive}" -C "$staging" --strip-components=1
  rm -f "${staging}/${archive}" "${staging}/SHA256SUMS"
  "${staging}/t3" --version >/dev/null || fail "the downloaded executable does not run"
  printf '%s\n' "$version" > "${staging}/.install-complete"

  rm -rf "$target_dir"
  mv "$staging" "$target_dir"
  trap - EXIT
fi

step "Setting up the t3x command..."
mkdir -p "$bin_dir"
# Exec by absolute path, the script `t3x update` and `t3x service install` write and recognise: through
# a symlink, argv0 is the link, and the Cursor SDK looks for its helpers beside it.
nl='
'
launcher_head="#!/bin/sh${nl}exec '"
launcher_tail="' \"\$@\"${nl}"
quoted_target="$(printf '%sx' "${target_dir}/t3" | sed "s/'/'\\\\''/g")"
launcher_content="${launcher_head}${quoted_target%x}${launcher_tail}"

# An existing t3x is replaced only when it is this home's own launcher (it runs a runtime under this
# home's versions directory). A symlink, a copy of the binary, or a user's wrapper is someone else's.
if [ -e "${bin_dir}/t3x" ] || [ -L "${bin_dir}/t3x" ]; then
  owned=false
  if [ -f "${bin_dir}/t3x" ] && [ ! -L "${bin_dir}/t3x" ] && [ "$(wc -c < "${bin_dir}/t3x")" -le 4096 ]; then
    existing="$(sed -n "s/^exec '\\(.*\\)' \"\\\$@\"\$/\\1/p" "${bin_dir}/t3x" | head -n 1)"
    case "$existing" in
      "${versions_dir}"/*/t3) owned=true ;;
    esac
  fi
  "$owned" || fail "another t3x is already at ${bin_dir}/t3x. Remove it and run this again, or run ${target_dir}/t3 directly."
fi
launcher_tmp="$(mktemp "${bin_dir}/.t3x.XXXXXX")"
trap 'rm -f "$launcher_tmp"' EXIT
printf '%s' "$launcher_content" > "$launcher_tmp"
chmod 755 "$launcher_tmp"
mv -f "$launcher_tmp" "${bin_dir}/t3x"
trap - EXIT

# `t3x update` finds the launcher to repoint through this list, and pruning keeps what it points at.
launcher="$(resolve_dir "$bin_dir")/t3x"
launchers="${t3x_home}/runtime/launchers"
grep -qxF "$launcher" "$launchers" 2>/dev/null || printf '%s\n' "$launcher" >> "$launchers"

printf '\n  Installed T3 Extend %s: %s\n\n' "$version" "${bin_dir}/t3x" >&2
case ":${PATH}:" in
  *":${bin_dir}:"* | *":${bin_dir}/:"*)
    printf '  Run t3x to use T3 Extend here, or `t3x service install` to keep it running in the background.\n\n' ;;
  *)
    printf '  %s is not on your PATH yet. Add it, for example:\n\n    export PATH="$PATH:%s"\n\n  Then open a new terminal and run t3x.\n\n' "$bin_dir" "$bin_dir" ;;
esac
