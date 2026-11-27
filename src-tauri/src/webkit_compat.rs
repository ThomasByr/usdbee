// Decides whether usdbee must turn WebKitGTK's DMABUF renderer off before the
// web process starts. The decision is pure so it can be tested without a GPU,
// a display, or a WebKit process.

use std::path::Path;

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

#[cfg(test)]
mod tests {
    use super::*;

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
}
