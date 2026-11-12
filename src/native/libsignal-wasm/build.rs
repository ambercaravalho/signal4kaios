// BoringSSL (linked by boring-sys for attest) is built against wasi-libc and libc++; wasi-deps.sh sets WASI_SYSROOT.
fn main() {
    println!("cargo:rerun-if-env-changed=WASI_SYSROOT");
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() != Ok("wasm32") {
        return;
    }
    let sysroot = std::env::var("WASI_SYSROOT").expect("WASI_SYSROOT is unset; build with build.sh");
    let lib = format!("{sysroot}/lib/wasm32-wasip1");
    // libc++ without exceptions lives in noeh/, matching BoringSSL's -fno-exceptions.
    println!("cargo:rustc-link-search=native={lib}/noeh");
    println!("cargo:rustc-link-search=native={lib}");
    for name in ["c++", "c++abi", "c"] {
        println!("cargo:rustc-link-lib=static={name}");
    }
}
