# Sourced by build.sh. libsignal's attest crate (contact discovery) verifies the enclave with BoringSSL, which is C and C++ that needs a libc, so it is compiled with wasi-sdk and linked against wasi-libc and libc++ (see build.rs and docs/development.md "Contact discovery build"). The call audio codec, libopus, is C built the same way.
#
# Every download is pinned by SHA-256. WASI_SDK_PATH overrides the wasi-sdk download.

WASI_SDK_VERSION=34.0
LIBC_VERSION=0.2.186
LIBC_SHA256=68ab91017fe16c622486840e4c83c9a37afeff978bd239b5293d61ece587de66
OPUS_VERSION=1.5.2
OPUS_SHA256=65c1d2f78b9f2fb20082c38cbe47c951ad5839345876e46941612ee87f9a7ce1

sha256_of() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

# fetch URL DEST SHA256
fetch() {
  curl -fsSL --retry 3 -o "$2.part" "$1"
  if [ "$(sha256_of "$2.part")" != "$3" ]; then
    rm -f "$2.part"
    echo "FAIL: checksum mismatch for $1" >&2
    exit 1
  fi
  mv "$2.part" "$2"
}

for tool in cmake curl; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "FAIL: $tool not found. Install it (macOS: brew install $tool; Debian/Ubuntu: apt install $tool)." >&2
    exit 1
  fi
done
mkdir -p target vendor

if [ -z "${WASI_SDK_PATH:-}" ]; then
  case "$(uname -s)-$(uname -m)" in
    Darwin-arm64) WASI_SDK_PLATFORM=arm64-macos WASI_SDK_SHA256=9c59398106b417f8f14913380fdf0097a8cc0ff4af9eb3ce0065a859e88d49e9 ;;
    Darwin-x86_64) WASI_SDK_PLATFORM=x86_64-macos WASI_SDK_SHA256=87d27fa8adc68dee59bfbf2e22a6d34ef717c34d6bf1d8af2a56fc929d9ce0eb ;;
    Linux-x86_64) WASI_SDK_PLATFORM=x86_64-linux WASI_SDK_SHA256=b761e3a0721dbae9c09a0059e5fdb2bf917d1b4a8a7b430fb3b5aafb0984b2c4 ;;
    Linux-aarch64) WASI_SDK_PLATFORM=arm64-linux WASI_SDK_SHA256=f7e243dff54d60bcc576e94d6166b69f410f2500ae4a9ceef34315be10e77971 ;;
    *) echo "FAIL: no wasi-sdk $WASI_SDK_VERSION build for $(uname -s)-$(uname -m); install one and set WASI_SDK_PATH." >&2; exit 1 ;;
  esac
  WASI_SDK_PATH=$PWD/target/wasi-sdk-$WASI_SDK_VERSION-$WASI_SDK_PLATFORM
  if [ ! -x "$WASI_SDK_PATH/bin/clang" ]; then
    echo "Downloading wasi-sdk $WASI_SDK_VERSION ($WASI_SDK_PLATFORM)"
    fetch "https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-${WASI_SDK_VERSION%%.*}/wasi-sdk-$WASI_SDK_VERSION-$WASI_SDK_PLATFORM.tar.gz" target/wasi-sdk.tar.gz "$WASI_SDK_SHA256"
    tar -xzf target/wasi-sdk.tar.gz -C target
    rm target/wasi-sdk.tar.gz
  fi
fi
WASI_SYSROOT=$WASI_SDK_PATH/share/wasi-sysroot
export WASI_SYSROOT

