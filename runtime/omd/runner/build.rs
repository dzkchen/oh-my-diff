fn main() {
    // Exporting V8's weak C++ symbols makes dyld bind them on every runner start.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rustc-link-arg-bins=-Wl,-exported_symbol,__mh_execute_header");
    }
}
