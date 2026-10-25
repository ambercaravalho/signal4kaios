#!/bin/sh
# Build the OStore source (webapps.json + Apps-directory/) for a released package.
#
# Usage:
#   sh scripts/build-store-source.sh <zip> <package_url> [out_dir]
#
#   <zip>          the packaged app, e.g. dist/signal4kaios-1.2.0.zip
#   <package_url>  the public HTTPS URL of that ZIP (the GitHub Release asset)
#   [out_dir]      defaults to _site
#
# Writes:
#   <out_dir>/index.html, webapps.json
#   <out_dir>/Apps-directory/<folder>/manifest.webmanifest, update.webmanifest
#   dist/store-entry.json  (the webapps.json app entry, for other catalogues)
#
# Requires jq. Run only after the package is live at <package_url>: OStore
# fetches the metadata first and expects the advertised package to exist.
set -e
cd "$(dirname "$0")/.."

ZIP="$1"
PACKAGE_URL="$2"
OUT="${3:-_site}"

if [ -z "$ZIP" ] || [ -z "$PACKAGE_URL" ]; then
  echo 'Usage: sh scripts/build-store-source.sh <zip> <package_url> [out_dir]' >&2
  exit 1
fi
if [ ! -f "$ZIP" ]; then
  echo "FAIL: $ZIP not found (run app/scripts/package.sh first)." >&2
  exit 1
fi
if ! command -v jq >/dev/null 2>&1; then
  echo 'FAIL: jq not found on PATH.' >&2
  exit 1
fi
case "$PACKAGE_URL" in
  https://*) ;;
  *) echo 'FAIL: package_url must be https://' >&2; exit 1 ;;
esac

MANIFEST=app/manifest.webmanifest
CATALOG=store/catalog.json

SIZE=$(wc -c < "$ZIP" | tr -d ' ')
if command -v sha256sum >/dev/null 2>&1; then
  SHA256=$(sha256sum "$ZIP" | cut -d ' ' -f 1)
else
  SHA256=$(shasum -a 256 "$ZIP" | cut -d ' ' -f 1)
fi
VERSION=$(jq -r '.b2g_features.version' "$MANIFEST")
FOLDER=$(jq -r '.app.folder' "$CATALOG")

rm -rf "$OUT"
mkdir -p "$OUT/Apps-directory/$FOLDER" dist
cp store/index.html "$OUT/index.html"
cp "$MANIFEST" "$OUT/Apps-directory/$FOLDER/manifest.webmanifest"

jq -n \
  --slurpfile m "$MANIFEST" \
  --arg url "$PACKAGE_URL" \
  --argjson size "$SIZE" \
  '$m[0] as $m | {
    name: $m.name,
    version: $m.b2g_features.version,
    package_path: $url,
    packaged_size: $size,
    size: $size,
    type: $m.b2g_features.type,
    b2g_features: {
      permissions: $m.b2g_features.permissions,
      version: $m.b2g_features.version,
      origin: $m.b2g_features.origin,
      type: $m.b2g_features.type
    }
  }' > "$OUT/Apps-directory/$FOLDER/update.webmanifest"

jq \
  --arg version "$VERSION" \
  --arg url "$PACKAGE_URL" \
  --arg sha "$SHA256" \
  '.app + { version: $version, package_url: $url, sha256: $sha }' \
  "$CATALOG" > dist/store-entry.json

jq -n \
  --slurpfile c "$CATALOG" \
  --slurpfile e dist/store-entry.json \
  '{ schema: 1, categories: $c[0].categories, apps: [ $e[0] ] }' \
  > "$OUT/webapps.json"

echo "OK: $OUT/ (version $VERSION, $SIZE bytes, sha256 $SHA256)"
echo "OK: dist/store-entry.json"
