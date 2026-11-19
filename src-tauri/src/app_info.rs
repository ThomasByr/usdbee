use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(serde::Serialize)]
pub struct BuildInfo {
    pub version: String,
    pub tauri: String,
    pub openusd: String,
    pub three_js: String,
    pub svelte: String,
    pub profile: String,
    pub opt_level: String,
    // Empty when dependencies share the app's opt-level.
    pub deps_opt_level: String,
    pub debug_assertions: bool,
    pub binary: String,
    pub resident: String,
    pub total_ram: String,
}

const KIB: u64 = 1024;
const MIB: u64 = KIB * 1024;
const GIB: u64 = MIB * 1024;

pub fn format_bytes(bytes: u64) -> String {
    let (value, unit) = if bytes >= GIB {
        (bytes as f64 / GIB as f64, "GiB")
    } else if bytes >= MIB {
        (bytes as f64 / MIB as f64, "MiB")
    } else {
        (bytes as f64 / KIB as f64, "KiB")
    };
    format!("{value:.1} {unit}")
}

// A failed or zero-size probe prints as "unknown": a formatted zero would look
// like a real reading.
fn size_or_unknown(bytes: Option<u64>) -> String {
    match bytes {
        Some(bytes) if bytes > 0 => format_bytes(bytes),
        _ => "unknown".to_string(),
    }
}

fn binary_bytes() -> u64 {
    std::env::current_exe()
        .ok()
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .unwrap_or(0)
}

fn memory_bytes() -> (Option<u64>, Option<u64>) {
    let Ok(mut sys) = System::new() else {
        return (None, None);
    };
    sys.refresh_memory();
    let total_ram_bytes = Some(sys.total_memory());
    let resident_bytes = sysinfo::get_current_pid().ok().and_then(|pid| {
        sys.refresh_processes_specifics(
            ProcessesToUpdate::Some(&[pid]),
            true,
            ProcessRefreshKind::nothing().with_memory(),
        );
        sys.process(pid).map(|p| p.memory())
    });
    (resident_bytes, total_ram_bytes)
}

#[tauri::command]
pub fn app_build_info() -> Result<BuildInfo, String> {
    let (resident_bytes, total_ram_bytes) = memory_bytes();
    Ok(BuildInfo {
        version: env!("CARGO_PKG_VERSION").to_string(),
        tauri: env!("APP_TAURI_VERSION").to_string(),
        openusd: env!("APP_OPENUSD_VERSION").to_string(),
        three_js: env!("APP_THREE_VERSION").to_string(),
        svelte: env!("APP_SVELTE_VERSION").to_string(),
        profile: env!("APP_PROFILE").to_string(),
        opt_level: env!("APP_OPT_LEVEL").to_string(),
        deps_opt_level: env!("APP_DEPS_OPT_LEVEL").to_string(),
        debug_assertions: cfg!(debug_assertions),
        binary: size_or_unknown(Some(binary_bytes())),
        resident: size_or_unknown(resident_bytes),
        total_ram: size_or_unknown(total_ram_bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::{format_bytes, size_or_unknown};

    #[test]
    fn formats_mebibytes_with_one_decimal() {
        assert_eq!(format_bytes(1_500_000), "1.4 MiB");
        assert_eq!(format_bytes(2_097_152), "2.0 MiB");
    }

    #[test]
    fn formats_kibibytes_below_one_mebibyte() {
        assert_eq!(format_bytes(2_048), "2.0 KiB");
        assert_eq!(format_bytes(0), "0.0 KiB");
    }

    #[test]
    fn formats_gibibytes_above_one_gibibyte() {
        assert_eq!(format_bytes(1_610_612_736), "1.5 GiB");
    }

    #[test]
    fn failed_probes_print_unknown() {
        assert_eq!(size_or_unknown(None), "unknown");
        assert_eq!(size_or_unknown(Some(0)), "unknown");
        assert_eq!(size_or_unknown(Some(2_048)), "2.0 KiB");
    }

    #[test]
    fn build_constants_are_populated() {
        let constants = [
            ("APP_TAURI_VERSION", env!("APP_TAURI_VERSION")),
            ("APP_OPENUSD_VERSION", env!("APP_OPENUSD_VERSION")),
            ("APP_THREE_VERSION", env!("APP_THREE_VERSION")),
            ("APP_SVELTE_VERSION", env!("APP_SVELTE_VERSION")),
            ("APP_PROFILE", env!("APP_PROFILE")),
            ("APP_OPT_LEVEL", env!("APP_OPT_LEVEL")),
        ];
        for (name, value) in constants {
            assert_ne!(value, "unknown", "{name} fell back to the placeholder");
        }

        let lock_text = std::fs::read_to_string(concat!(env!("CARGO_MANIFEST_DIR"), "/Cargo.lock"))
            .expect("read Cargo.lock");
        let lock: toml::Value = lock_text.parse().expect("parse Cargo.lock");
        let locked = lock["package"]
            .as_array()
            .expect("Cargo.lock has packages")
            .iter()
            .find(|pkg| pkg["name"].as_str() == Some("tauri"))
            .and_then(|pkg| pkg["version"].as_str())
            .expect("Cargo.lock pins tauri");
        assert_eq!(env!("APP_TAURI_VERSION"), locked);
    }
}
