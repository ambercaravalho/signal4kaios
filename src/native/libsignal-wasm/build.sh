#!/bin/sh
# Build the libsignal wasm wrapper: cargo (wasm32) -> wasm-bindgen (--target web) -> optional wasm-opt -> src/app/vendor.
#
# Requires the Rust toolchain pinned in rust-toolchain.toml (rustup installs it automatically), protoc (libsignal's build scripts compile .proto files), wasm-bindgen-cli matching the wasm-bindgen version pinned in Cargo.toml, a clang that can target wasm32 plus llvm-ar (ring, used by the pinned TLS client, compiles C), and cmake plus curl for the contact discovery dependencies (wasi-deps.sh).
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

# Apple's clang and ar can't build or archive wasm32 objects, so prefer Homebrew LLVM, then whatever is on PATH.
find_llvm_tool() {
  for dir in /opt/homebrew/opt/llvm/bin /usr/local/opt/llvm/bin; do
    if [ -x "$dir/$1" ]; then echo "$dir/$1"; return; fi
  done
  for name in "$1" $(ls /usr/bin/"$1"-[0-9]* 2>/dev/null | sort -V -r); do
    if command -v "$name" >/dev/null 2>&1; then command -v "$name"; return; fi
  done
}
if [ -z "${CC_wasm32_unknown_unknown:-}" ]; then
  CC_wasm32_unknown_unknown=$(find_llvm_tool clang)
fi
if [ -z "${AR_wasm32_unknown_unknown:-}" ]; then
  AR_wasm32_unknown_unknown=$(find_llvm_tool llvm-ar)
fi
if [ -z "$CC_wasm32_unknown_unknown" ] || ! "$CC_wasm32_unknown_unknown" --print-targets 2>/dev/null | grep -q wasm32; then
  echo "FAIL: no clang that targets wasm32. Install LLVM (macOS: brew install llvm; Debian/Ubuntu: apt install clang llvm)." >&2
  exit 1
fi
if [ -z "$AR_wasm32_unknown_unknown" ]; then
  echo "FAIL: llvm-ar not found. Install LLVM (macOS: brew install llvm; Debian/Ubuntu: apt install llvm)." >&2
  exit 1
fi
export CC_wasm32_unknown_unknown AR_wasm32_unknown_unknown

. ./wasi-deps.sh

cargo build --release --locked
wasm-bindgen --target web --out-dir pkg target/wasm32-unknown-unknown/release/libsignal_wasm.wasm
# wasm-bindgen emits one namespace import and one imports-object key per WASI function; one of each is enough and keeps esbuild from warning about duplicate keys.
perl -0pi -e 'my %seen; s/^import \* as import\d+ from "wasi_snapshot_preview1";?\n/$seen{i}++ ? "" : $&/gme; s/^\s*"wasi_snapshot_preview1": import\d+,\n/$seen{k}++ ? "" : $&/gme' pkg/libsignal_wasm.js
# The glue is ES module syntax; this lets Node's test runner load it directly when needed.
printf '{ "type": "module" }\n' > pkg/package.json

if command -v wasm-opt >/dev/null 2>&1; then
  wasm-opt -Oz --enable-bulk-memory --enable-sign-ext --enable-mutable-globals --enable-nontrapping-float-to-int --enable-reference-types --enable-multivalue pkg/libsignal_wasm_bg.wasm -o pkg/libsignal_wasm_bg.wasm
fi

mkdir -p ../../app/vendor
cp pkg/libsignal_wasm_bg.wasm ../../app/vendor/libsignal_wasm_bg.wasm
echo "OK: src/app/vendor/libsignal_wasm_bg.wasm ($(wc -c < pkg/libsignal_wasm_bg.wasm | tr -d ' ') bytes)"
