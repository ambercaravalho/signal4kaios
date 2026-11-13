// BoringSSL (linked by boring-sys for attest) and libopus (src/calling.rs) are built against wasi-libc and libc++; wasi-deps.sh sets WASI_SYSROOT and OPUS_LIB_DIR.
fn main() {
    println!("cargo:rerun-if-env-changed=WASI_SYSROOT");
    println!("cargo:rerun-if-env-changed=OPUS_LIB_DIR");
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        return;
    }
    let opus = std::env::var("OPUS_LIB_DIR").expect("OPUS_LIB_DIR is unset; build with build.sh");
    println!("cargo:rustc-link-search=native={opus}");
    println!("cargo:rustc-link-lib=static=opus");
    let sysroot = std::env::var("WASI_SYSROOT").expect("WASI_SYSROOT is unset; build with build.sh");
    let lib = format!("{sysroot}/lib/wasm32-wasip1");
    // libc++ without exceptions lives in noeh/, matching BoringSSL's -fno-exceptions.
    println!("cargo:rustc-link-search=native={lib}/noeh");
    println!("cargo:rustc-link-search=native={lib}");
    for name in ["c++", "c++abi", "c", "m"] {
        println!("cargo:rustc-link-lib=static={name}");
    }
}
