#!/bin/sh
# Anchorage CLI installer (macOS / Linux).
#
#   curl -fsSL https://github.com/AnchorageLabs/anchorage/releases/latest/download/install.sh | sh
#
# Downloads the standalone binary for your OS/arch from the latest GitHub
# Release and drops it on your PATH. No Node/Bun required — the binary is
# self-contained. Override the source with ANCHORAGE_CLI_BASE_URL (e.g. a
# pinned release tag) and the target dir with ANCHORAGE_BIN_DIR.
set -eu

REPO="AnchorageLabs/anchorage"
BASE="${ANCHORAGE_CLI_BASE_URL:-https://github.com/${REPO}/releases/latest/download}"

os="$(uname -s)"
arch="$(uname -m)"
case "$os" in
  Darwin) os="darwin" ;;
  Linux) os="linux" ;;
  *) echo "anchorage: unsupported OS '$os' (macOS/Linux only; Windows: use install.ps1)" >&2; exit 1 ;;
esac
case "$arch" in
  arm64 | aarch64) arch="arm64" ;;
  x86_64 | amd64) arch="x64" ;;
  *) echo "anchorage: unsupported architecture '$arch'" >&2; exit 1 ;;
esac
# Only darwin ships arm64 + x64; linux ships x64.
if [ "$os" = "linux" ] && [ "$arch" != "x64" ]; then
  echo "anchorage: only linux-x64 is published" >&2; exit 1
fi

asset="anchorage-${os}-${arch}"
url="${BASE}/${asset}"

# Pick a writable install dir: ANCHORAGE_BIN_DIR > /usr/local/bin (if writable) > ~/.local/bin.
bindir="${ANCHORAGE_BIN_DIR:-}"
if [ -z "$bindir" ]; then
  if [ -w "/usr/local/bin" ]; then bindir="/usr/local/bin"; else bindir="${HOME}/.local/bin"; fi
fi
mkdir -p "$bindir"

tmp="$(mktemp)"
echo "Downloading ${asset}…"
curl -fSL --proto '=https' "$url" -o "$tmp"
chmod +x "$tmp"
mv "$tmp" "${bindir}/anchorage"

echo "Installed: ${bindir}/anchorage"
case ":${PATH}:" in
  *":${bindir}:"*) ;;
  *) echo "Add ${bindir} to your PATH:  export PATH=\"${bindir}:\$PATH\"" ;;
esac
