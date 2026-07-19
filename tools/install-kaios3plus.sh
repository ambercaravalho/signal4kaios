#!/bin/sh
# Install the app onto a KaiOS 3.0/3.1/4.0 device with debugging enabled.
#
# KaiOS 3.0+ dropped the old WebIDE flow. Packaged apps are installed with the
# `appscmd` tool over an adb-forwarded debugger socket. This helper wires up the
# forward and runs the install against the app/ folder.
#
# Prerequisites:
#   - adb on your PATH, device connected, "ADB and DevTools" enabled on-device.
#   - appscmd for your desktop from https://github.com/kaiostech/appscmd (the
#     binaries are committed in the repo root, e.g. appscmd-aarch64-apple-darwin
#     for Apple Silicon), made executable. Point APPSCMD at it, or drop it on
#     your PATH as `appscmd`.
#
# Usage:
#   APPSCMD=/path/to/appscmd sh tools/install-kaios3plus.sh
#
# Launch from the phone's app list, or from the desktop with:
#   appscmd launch http://signal4kaios.localhost/manifest.webmanifest
# (the launch subcommand wants the full manifest URL, not the short name). If the
# app doesn't appear, reboot the phone.
#
# Debug afterwards with a modern Firefox at about:debugging (NOT the 2.5 WebIDE,
# which cannot speak the Gecko 84/123 remote protocol).
set -e
cd "$(dirname "$0")/.."

APPSCMD="${APPSCMD:-appscmd}"
PORT="${PORT:-6000}"

if ! command -v adb >/dev/null 2>&1; then
  echo 'FAIL: adb not found on PATH.' >&2
  exit 1
fi
if ! command -v "$APPSCMD" >/dev/null 2>&1 && [ ! -x "$APPSCMD" ]; then
  echo "FAIL: appscmd not found. Set APPSCMD=/path/to/appscmd." >&2
  echo '      Download it from https://github.com/kaiostech/appscmd' >&2
  exit 1
fi

echo "adb root + forward tcp:$PORT -> debugger-socket"
adb root
adb forward "tcp:$PORT" localfilesystem:/data/local/debugger-socket

echo "Installing app/ via appscmd (port $PORT)"
"$APPSCMD" --host "localhost:$PORT" install app/ || "$APPSCMD" install app/

echo
echo "OK: installed. Reboot the phone for it to take effect."
echo "Debug via a modern Firefox -> about:debugging -> This Firefox / USB."
