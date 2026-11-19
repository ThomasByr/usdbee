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

fn main() {
    println!("cargo:rerun-if-changed=Cargo.lock");
    println!("cargo:rerun-if-changed=../node_modules/three/package.json");

    let lock = std::fs::read_to_string("Cargo.lock")
        .ok()
        .and_then(|text| text.parse::<toml::Value>().ok());
    let three_version = std::fs::read_to_string("../node_modules/three/package.json")
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
    emit("APP_PROFILE", std::env::var("PROFILE").ok());
    emit("APP_OPT_LEVEL", std::env::var("OPT_LEVEL").ok());

    tauri_build::build()
}
