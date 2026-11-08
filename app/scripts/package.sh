#!/bin/sh
# Package the app for KaiOS 3.0, 3.1, and 4.0 sideloading / OStore Manual Install.
#
# KaiOS 2.5 support has been removed in v2.0.0. The app targets KaiOS 3.0, 3.1 (Gecko 84), and 4.0 (Gecko 123) and bundles the on-device Signal Protocol engine into app/vendor/signal-engine.bundle.js.
set -e
cd "$(dirname "$0")/../.."

# --- Build on-device Signal engine bundle ---------------------------------
if [ -f package.json ] && command -v npm >/dev/null 2>&1; then
  npm run build
fi

# --- Manifest / ServiceWorker / Bundle presence ---------------------------
for required in app/manifest.webmanifest app/sw.js app/vendor/signal-engine.bundle.js; do
  if [ ! -f "$required" ]; then
    echo "FAIL: missing $required (needed for KaiOS 3.0/3.1/4.0 install)." >&2
    exit 1
  fi
done

# --- Version check ---------------------------------------------------------
# When RELEASE_TAG is set (CI), the tag must be v<version>, optionally with a pre-release suffix (v2.0.0-rc1).
manifest_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}
VERSION=$(manifest_version app/manifest.webmanifest)
if [ -z "$VERSION" ]; then
  echo "FAIL: missing version in app/manifest.webmanifest" >&2
  exit 1
fi
if [ -n "$RELEASE_TAG" ]; then
  case "$RELEASE_TAG" in
    "v$VERSION"|"v$VERSION"-*) ;;
    *)
      echo "FAIL: tag $RELEASE_TAG does not match manifest.webmanifest version $VERSION" >&2
      exit 1
      ;;
  esac
  ASSET_VERSION="${RELEASE_TAG#v}"
else
  ASSET_VERSION="$VERSION"
fi

# --- Zip -------------------------------------------------------------------
mkdir -p dist
rm -f dist/signal4kaios.zip dist/signal4kaios-*.zip
# Exclude app/scripts (build/deploy helpers) so they don't ship inside the app.
(cd app && zip -qr ../dist/signal4kaios.zip . -x '*.DS_Store' -x 'scripts/*')
cp dist/signal4kaios.zip "dist/signal4kaios-$ASSET_VERSION.zip"
echo "OK: dist/signal4kaios.zip and dist/signal4kaios-$ASSET_VERSION.zip (version $VERSION)"
echo
echo "Install on KaiOS 3.0/3.1/4.0: sh app/scripts/install-kaios3plus.sh   (needs adb + appscmd)"
