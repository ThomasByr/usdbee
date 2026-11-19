use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, System};

#[derive(serde::Serialize)]
pub struct BuildInfo {
    pub version: String,
    pub tauri: String,
    pub openusd: String,
    pub three_js: String,
    pub profile: String,
    pub opt_level: String,
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

fn binary_bytes() -> u64 {
    std::env::current_exe()
        .ok()
        .and_then(|path| std::fs::metadata(path).ok())
        .map(|meta| meta.len())
        .unwrap_or(0)
}

fn memory_bytes() -> (u64, u64) {
    let Ok(mut sys) = System::new() else {
        return (0, 0);
    };
    sys.refresh_memory();
    let total_ram_bytes = sys.total_memory();
    let resident_bytes = sysinfo::get_current_pid()
        .ok()
        .and_then(|pid| {
            sys.refresh_processes_specifics(
                ProcessesToUpdate::Some(&[pid]),
                true,
                ProcessRefreshKind::nothing().with_memory(),
            );
            sys.process(pid).map(|p| p.memory())
        })
        .unwrap_or(0);
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
        profile: env!("APP_PROFILE").to_string(),
        opt_level: env!("APP_OPT_LEVEL").to_string(),
        debug_assertions: cfg!(debug_assertions),
        binary: format_bytes(binary_bytes()),
        resident: format_bytes(resident_bytes),
        total_ram: format_bytes(total_ram_bytes),
    })
}

#[cfg(test)]
mod tests {
    use super::format_bytes;

    #[test]
    fn formats_mebibytes_with_one_decimal() {
        assert_eq!(format_bytes(1_500_000), "1.4 MiB");
        assert_eq!(format_bytes(2_097_152), "2.0 MiB");
    }

    #[test]
    fn formats_kibibytes_below_one_mebibyte() {
        assert_eq!(format_bytes(2_048), "2.0 KiB");
    }

    #[test]
    fn build_constants_are_populated() {
        assert!(!env!("APP_TAURI_VERSION").is_empty());
        assert!(!env!("APP_OPT_LEVEL").is_empty());
    }
}
