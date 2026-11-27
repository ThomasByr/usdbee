// Decides whether usdbee must turn WebKitGTK's DMABUF renderer off before the
// web process starts. The decision is pure so it can be tested without a GPU,
// a display, or a WebKit process.

use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CompatMode {
    #[default]
    Auto,
    On,
    Off,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct EnvFacts {
    pub debian_family: bool,
    pub distro_label: Option<String>,
    pub x11: bool,
    pub nvidia_version: Option<String>,
    pub webkit_major: u32,
    pub webkit_minor: u32,
    pub webkit_micro: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub struct CompatReport {
    pub mode: CompatMode,
    pub applied: bool,
    pub forced: bool,
    pub reason: String,
    pub distro_label: Option<String>,
    pub nvidia_version: Option<String>,
    pub webkit_version: String,
    pub x11: bool,
    pub debian_family: bool,
}

#[derive(Debug, Default, Serialize, Deserialize)]
pub struct CompatPrefs {
    #[serde(default)]
    pub mode: CompatMode,
}

// WebKitGTK 2.52 is the version known to leak GPU fences with the Debian
// packaging patch; other versions are left alone.
const AFFECTED_WEBKIT: (u32, u32) = (2, 52);

const ENV_VAR: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
const CONFIG_DIR: &str = "com.tbyr.usdbee";
const PREFS_FILE: &str = "webkit_compat.json";

// The report of the process that is already running. The variable is read by
// the web process at spawn time, so a later change cannot reach it.
static REPORT: OnceLock<CompatReport> = OnceLock::new();

// The first unmet condition is the one the UI shows, so the order is stable.
fn first_unmet(facts: &EnvFacts) -> Option<String> {
    if !facts.debian_family {
        return Some("not a Debian-family system".to_string());
    }
    if !facts.x11 {
        return Some("Wayland session".to_string());
    }
    if facts.nvidia_version.is_none() {
        return Some("no proprietary NVIDIA driver".to_string());
    }
    if (facts.webkit_major, facts.webkit_minor) != AFFECTED_WEBKIT {
        return Some(format!(
            "WebKitGTK {}.{}",
            facts.webkit_major, facts.webkit_minor
        ));
    }
    None
}

fn auto_off_reason(facts: &EnvFacts) -> String {
    let distro = match &facts.distro_label {
        Some(label) => format!(" ({label})"),
        None => String::new(),
    };
    format!(
        "Hardware compositing is off: WebKitGTK {}.{} on NVIDIA {}{distro} leaks GPU fences while scrolling.",
        facts.webkit_major,
        facts.webkit_minor,
        facts.nvidia_version.as_deref().unwrap_or("unknown"),
    )
}

pub fn decide(facts: &EnvFacts, mode: CompatMode) -> (bool, String) {
    match mode {
        CompatMode::On => (
            false,
            "Hardware compositing is on: forced by your setting.".to_string(),
        ),
        CompatMode::Off => (
            true,
            "Hardware compositing is off: forced by your setting.".to_string(),
        ),
        CompatMode::Auto => match first_unmet(facts) {
            Some(unmet) => (false, format!("Hardware compositing is on: {unmet}.")),
            None => (true, auto_off_reason(facts)),
        },
    }
}

pub fn report_from(facts: &EnvFacts, mode: CompatMode) -> CompatReport {
    let (applied, reason) = decide(facts, mode);
    CompatReport {
        mode,
        applied,
        forced: mode != CompatMode::Auto,
        reason,
        distro_label: facts.distro_label.clone(),
        nvidia_version: facts.nvidia_version.clone(),
        webkit_version: format!(
            "{}.{}.{}",
            facts.webkit_major, facts.webkit_minor, facts.webkit_micro
        ),
        x11: facts.x11,
        debian_family: facts.debian_family,
    }
}

pub fn read_prefs(path: &Path) -> CompatPrefs {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

pub fn write_prefs(path: &Path, prefs: &CompatPrefs) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|e| format!("Failed to create {}: {e}", parent.display()))?;
    }
    let json = serde_json::to_string_pretty(prefs)
        .map_err(|e| format!("Failed to encode the WebKit compatibility preferences: {e}"))?;
    std::fs::write(path, json).map_err(|e| format!("Failed to write {}: {e}", path.display()))
}

fn nvidia_version_from(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|token| token.starts_with(|c: char| c.is_ascii_digit()) && token.contains('.'))
        .map(str::to_string)
}

