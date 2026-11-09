#!/bin/sh
# Build the libsignal wasm wrapper: cargo (wasm32) -> wasm-bindgen (--target web) -> optional wasm-opt -> app/vendor.
#
# Requires the Rust toolchain pinned in rust-toolchain.toml (rustup installs it automatically), protoc (libsignal's build scripts compile .proto files), and wasm-bindgen-cli matching the wasm-bindgen version pinned in Cargo.toml.
set -eu
cd "$(dirname "$0")"

WASM_BINDGEN_VERSION=$(sed -n 's/^wasm-bindgen = "=\([^"]*\)"/\1/p' Cargo.toml)
if ! command -v wasm-bindgen >/dev/null 2>&1; then
  echo "FAIL: wasm-bindgen not found. Install it with: cargo install wasm-bindgen-cli --version $WASM_BINDGEN_VERSION --locked" >&2
  exit 1
fi
case "$(wasm-bindgen --version)" in
  *" $WASM_BINDGEN_VERSION") ;;
  *)
    echo "FAIL: wasm-bindgen CLI $(wasm-bindgen --version) does not match the pinned crate version $WASM_BINDGEN_VERSION" >&2
    exit 1
    ;;
esac

cargo build --release --locked
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/libsignal_wasm.wasm
# The glue is ES module syntax; this lets Node's test runner load it directly when needed.
printf '{ "type": "module" }\n' > pkg/package.json

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int --enable-reference-types --enable-multivalue pkg/libsignal_wasm_bg.wasm -o pkg/libsignal_wasm_bg.wasm
fi

mkdir -p ../../app/vendor
cp pkg/libsignal_wasm_bg.wasm ../../app/vendor/libsignal_wasm_bg.wasm
echo "OK: app/vendor/libsignal_wasm_bg.wasm ($(wc -c < pkg/libsignal_wasm_bg.wasm | tr -d ' ') bytes)"
