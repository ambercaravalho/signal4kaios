#!/bin/sh
# Package the app for KaiOS sideloading, gated on Gecko 48 compatibility.
#
# The app targets KaiOS 2.5 (Gecko 48), 3.0/3.1 (Gecko 84), and 4.0 (Gecko 123).
# The Gecko-48 syntax gate below only scans first-party page code under app/js,
# which must stay ES5 for 2.5. app/sw.js lives outside app/js (it is 3.0+ only)
# and is not gated, but is kept ES5-clean for consistency.
set -e
cd "$(dirname "$0")/../.."

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

# --- Manifest / ServiceWorker presence ------------------------------------
# 2.5 reads manifest.webapp; 3.0/3.1/4.0 read manifest.webmanifest. Ship both so
# a single package installs on any of them. sw.js backs 3.0+ background wake.
for required in app/manifest.webapp app/manifest.webmanifest app/sw.js; do
  if [ ! -f "$required" ]; then
    echo "FAIL: missing $required (needed for cross-version install)." >&2
    exit 1
  fi
done

# --- Zip -------------------------------------------------------------------
mkdir -p dist
rm -f dist/signal4kaios.zip
# Exclude app/scripts (build/deploy helpers) so they don't ship inside the app.
(cd app && zip -qr ../dist/signal4kaios.zip . -x '*.DS_Store' -x 'scripts/*')
echo "OK: dist/signal4kaios.zip"
echo
echo "Install on KaiOS 2.5:         WebIDE (old Firefox) -> Open Packaged App -> app/"
echo "Install on KaiOS 3.0/3.1/4.0: sh app/scripts/install-kaios3plus.sh   (needs adb + appscmd)"