fn pretty_name_from(os_release: &str) -> Option<String> {
    for line in os_release.lines() {
        if let Some(value) = line.strip_prefix("PRETTY_NAME=") {
            let value = value.trim().trim_matches('"');
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn x11_session(session_type: Option<&str>, wayland_display: Option<&str>) -> bool {
    let not_wayland = !session_type
        .map(|value| value.trim().eq_ignore_ascii_case("wayland"))
        .unwrap_or(false);
    let no_wayland_display = wayland_display.map(str::is_empty).unwrap_or(true);
    not_wayland && no_wayland_display
}

pub fn probe() -> EnvFacts {
    EnvFacts {
        debian_family: Path::new("/etc/debian_version").exists(),
        distro_label: std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|raw| pretty_name_from(&raw)),
        x11: x11_session(
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
            std::env::var("WAYLAND_DISPLAY").ok().as_deref(),
        ),
        nvidia_version: std::fs::read_to_string("/proc/driver/nvidia/version")
            .ok()
            .and_then(|raw| raw.lines().next().and_then(nvidia_version_from)),
        // Version getters only read a constant built into the library, so no
        // GTK or WebKit initialisation is needed before the app starts.
        webkit_major: unsafe { webkit2gtk::ffi::webkit_get_major_version() },
        webkit_minor: unsafe { webkit2gtk::ffi::webkit_get_minor_version() },
        webkit_micro: unsafe { webkit2gtk::ffi::webkit_get_micro_version() },
    }
}

pub fn apply(disable: bool) {
    if disable {
        std::env::set_var(ENV_VAR, "1");
    } else {
        std::env::remove_var(ENV_VAR);
    }
}

pub fn config_dir_from(xdg_config_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let base = match xdg_config_home.filter(|value| !value.is_empty()) {
        Some(xdg) => PathBuf::from(xdg),
        None => Path::new(home.filter(|value| !value.is_empty())?).join(".config"),
    };
    Some(base.join(CONFIG_DIR))
}

fn store(report: CompatReport) -> CompatReport {
    let _ = REPORT.set(report.clone());
    report
}

pub fn init_with(facts: &EnvFacts, prefs_path: &Path) -> CompatReport {
    let report = report_from(facts, read_prefs(prefs_path).mode);
    apply(report.applied);
    store(report)
}

pub fn init() -> CompatReport {
    let facts = probe();
    let report = match config_dir_from(
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    ) {
        Some(dir) => init_with(&facts, &dir.join(PREFS_FILE)),
        None => store(report_from(&facts, CompatMode::Auto)),
    };
    println!(
        "usdbee: hardware compositing {} ({})",
        if report.applied { "off" } else { "on" },
        report.reason
    );
    report
}

pub fn current() -> CompatReport {
    REPORT
        .get()
        .cloned()
        .unwrap_or_else(|| report_from(&probe(), CompatMode::Auto))
}

#[tauri::command]
pub fn compat_status() -> CompatReport {
    current()
}

// Only writes the file: the running web process already read the variable.
#[tauri::command]
pub fn set_compat_pref(mode: CompatMode) -> Result<(), String> {
    let dir = config_dir_from(
        std::env::var("XDG_CONFIG_HOME").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    )
    .ok_or_else(|| "cannot resolve the config directory".to_string())?;
    write_prefs(&dir.join(PREFS_FILE), &CompatPrefs { mode })
}

#[cfg(test)]
mod tests {
    use super::*;

    // The probe, the applied variable and `set_compat_pref` all read or write
    // process-wide state, so every test touching them takes this lock.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn env_guard() -> std::sync::MutexGuard<'static, ()> {
        ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn facts_ubuntu_x11_nvidia_252() -> EnvFacts {
        EnvFacts {
            debian_family: true,
            distro_label: Some("Ubuntu 24.04".into()),
            x11: true,
            nvidia_version: Some("580.178.04".into()),
            webkit_major: 2,
            webkit_minor: 52,
            webkit_micro: 6,
        }
    }

    fn clean_facts() -> EnvFacts {
        EnvFacts {
            debian_family: true,
            distro_label: Some("Fedora 41".into()),
            x11: false,
            nvidia_version: None,
            webkit_major: 2,
            webkit_minor: 54,
            webkit_micro: 0,
        }
    }

    #[test]
    fn auto_disables_on_debian_x11_nvidia_webkit_252() {
        let (disable, reason) = decide(&facts_ubuntu_x11_nvidia_252(), CompatMode::Auto);
        assert!(disable);
        assert!(reason.contains("2.52"), "reason: {reason}");
        assert!(reason.contains("580.178.04"), "reason: {reason}");
    }

    #[test]
    fn auto_keeps_on_wayland() {
        let mut facts = facts_ubuntu_x11_nvidia_252();
        facts.x11 = false;
        let (disable, reason) = decide(&facts, CompatMode::Auto);
        assert!(!disable);
        assert!(reason.contains("Wayland"), "reason: {reason}");
    }

    #[test]
    fn auto_keeps_without_nvidia() {
        let mut facts = facts_ubuntu_x11_nvidia_252();
        facts.nvidia_version = None;
        let (disable, reason) = decide(&facts, CompatMode::Auto);
        assert!(!disable);
        assert!(reason.contains("NVIDIA"), "reason: {reason}");
    }

    #[test]
    fn auto_keeps_on_non_debian_family() {
        let mut facts = facts_ubuntu_x11_nvidia_252();
        facts.debian_family = false;
        facts.distro_label = Some("Fedora 41".into());
        let (disable, reason) = decide(&facts, CompatMode::Auto);
        assert!(!disable);
        assert!(reason.contains("Debian"), "reason: {reason}");
    }

    #[test]
    fn auto_keeps_on_webkit_254() {
        let mut facts = facts_ubuntu_x11_nvidia_252();
        facts.webkit_minor = 54;
        let (disable, reason) = decide(&facts, CompatMode::Auto);
        assert!(!disable);
        assert!(reason.contains("2.54"), "reason: {reason}");
        assert!(!reason.contains("2.52"), "reason: {reason}");
    }

    #[test]
    fn auto_disables_on_mint_label() {
        // The gate never reads ID/ID_LIKE: Debian family comes from
        // /etc/debian_version alone, so a Mint whose os-release says ID=ubuntu
        // is still covered.
        let mut facts = facts_ubuntu_x11_nvidia_252();
        facts.distro_label = Some("Linux Mint 22.3".into());
        let (disable, reason) = decide(&facts, CompatMode::Auto);
        assert!(disable);
        assert!(reason.contains("Linux Mint 22.3"), "reason: {reason}");
    }

    #[test]
    fn force_on_overrides_the_gate() {
        assert!(decide(&facts_ubuntu_x11_nvidia_252(), CompatMode::Auto).0);
        let (disable, reason) = decide(&facts_ubuntu_x11_nvidia_252(), CompatMode::On);
        assert!(!disable);
        assert!(reason.contains("setting"), "reason: {reason}");
        let report = report_from(&facts_ubuntu_x11_nvidia_252(), CompatMode::On);
        assert!(report.forced);
        assert!(!report.applied);
    }

    #[test]
    fn force_off_disables_anywhere() {
        let (disable, reason) = decide(&clean_facts(), CompatMode::Off);
        assert!(disable);
        assert!(reason.contains("setting"), "reason: {reason}");
        let report = report_from(&clean_facts(), CompatMode::Off);
        assert!(report.forced);
        assert!(report.applied);
    }

    #[test]
    fn report_mirrors_the_decision() {
        let facts = facts_ubuntu_x11_nvidia_252();
        let (disable, reason) = decide(&facts, CompatMode::Auto);
        let report = report_from(&facts, CompatMode::Auto);

        assert_eq!(report.applied, disable);
        assert_eq!(report.reason, reason);
        assert_eq!(report.webkit_version, "2.52.6");
        assert_eq!(report.mode, CompatMode::Auto);
        assert!(!report.forced);
        assert_eq!(report.nvidia_version.as_deref(), Some("580.178.04"));
        assert_eq!(report.distro_label.as_deref(), Some("Ubuntu 24.04"));
        assert!(report.x11);
        assert!(report.debian_family);
    }

    #[test]
    fn round_trips_the_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("webkit_compat.json");

        write_prefs(
            &path,
            &CompatPrefs {
                mode: CompatMode::Off,
            },
        )
        .unwrap();

        assert_eq!(read_prefs(&path).mode, CompatMode::Off);
    }

    #[test]
    fn missing_file_means_auto() {
        let dir = tempfile::tempdir().unwrap();

        assert_eq!(
            read_prefs(&dir.path().join("webkit_compat.json")).mode,
            CompatMode::Auto
        );
    }

    #[test]
    fn corrupt_file_means_auto() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("webkit_compat.json");
        std::fs::write(&path, "not json").unwrap();

        assert_eq!(read_prefs(&path).mode, CompatMode::Auto);
    }

    #[test]
    fn writes_the_mode_as_lowercase_json() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("webkit_compat.json");

        write_prefs(
            &path,
            &CompatPrefs {
                mode: CompatMode::Off,
            },
        )
        .unwrap();

        let raw = std::fs::read_to_string(&path).unwrap();
        assert!(raw.contains("\"mode\": \"off\""), "raw: {raw}");
    }

    #[test]
    fn reads_a_lowercase_literal() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("webkit_compat.json");
        std::fs::write(&path, r#"{"mode":"on"}"#).unwrap();

        assert_eq!(read_prefs(&path).mode, CompatMode::On);
    }

    #[test]
    fn unknown_mode_means_auto() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("webkit_compat.json");
        std::fs::write(&path, r#"{"mode":"maybe"}"#).unwrap();

        assert_eq!(read_prefs(&path).mode, CompatMode::Auto);
    }

    #[test]
    fn auto_off_reason_is_one_exact_sentence() {
        let (_, reason) = decide(&facts_ubuntu_x11_nvidia_252(), CompatMode::Auto);
        assert_eq!(
            reason,
            "Hardware compositing is off: WebKitGTK 2.52 on NVIDIA 580.178.04 (Ubuntu 24.04) leaks GPU fences while scrolling."
        );

        let mut facts = facts_ubuntu_x11_nvidia_252();
        facts.distro_label = None;
        let (_, reason) = decide(&facts, CompatMode::Auto);
        assert_eq!(
            reason,
            "Hardware compositing is off: WebKitGTK 2.52 on NVIDIA 580.178.04 leaks GPU fences while scrolling."
        );
    }

    #[test]
    fn config_dir_prefers_xdg() {
        assert_eq!(
            config_dir_from(Some("/x"), Some("/h")).unwrap(),
            PathBuf::from("/x/com.tbyr.usdbee")
        );
    }

    #[test]
    fn config_dir_falls_back_to_home() {
        assert_eq!(
            config_dir_from(None, Some("/h")).unwrap(),
            PathBuf::from("/h/.config/com.tbyr.usdbee")
        );
    }

    #[test]
    fn config_dir_without_either_is_none() {
        assert!(config_dir_from(None, None).is_none());
    }

    #[test]
    fn reads_the_nvidia_version_token() {
        let line = "NVRM version: NVIDIA UNIX x86_64 Kernel Module  580.178.04  Fri Nov  7 01:24:17 UTC 2025";
        assert_eq!(nvidia_version_from(line), Some("580.178.04".to_string()));
        assert_eq!(nvidia_version_from("NVRM version: unknown"), None);
    }

    #[test]
    fn reads_pretty_name_without_quotes() {
        let os_release = "NAME=\"Ubuntu\"\nPRETTY_NAME=\"Ubuntu 24.04.3 LTS\"\nID=ubuntu\n";
        assert_eq!(
            pretty_name_from(os_release).as_deref(),
            Some("Ubuntu 24.04.3 LTS")
        );
        assert!(pretty_name_from("NAME=\"Ubuntu\"\n").is_none());
    }

    #[test]
    fn init_applies_the_variable_when_the_gate_fires() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var(ENV_VAR, "0");

        let report = init_with(&facts_ubuntu_x11_nvidia_252(), &dir.path().join(PREFS_FILE));

        assert!(report.applied);
        assert_eq!(std::env::var(ENV_VAR).as_deref(), Ok("1"));
        std::env::remove_var(ENV_VAR);
    }

    #[test]
    fn init_leaves_the_variable_unset_when_forced_on() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(PREFS_FILE);
        std::fs::write(&path, r#"{"mode":"on"}"#).unwrap();
        std::env::set_var(ENV_VAR, "1");

        let report = init_with(&facts_ubuntu_x11_nvidia_252(), &path);

        assert!(!report.applied);
        assert_eq!(report.mode, CompatMode::On);
        assert!(std::env::var_os(ENV_VAR).is_none());
    }

    #[test]
    fn init_writes_through_set_compat_pref() {
        let _guard = env_guard();
        let dir = tempfile::tempdir().unwrap();
        std::env::set_var("XDG_CONFIG_HOME", dir.path());

        let written = set_compat_pref(CompatMode::Off);

        std::env::remove_var("XDG_CONFIG_HOME");
        written.unwrap();
        let raw = std::fs::read_to_string(dir.path().join(CONFIG_DIR).join(PREFS_FILE)).unwrap();
        assert!(raw.contains("\"mode\": \"off\""), "raw: {raw}");
    }
}