# libc defines no C types for wasm32-unknown-unknown; its WASI definitions match the wasi-libc that BoringSSL is built against.
if [ "$(cat vendor/libc/.beacon-patch 2>/dev/null)" != "$LIBC_VERSION" ]; then
  rm -rf vendor/libc "vendor/libc-$LIBC_VERSION"
  LIBC_CRATE=$(ls "${CARGO_HOME:-$HOME/.cargo}"/registry/cache/*/"libc-$LIBC_VERSION.crate" 2>/dev/null | head -n 1 || true)
  if [ -z "$LIBC_CRATE" ] || [ "$(sha256_of "$LIBC_CRATE")" != "$LIBC_SHA256" ]; then
    fetch "https://static.crates.io/crates/libc/libc-$LIBC_VERSION.crate" target/libc.crate "$LIBC_SHA256"
    LIBC_CRATE=target/libc.crate
  fi
  tar -xzf "$LIBC_CRATE" -C vendor
  mv "vendor/libc-$LIBC_VERSION" vendor/libc
  perl -0pi -e 's/\Q} else if #[cfg(any(target_env = "wasi", target_os = "wasi"))] {\E/} else if #[cfg(any(target_env = "wasi", target_os = "wasi", all(target_arch = "wasm32", target_os = "unknown")))] {/ or die "FAIL: vendor/libc has no WASI branch to extend\n"' vendor/libc/src/lib.rs
  echo "$LIBC_VERSION" > vendor/libc/.beacon-patch
fi

BSSL_SRC=$(cargo metadata --locked --format-version 1 | node -e '
  let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
    const pkg = JSON.parse(s).packages.find((p) => p.name === "boring-sys");
    if (!pkg) process.exit(1);
    console.log(require("path").join(require("path").dirname(pkg.manifest_path), "deps", "boringssl"));
  });') || { echo "FAIL: could not locate boring-sys's BoringSSL sources via cargo metadata" >&2; exit 1; }
BSSL_OUT=$PWD/target/boringssl-wasi
BSSL_STAMP="$BSSL_SRC wasi-sdk-$WASI_SDK_VERSION"
if [ "$(cat "$BSSL_OUT/.beacon-stamp" 2>/dev/null)" != "$BSSL_STAMP" ] || [ ! -f "$BSSL_OUT/libcrypto.a" ]; then
  echo "Building BoringSSL for WASI"
  rm -rf "$BSSL_OUT"
  # wasi-libc has no threads; CMAKE_HAVE_LIBC_PTHREAD satisfies BoringSSL's find_package(Threads) without linking anything.
  BSSL_DEFINES="-DOPENSSL_NO_SOCK -DOPENSSL_NO_THREADS_CORRUPT_MEMORY_AND_LEAK_SECRETS_IF_THREADED -D_WASI_EMULATED_SIGNAL"
  if command -v ninja >/dev/null 2>&1; then BSSL_GENERATOR=Ninja; else BSSL_GENERATOR="Unix Makefiles"; fi
  cmake -S "$BSSL_SRC" -B "$BSSL_OUT" -G "$BSSL_GENERATOR" \
    -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK_PATH/share/cmake/wasi-sdk-p1.cmake" -DWASI_SDK_PREFIX="$WASI_SDK_PATH" \
    -DCMAKE_BUILD_TYPE=MinSizeRel -DOPENSSL_NO_ASM=1 -DBUILD_TESTING=OFF -DCMAKE_HAVE_LIBC_PTHREAD=ON \
    -DCMAKE_C_FLAGS="$BSSL_DEFINES -D_WASI_EMULATED_PROCESS_CLOCKS -D_WASI_EMULATED_MMAN" \
    -DCMAKE_CXX_FLAGS="$BSSL_DEFINES -fno-exceptions" >/dev/null
  cmake --build "$BSSL_OUT" --target crypto ssl --parallel >/dev/null
  echo "$BSSL_STAMP" > "$BSSL_OUT/.beacon-stamp"
fi

OPUS_SRC=$PWD/target/opus-$OPUS_VERSION
OPUS_OUT=$PWD/target/opus-wasi
OPUS_STAMP="opus-$OPUS_VERSION wasi-sdk-$WASI_SDK_VERSION"
if [ "$(cat "$OPUS_OUT/.beacon-stamp" 2>/dev/null)" != "$OPUS_STAMP" ] || [ ! -f "$OPUS_OUT/libopus.a" ]; then
  echo "Building libopus $OPUS_VERSION for WASI"
  rm -rf "$OPUS_SRC" "$OPUS_OUT"
  fetch "https://downloads.xiph.org/releases/opus/opus-$OPUS_VERSION.tar.gz" target/opus.tar.gz "$OPUS_SHA256"
  tar -xzf target/opus.tar.gz -C target
  rm target/opus.tar.gz
  if command -v ninja >/dev/null 2>&1; then OPUS_GENERATOR=Ninja; else OPUS_GENERATOR="Unix Makefiles"; fi
  # Release rather than MinSizeRel: encoding and decoding run 17 times a second for the whole call, on a phone without wasm SIMD.
  cmake -S "$OPUS_SRC" -B "$OPUS_OUT" -G "$OPUS_GENERATOR" \
    -DCMAKE_TOOLCHAIN_FILE="$WASI_SDK_PATH/share/cmake/wasi-sdk-p1.cmake" -DWASI_SDK_PREFIX="$WASI_SDK_PATH" \
    -DCMAKE_BUILD_TYPE=Release -DOPUS_BUILD_TESTING=OFF -DOPUS_BUILD_PROGRAMS=OFF -DOPUS_DISABLE_INTRINSICS=ON \
    -DOPUS_STACK_PROTECTOR=OFF -DOPUS_FORTIFY_SOURCE=OFF -DOPUS_INSTALL_PKG_CONFIG_MODULE=OFF -DOPUS_INSTALL_CMAKE_CONFIG_MODULE=OFF >/dev/null
  cmake --build "$OPUS_OUT" --target opus --parallel >/dev/null
  echo "$OPUS_STAMP" > "$OPUS_OUT/.beacon-stamp"
fi
export OPUS_LIB_DIR="$OPUS_OUT"

export BORING_BSSL_PATH="$BSSL_OUT" BORING_BSSL_INCLUDE_PATH="$BSSL_SRC/include"
# bindgen reads BoringSSL's headers as WASI; default visibility keeps its declarations from being filtered out.
export BINDGEN_EXTRA_CLANG_ARGS_wasm32_unknown_unknown="-isystem $WASI_SYSROOT/include/wasm32-wasip1 -D__wasi__ -fvisibility=default"
