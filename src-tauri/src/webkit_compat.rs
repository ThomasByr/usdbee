// Decides whether usdbee must turn WebKitGTK's DMABUF renderer off before the
// web process starts. The decision is pure so it can be tested without a GPU,
// a display, or a WebKit process.

use std::ffi::OsStr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
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
    pub nvidia_present: bool,
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

// True while the variable holds a value this process set. A value inherited
// from the user's shell is theirs, so `apply(false)` must not remove it.
static APPLIED: AtomicBool = AtomicBool::new(false);

// The first unmet condition is the one the UI shows, so the order is stable.
fn first_unmet(facts: &EnvFacts) -> Option<String> {
    if !facts.debian_family {
        return Some("not a Debian-family system".to_string());
    }
    if !facts.x11 {
        return Some("Wayland session".to_string());
    }
    if !facts.nvidia_present {
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
    // The version token only decorates the reason; the gate itself needs the
    // driver node to be readable, nothing more.
    let nvidia = match &facts.nvidia_version {
        Some(version) => format!("NVIDIA {version}"),
        None => "NVIDIA".to_string(),
    };
    format!(
        "Hardware compositing is off: WebKitGTK {}.{} on {nvidia}{distro} leaks GPU fences while scrolling.",
        facts.webkit_major, facts.webkit_minor,
    )
}

// Each webview on Windows and macOS comes from the OS, not from WebKitGTK,
// so a forced mode cannot reach anything there. Non-Linux builds report 0.0.0.
fn webkitgtk_build(facts: &EnvFacts) -> bool {
    (facts.webkit_major, facts.webkit_minor) != (0, 0)
}

pub fn decide(facts: &EnvFacts, mode: CompatMode) -> (bool, String) {
    match mode {
        CompatMode::On => (
            false,
            "Hardware compositing is on: forced by your setting.".to_string(),
        ),
        CompatMode::Off if !webkitgtk_build(facts) => (
            false,
            "Hardware compositing is on: this guard does not apply on this platform.".to_string(),
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

// The gate is "the driver node is readable". An unexpected first line leaves
// the version unknown but must not stop the fix from applying.
fn nvidia_driver(read: Option<&str>) -> (bool, Option<String>) {
    match read {
        Some(raw) => (true, raw.lines().next().and_then(nvidia_version_from)),
        None => (false, None),
    }
}

fn nvidia_version_from(line: &str) -> Option<String> {
    line.split_whitespace()
        .find(|token| token.starts_with(|c: char| c.is_ascii_digit()) && token.contains('.'))
        .map(str::to_string)
}

fn pretty_name_from(os_release: &str) -> Option<String> {
    for line in os_release.lines() {
        if let Some(value) = line.strip_prefix("PRETTY_NAME=") {
            let value = value.trim().trim_matches(['"', '\'']);
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }
    None
}

fn x11_session(session_type: Option<&str>, wayland_display: Option<&OsStr>) -> bool {
    let not_wayland = !session_type
        .map(|value| value.trim().eq_ignore_ascii_case("wayland"))
        .unwrap_or(false);
    // Any value, not just a UTF-8 one, means the session is Wayland.
    let no_wayland_display = wayland_display.map(OsStr::is_empty).unwrap_or(true);
    not_wayland && no_wayland_display
}

// Only Linux links webkit2gtk. Elsewhere the reported 0.0.0 cannot match
// AFFECTED_WEBKIT, so the gate stays inert.
#[cfg(target_os = "linux")]
fn webkit_version() -> (u32, u32, u32) {
    // The getters only read a constant built into the library, so no GTK or
    // WebKit initialisation is needed before the app starts.
    unsafe {
        (
            webkit2gtk::ffi::webkit_get_major_version(),
            webkit2gtk::ffi::webkit_get_minor_version(),
            webkit2gtk::ffi::webkit_get_micro_version(),
        )
    }
}

#[cfg(not(target_os = "linux"))]
fn webkit_version() -> (u32, u32, u32) {
    (0, 0, 0)
}

pub fn probe() -> EnvFacts {
    let (nvidia_present, nvidia_version) = nvidia_driver(
        std::fs::read_to_string("/proc/driver/nvidia/version")
            .ok()
            .as_deref(),
    );
    let (webkit_major, webkit_minor, webkit_micro) = webkit_version();
    EnvFacts {
        debian_family: Path::new("/etc/debian_version").exists(),
        distro_label: std::fs::read_to_string("/etc/os-release")
            .ok()
            .and_then(|raw| pretty_name_from(&raw)),
        x11: x11_session(
            std::env::var("XDG_SESSION_TYPE").ok().as_deref(),
            std::env::var_os("WAYLAND_DISPLAY").as_deref(),
        ),
        nvidia_present,
        nvidia_version,
        webkit_major,
        webkit_minor,
        webkit_micro,
    }
}

pub fn apply(disable: bool) {
    if disable {
        std::env::set_var(ENV_VAR, "1");
        APPLIED.store(true, Ordering::SeqCst);
    } else if APPLIED.swap(false, Ordering::SeqCst) {
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
        // No config dir to read a preference from: still apply the auto decision,
        // or the report would claim compositing is off while the leak persists.
        None => {
            let report = report_from(&facts, CompatMode::Auto);
            apply(report.applied);
            store(report)
        }
    };
    // The reason already reads as a sentence ("Hardware compositing is off: …"),
    // so the log prints it rather than wrapping it in a second prefix.
    println!("usdbee: {}", report.reason);
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

    // Every test that reads or writes a process-wide variable takes this lock.
    static ENV_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    // Holds the lock for the test's lifetime and restores every variable it
    // touched on drop, so a panicking test cannot leak state.
    struct EnvGuard {
        saved: Vec<(&'static str, Option<std::ffi::OsString>)>,
        _lock: std::sync::MutexGuard<'static, ()>,
    }

    impl EnvGuard {
        fn new() -> Self {
            Self {
                saved: Vec::new(),
                _lock: ENV_LOCK.lock().unwrap_or_else(|e| e.into_inner()),
            }
        }

        fn save(&mut self, key: &'static str) {
            if !self.saved.iter().any(|(saved, _)| *saved == key) {
                self.saved.push((key, std::env::var_os(key)));
            }
        }

        fn set(&mut self, key: &'static str, value: &str) {
            self.save(key);
            std::env::set_var(key, value);
        }

        fn unset(&mut self, key: &'static str) {
            self.save(key);
            std::env::remove_var(key);
        }
    }

    impl Drop for EnvGuard {
        fn drop(&mut self) {
            for (key, value) in self.saved.drain(..) {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        }
    }

    fn facts_ubuntu_x11_nvidia_252() -> EnvFacts {
        EnvFacts {
            debian_family: true,
            distro_label: Some("Ubuntu 24.04".into()),
            x11: true,
            nvidia_present: true,
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
            nvidia_present: false,
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
        facts.nvidia_present = false;
        facts.nvidia_version = None;
        let (disable, reason) = decide(&facts, CompatMode::Auto);
        assert!(!disable);
        assert!(reason.contains("NVIDIA"), "reason: {reason}");
    }

    #[test]
    fn auto_disables_on_a_readable_driver_without_a_version() {
        let mut facts = facts_ubuntu_x11_nvidia_252();
        facts.nvidia_version = None;
        let (disable, reason) = decide(&facts, CompatMode::Auto);
        assert!(disable, "reason: {reason}");
        assert!(reason.contains("NVIDIA"), "reason: {reason}");
        assert!(reason.contains("on NVIDIA ("), "reason: {reason}");
        assert!(!reason.contains("unknown"), "reason: {reason}");
    }

    #[test]
    fn driver_gate_follows_the_read_not_the_token() {
        assert_eq!(nvidia_driver(None), (false, None));
        assert_eq!(
            nvidia_driver(Some("NVRM version: something unexpected\n")),
            (true, None)
        );
    }

    #[test]
    fn gate_cannot_fire_for_a_zero_webkit_version() {
        // What a non-Linux build reports: 0.0.0 never matches 2.52.
        let mut facts = facts_ubuntu_x11_nvidia_252();
        facts.webkit_major = 0;
        facts.webkit_minor = 0;
        facts.webkit_micro = 0;
        let (disable, reason) = decide(&facts, CompatMode::Auto);
        assert!(!disable, "reason: {reason}");
        assert!(reason.contains("WebKitGTK 0.0"), "reason: {reason}");
    }

    #[cfg(not(target_os = "linux"))]
    #[test]
    fn non_linux_reports_no_webkit_version() {
        assert_eq!(webkit_version(), (0, 0, 0));
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
    fn forced_off_is_inert_without_webkitgtk() {
        let mut facts = facts_ubuntu_x11_nvidia_252();
        facts.webkit_major = 0;
        facts.webkit_minor = 0;
        facts.webkit_micro = 0;
        let (disable, reason) = decide(&facts, CompatMode::Off);
        assert!(!disable, "reason: {reason}");
        assert!(reason.contains("platform"), "reason: {reason}");
    }

    #[test]
    fn forced_off_still_works_on_webkitgtk() {
        let (disable, reason) = decide(&facts_ubuntu_x11_nvidia_252(), CompatMode::Off);
        assert!(disable, "reason: {reason}");
        assert!(reason.contains("setting"), "reason: {reason}");
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
        assert_eq!(
            pretty_name_from("PRETTY_NAME='Debian GNU/Linux 13 (trixie)'\n").as_deref(),
            Some("Debian GNU/Linux 13 (trixie)")
        );
        assert!(pretty_name_from("NAME=\"Ubuntu\"\n").is_none());
    }

    #[test]
    fn wayland_display_only_counts_when_non_empty() {
        assert!(x11_session(Some("x11"), Some(OsStr::new(""))));
        assert!(!x11_session(Some("x11"), Some(OsStr::new("wayland-0"))));
        assert!(!x11_session(Some("wayland"), None));
        assert!(x11_session(None, None));
    }

    #[test]
    fn init_applies_the_variable_when_the_gate_fires() {
        let mut env = EnvGuard::new();
        let dir = tempfile::tempdir().unwrap();
        APPLIED.store(false, Ordering::SeqCst);
        env.unset(ENV_VAR);

        let report = init_with(&facts_ubuntu_x11_nvidia_252(), &dir.path().join(PREFS_FILE));

        assert!(report.applied);
        assert_eq!(std::env::var(ENV_VAR).as_deref(), Ok("1"));
    }

    #[test]
    fn init_removes_the_variable_it_set_itself() {
        let mut env = EnvGuard::new();
        let dir = tempfile::tempdir().unwrap();
        env.unset(ENV_VAR);
        apply(true);
        let path = dir.path().join(PREFS_FILE);
        std::fs::write(&path, r#"{"mode":"on"}"#).unwrap();

        let report = init_with(&facts_ubuntu_x11_nvidia_252(), &path);

        assert!(!report.applied);
        assert_eq!(report.mode, CompatMode::On);
        assert!(std::env::var_os(ENV_VAR).is_none());
    }

    #[test]
    fn apply_keeps_a_variable_the_user_set() {
        let mut env = EnvGuard::new();
        APPLIED.store(false, Ordering::SeqCst);
        env.set(ENV_VAR, "1");

        apply(false);

        assert_eq!(std::env::var(ENV_VAR).as_deref(), Ok("1"));
    }

    #[test]
    fn init_writes_through_set_compat_pref() {
        let mut env = EnvGuard::new();
        let dir = tempfile::tempdir().unwrap();
        env.set("XDG_CONFIG_HOME", dir.path().to_str().unwrap());

        let written = set_compat_pref(CompatMode::Off);

        drop(env);
        written.unwrap();
        let raw = std::fs::read_to_string(dir.path().join(CONFIG_DIR).join(PREFS_FILE)).unwrap();
        assert!(raw.contains("\"mode\": \"off\""), "raw: {raw}");
    }
}
