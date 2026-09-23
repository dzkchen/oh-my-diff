use std::ffi::OsStr;

pub const MODE_ENV: &str = "OMD_MODE";
pub const MANIFEST_ENV: &str = "OMD_CONTROLLED_MANIFEST";
pub const MOD_STORE_ENV: &str = "OMD_MOD_STORE";
pub const PINNED_UPSTREAM: &str = "rust-v0.155.1 / be2951ea34f0d295ed0becf97079f92fa5f6950e";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeMode {
    UpstreamDirect,
    Platform,
    Enabled,
}

impl RuntimeMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::UpstreamDirect => "upstream-style direct",
            Self::Platform => "Modding platform only",
            Self::Enabled => "OMD enabled",
        }
    }

    pub fn task_hooks_enabled(self) -> bool {
        matches!(self, Self::Enabled)
    }

    pub fn mod_host_enabled(self) -> bool {
        matches!(self, Self::Platform | Self::Enabled)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModeSource {
    Explicit,
    LegacyManifest,
    CompatibilityDefault,
}

impl ModeSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::Explicit => "explicit OMD_MODE selection",
            Self::LegacyManifest => "legacy manifest activation",
            Self::CompatibilityDefault => "compatibility default",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EffectiveMode {
    pub mode: RuntimeMode,
    pub source: ModeSource,
}

pub fn effective_mode() -> Result<EffectiveMode, String> {
    effective_mode_from(
        std::env::var_os(MODE_ENV).as_deref(),
        std::env::var_os(MANIFEST_ENV).is_some(),
    )
}

pub fn effective_mode_from(
    selected: Option<&OsStr>,
    controlled_manifest_present: bool,
) -> Result<EffectiveMode, String> {
    match selected.and_then(OsStr::to_str) {
        Some("upstream_direct") if controlled_manifest_present => Err(format!(
            "{MODE_ENV}=upstream_direct forbids {MANIFEST_ENV}; remove the manifest to keep OMD task hooks disabled"
        )),
        Some("upstream_direct") => Ok(EffectiveMode {
            mode: RuntimeMode::UpstreamDirect,
            source: ModeSource::Explicit,
        }),
        Some("platform") if controlled_manifest_present => Err(format!(
            "{MODE_ENV}=platform forbids {MANIFEST_ENV}; platform mods run without controlled task policy"
        )),
        Some("platform") => Ok(EffectiveMode {
            mode: RuntimeMode::Platform,
            source: ModeSource::Explicit,
        }),
        Some("enabled") if controlled_manifest_present => Ok(EffectiveMode {
            mode: RuntimeMode::Enabled,
            source: ModeSource::Explicit,
        }),
        Some("enabled") => Err(format!(
            "{MODE_ENV}=enabled requires {MANIFEST_ENV} for explicit OMD activation"
        )),
        Some(value) => Err(format!(
            "invalid {MODE_ENV} value {value:?}; expected upstream_direct, platform, or enabled"
        )),
        None if selected.is_some() => Err(format!(
            "invalid non-Unicode {MODE_ENV}; expected upstream_direct, platform, or enabled"
        )),
        None if controlled_manifest_present => Ok(EffectiveMode {
            mode: RuntimeMode::Enabled,
            source: ModeSource::LegacyManifest,
        }),
        None => Ok(EffectiveMode {
            mode: RuntimeMode::UpstreamDirect,
            source: ModeSource::CompatibilityDefault,
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explicit_direct_mode_rejects_every_controlled_manifest() {
        let direct = effective_mode_from(Some(OsStr::new("upstream_direct")), false).unwrap();
        assert_eq!(direct.mode, RuntimeMode::UpstreamDirect);
        assert_eq!(direct.source, ModeSource::Explicit);
        assert!(!direct.mode.task_hooks_enabled());

        let error = effective_mode_from(Some(OsStr::new("upstream_direct")), true).unwrap_err();
        assert!(error.contains("forbids OMD_CONTROLLED_MANIFEST"));
    }

    #[test]
    fn enabled_mode_requires_explicit_activation_material() {
        let enabled = effective_mode_from(Some(OsStr::new("enabled")), true).unwrap();
        assert_eq!(enabled.mode, RuntimeMode::Enabled);
        assert_eq!(enabled.source, ModeSource::Explicit);
        assert!(enabled.mode.task_hooks_enabled());

        let error = effective_mode_from(Some(OsStr::new("enabled")), false).unwrap_err();
        assert!(error.contains("requires OMD_CONTROLLED_MANIFEST"));
    }

    #[test]
    fn platform_mode_registers_mods_without_task_hooks_or_manifest() {
        let platform = effective_mode_from(Some(OsStr::new("platform")), false).unwrap();
        assert_eq!(platform.mode, RuntimeMode::Platform);
        assert!(platform.mode.mod_host_enabled());
        assert!(!platform.mode.task_hooks_enabled());
        assert!(
            effective_mode_from(Some(OsStr::new("platform")), true)
                .unwrap_err()
                .contains("forbids OMD_CONTROLLED_MANIFEST")
        );
    }

    #[test]
    fn compatibility_paths_preserve_prior_activation_without_ambiguity() {
        assert_eq!(
            effective_mode_from(None, false).unwrap(),
            EffectiveMode {
                mode: RuntimeMode::UpstreamDirect,
                source: ModeSource::CompatibilityDefault,
            }
        );
        assert_eq!(
            effective_mode_from(None, true).unwrap(),
            EffectiveMode {
                mode: RuntimeMode::Enabled,
                source: ModeSource::LegacyManifest,
            }
        );
    }

    #[test]
    fn unknown_mode_never_silently_falls_back() {
        let error = effective_mode_from(Some(OsStr::new("off")), false).unwrap_err();
        assert!(error.contains("expected upstream_direct, platform, or enabled"));
    }
}
