#!/bin/sh
# First run on Linux/macOS: make sure Node.js 18+ exists (portable copy in ~/.local/share/rdgpu/node, no root),
# then run `rdgpu.mjs install` with the given arguments.
#   sh <skill>/scripts/bootstrap.sh [install args]
#   --node-only   only find/install Node and print its path
set -eu
here=$(cd "$(dirname "$0")" && pwd)
node_dir="${XDG_DATA_HOME:-$HOME/.local/share}/rdgpu/node"
portable="$node_dir/bin/node"

node_ok() { v=$("$1" --version 2>/dev/null) || return 1; major=${v#v}; major=${major%%.*}; [ "$major" -ge 18 ] 2>/dev/null; }

node=""
if [ -x "$portable" ] && node_ok "$portable"; then node="$portable"
elif command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then node=$(command -v node)
fi

if [ -z "$node" ]; then
  echo "[do] installing portable Node.js LTS into $node_dir (no root needed)"
  case "$(uname -s)" in Linux) os=linux ;; Darwin) os=darwin ;; *) echo "unsupported OS $(uname -s): install Node.js 18+ manually" >&2; exit 1 ;; esac
  case "$(uname -m)" in x86_64|amd64) arch=x64 ;; aarch64|arm64) arch=arm64 ;; *) echo "unsupported CPU $(uname -m): install Node.js 18+ manually" >&2; exit 1 ;; esac
  index=$(curl -fsSL https://nodejs.org/dist/index.json)
  ver=$(printf '%s' "$index" | tr '{' '\n' | grep "\"$os-$arch\"" | grep -v '"lts":false' | head -n 1 | sed 's/.*"version":"\([^"]*\)".*/\1/')
  [ -n "$ver" ] || { echo "could not find a Node.js LTS build for $os-$arch" >&2; exit 1; }
  name="node-$ver-$os-$arch"
  tmp=$(mktemp -d)
  curl -fsSL "https://nodejs.org/dist/$ver/$name.tar.gz" -o "$tmp/$name.tar.gz"
  want=$(curl -fsSL "https://nodejs.org/dist/$ver/SHASUMS256.txt" | grep " $name.tar.gz\$" | cut -d' ' -f1)
  if command -v sha256sum >/dev/null 2>&1; then have=$(sha256sum "$tmp/$name.tar.gz" | cut -d' ' -f1); else have=$(shasum -a 256 "$tmp/$name.tar.gz" | cut -d' ' -f1); fi
  [ -n "$want" ] && [ "$want" = "$have" ] || { echo "checksum mismatch for $name.tar.gz" >&2; rm -rf "$tmp"; exit 1; }
  tar -xzf "$tmp/$name.tar.gz" -C "$tmp"
  rm -rf "$node_dir"; mkdir -p "$(dirname "$node_dir")"
  mv "$tmp/$name" "$node_dir"; rm -rf "$tmp"
  node_ok "$portable" || { echo "installed $portable but it does not run" >&2; exit 1; }
  node="$portable"
  echo "[ok] Node.js $ver installed"
fi

echo "[ok] node: $node"
echo "Run the CLI as:  \"$node\" \"$here/rdgpu.mjs\" <command> ..."
[ "${1:-}" = "--node-only" ] && exit 0
exec "$node" "$here/rdgpu.mjs" install "$@"
