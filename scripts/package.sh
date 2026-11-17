#!/bin/sh
# Package the app for KaiOS 3.0, 3.1, and 4.0 sideloading / OStore Manual Install.
#
# The app targets KaiOS 3.0, 3.1 (Gecko 84), and 4.0 (Gecko 123). Signal Protocol cryptography comes from Signal's official libsignal crates compiled to src/app/vendor/libsignal_wasm_bg.wasm (npm run build:wasm); the Preact UI, the TypeScript engine, and the wasm-bindgen glue are bundled into src/app/build/app.js and app.css (npm run build).
set -e
cd "$(dirname "$0")/.."

# --- Build libsignal wasm + app bundle --------------------------------------
# SKIP_WASM_BUILD=1 reuses an existing src/native/libsignal-wasm/pkg (CI builds it in an earlier step).
if [ -f package.json ] && command -v npm >/dev/null 2>&1; then
  if [ "${SKIP_WASM_BUILD:-}" != "1" ]; then
    npm run build:wasm
  fi
  npm run build
fi

# --- Manifest / ServiceWorker / Bundle presence ---------------------------
for required in src/app/manifest.webmanifest src/app/sw.js src/app/build/app.js src/app/build/app.css src/app/build/backup.js src/app/build/call-worklet.js src/app/vendor/libsignal_wasm_bg.wasm; do
  if [ ! -f "$required" ]; then
    echo "FAIL: missing $required (needed for KaiOS 3.0/3.1/4.0 install)." >&2
    exit 1
  fi
done

# --- Privileged CSP: no eval / new Function anywhere in shipped scripts ---
# Gecko's privileged-app CSP has no 'unsafe-eval'; a dependency that sneaks in eval() would fail only at runtime on the phone.
if grep -rlE '(^|[^A-Za-z0-9_$])eval[[:space:]]*\(|new[[:space:]]+Function[[:space:]]*\(' src/app --include='*.js'; then
  echo "FAIL: the files above contain eval( or new Function, which the privileged CSP blocks." >&2
  exit 1
fi

# --- Privileged CSP: no inline script, style, or handlers in the page ---
sh scripts/check-html-csp.sh src/app/index.html

# --- Gecko 84: built-ins KaiOS 3.0/3.1 lack ----------------------------------
# esbuild lowers syntax but not missing built-ins; these would throw only on a KaiOS 3.x phone. Object.hasOwn is covered by scripts/gecko84-polyfill.js.
if grep -lE 'structuredClone|\.findLast(Index)?\(|AbortSignal\.(timeout|any)|Promise\.withResolvers|\.to(Sorted|Reversed|Spliced)\(|\.at\(' src/app/build/*.js; then
  echo "FAIL: the files above use built-ins Gecko 84 (KaiOS 3.0/3.1) lacks; add a fallback or a polyfill in scripts/gecko84-polyfill.js." >&2
  exit 1
fi

# --- Version check ---------------------------------------------------------
# When RELEASE_TAG is set (CI), the tag must be v<version>, optionally with a pre-release suffix (v2.0.0-rc1).
manifest_version() {
  sed -n 's/^[[:space:]]*"version":[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}
VERSION=$(manifest_version src/app/manifest.webmanifest)
if [ -z "$VERSION" ]; then
  echo "FAIL: missing version in src/app/manifest.webmanifest" >&2
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
(cd src/app && zip -qr ../../dist/signal4kaios.zip . -x '*.DS_Store')
# The ZIP ships AGPL-3.0 libsignal inside the wasm module, so the license terms travel with it.
zip -qj dist/signal4kaios.zip LICENSE NOTICE
cp dist/signal4kaios.zip "dist/signal4kaios-$ASSET_VERSION.zip"

# --- Update metadata ---------------------------------------------------------
# The app reads update.json from the latest release to find, size-check, and checksum the ZIP before installing it over itself.
ZIP_NAME="signal4kaios-$ASSET_VERSION.zip"
if command -v sha256sum >/dev/null 2>&1; then
  ZIP_SHA256=$(sha256sum "dist/$ZIP_NAME" | cut -d' ' -f1)
else
  ZIP_SHA256=$(shasum -a 256 "dist/$ZIP_NAME" | cut -d' ' -f1)
fi
ZIP_SIZE=$(wc -c < "dist/$ZIP_NAME" | tr -d ' ')
SECURITY=false
if awk -v h="## v$ASSET_VERSION" '$0 == h { on = 1; next } on && /^## / { exit } on' CHANGELOG.md | grep -q '^### Security[[:space:]]*$'; then
  SECURITY=true
fi
printf '{"version":"%s","tag":"v%s","zip":"%s","size":%s,"sha256":"%s","security":%s}\n' "$VERSION" "$ASSET_VERSION" "$ZIP_NAME" "$ZIP_SIZE" "$ZIP_SHA256" "$SECURITY" > dist/update.json

echo "OK: dist/signal4kaios.zip, dist/$ZIP_NAME, and dist/update.json (version $VERSION)"
echo
echo "Install on KaiOS 3.0/3.1/4.0: sh scripts/install.sh   (needs adb + appscmd)"
