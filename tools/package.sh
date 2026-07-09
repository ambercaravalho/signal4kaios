#!/bin/sh
# Package the app for KaiOS sideloading, gated on Gecko 48 compatibility.
set -e
cd "$(dirname "$0")/.."

# --- Gecko 48 syntax gate -------------------------------------------------
# KaiOS 2.5 runs Gecko 48: no async/await, no spread/rest (...), no
# String.padStart, no CSS grid. Fail packaging if any slips in.
if grep -rnE '(^|[^A-Za-z0-9_$])(async|await)[ (]' app/js; then
  echo 'FAIL: async/await is not supported on Gecko 48.' >&2
  exit 1
fi
if grep -rnF '...' app/js | grep -v '…'; then
  echo 'FAIL: spread/rest (three dots) is not supported on Gecko 48.' >&2
  exit 1
fi
if grep -rn 'padStart\|padEnd' app/js; then
  echo 'FAIL: padStart/padEnd are unreliable on Gecko 48.' >&2
  exit 1
fi
if grep -rnE 'display:[[:space:]]*grid' app/css; then
  echo 'FAIL: CSS grid is not supported on Gecko 48.' >&2
  exit 1
fi

# --- Zip -------------------------------------------------------------------
mkdir -p dist
rm -f dist/signal4kaios.zip
(cd app && zip -qr ../dist/signal4kaios.zip . -x '*.DS_Store')
echo "OK: dist/signal4kaios.zip"
