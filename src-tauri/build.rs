/// Reads `[package].version` for `name` out of the parsed `Cargo.lock`.
fn lock_version(lock: &toml::Value, name: &str) -> Option<String> {
    lock.get("package")?
        .as_array()?
        .iter()
        .find(|pkg| pkg.get("name").and_then(|n| n.as_str()) == Some(name))?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

fn json_version(text: &str) -> Option<String> {
    serde_json::from_str::<serde_json::Value>(text)
        .ok()?
        .get("version")?
        .as_str()
        .map(str::to_string)
}

/// Reads `[profile.<profile>.package."*"].opt-level` out of the parsed manifest.
/// The compiled artifact does not record the opt-level of dependencies, so the
/// configured override is the only source.
fn deps_opt_level(manifest: &toml::Value, profile: &str) -> Option<String> {
    match manifest
        .get("profile")?
        .get(profile)?
        .get("package")?
        .get("*")?
        .get("opt-level")?
    {
        toml::Value::Integer(level) => Some(level.to_string()),
        toml::Value::String(level) => Some(level.clone()),
        _ => None,
    }
}

fn main() {
    println!("cargo:rerun-if-changed=Cargo.toml");
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=../node_modules/three/package.json");
    println!("cargo:rerun-if-changed=../node_modules/svelte/package.json");

    let lock = std::fs::read_to_string("Cargo.lock")
        .ok()
        .and_then(|text| text.parse::<toml::Value>().ok());
    let three_version = std::fs::read_to_string("../node_modules/three/package.json")
        .ok()
        .and_then(|text| json_version(&text));
    let svelte_version = std::fs::read_to_string("../node_modules/svelte/package.json")
        .ok()
        .and_then(|text| json_version(&text));

    let emit = |key: &str, value: Option<String>| {
        println!(
            "cargo:rustc-env={}={}",
            key,
            value.unwrap_or_else(|| "unknown".to_string())
        );
    };
    emit(
        "APP_TAURI_VERSION",
        lock.as_ref().and_then(|l| lock_version(l, "tauri")),
    );
    emit(
        "APP_OPENUSD_VERSION",
        lock.as_ref().and_then(|l| lock_version(l, "openusd")),
    );
    emit("APP_THREE_VERSION", three_version);
    emit("APP_SVELTE_VERSION", svelte_version);
    emit("APP_PROFILE", std::env::var("PROFILE").ok());
    let opt_level = std::env::var("OPT_LEVEL").ok();
    emit("APP_OPT_LEVEL", opt_level.clone());

    // Cargo names the profile "debug" for the dev profile. Only report the
    // dependency level when it differs, so the common case stays one number.
    let manifest = std::fs::read_to_string("Cargo.toml")
        .ok()
        .and_then(|text| text.parse::<toml::Value>().ok());
    let profile = match std::env::var("PROFILE").as_deref() {
        Ok("release") => "release",
        _ => "dev",
    };
    let deps = manifest
        .as_ref()
        .and_then(|manifest| deps_opt_level(manifest, profile))
        .filter(|deps| Some(deps) != opt_level.as_ref())
        .unwrap_or_default();
    println!("cargo:rustc-env=APP_DEPS_OPT_LEVEL={deps}");

    // tauri-build embeds its Common-Controls v6 manifest into binaries only, so
    // a test binary that links tauri imports `TaskDialogIndirect` from the
    // System32 comctl32 5.82 and dies at load with STATUS_ENTRYPOINT_NOT_FOUND
    // (tauri#13419). Ask the linker for the same dependency here, which covers
    // every target including the lib unit-test binary. Drop this once
    // tauri-build links the manifest into all targets (tauri#16320).
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        println!(
            "cargo:rustc-link-arg=/MANIFESTDEPENDENCY:type='win32' name='Microsoft.Windows.Common-Controls' version='6.0.0.0' processorArchitecture='*' publicKeyToken='6595b64144ccf1df' language='*'"
        );
    }

    tauri_build::build()
}
