use std::ffi::OsStr;

pub const MODE_ENV: &str = "OMD_MODE";
pub const MANIFEST_ENV: &str = "OMD_CONTROLLED_MANIFEST";
pub const MOD_STORE_ENV: &str = "OMD_MOD_STORE";
pub const PINNED_UPSTREAM: &str = "rust-v0.159.1 / 8e68a98ef03cdde76d2e6800791ebdf1b3b95b24";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RuntimeMode {
    UpstreamDirect,
    Omd,
}

impl RuntimeMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::UpstreamDirect => "upstream-style direct",
            Self::Omd => "Oh My Diff",
        }
    }

    pub fn mod_host_enabled(self) -> bool {
        matches!(self, Self::Omd)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ModeSource {
    Explicit,
    CompatibilityDefault,
}

impl ModeSource {
    pub fn label(self) -> &'static str {
        match self {
            Self::Explicit => "explicit OMD_MODE selection",
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
    legacy_manifest_present: bool,
) -> Result<EffectiveMode, String> {
    if legacy_manifest_present {
        return Err(format!(
            "{MANIFEST_ENV} is no longer supported; the controlled workflow ships as mods. Unset it and launch with {MODE_ENV}=omd"
        ));
    }
    match selected.and_then(OsStr::to_str) {
        Some("upstream_direct") => Ok(EffectiveMode {
            mode: RuntimeMode::UpstreamDirect,
            source: ModeSource::Explicit,
        }),
        Some("omd") => Ok(EffectiveMode {
            mode: RuntimeMode::Omd,
            source: ModeSource::Explicit,
        }),
        Some(value @ ("platform" | "enabled")) => Err(format!(
            "{MODE_ENV}={value} was replaced by {MODE_ENV}=omd; relaunch with {MODE_ENV}=omd or {MODE_ENV}=upstream_direct"
        )),
        Some(value) => Err(format!(
            "invalid {MODE_ENV} value {value:?}; expected omd or upstream_direct"
        )),
        None if selected.is_some() => Err(format!(
            "invalid non-Unicode {MODE_ENV}; expected omd or upstream_direct"
        )),
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
    fn omd_and_direct_modes_are_the_only_selections() {
        let omd = effective_mode_from(Some(OsStr::new("omd")), false).unwrap();
        assert_eq!(omd.mode, RuntimeMode::Omd);
        assert!(omd.mode.mod_host_enabled());
        let direct = effective_mode_from(Some(OsStr::new("upstream_direct")), false).unwrap();
        assert_eq!(direct.mode, RuntimeMode::UpstreamDirect);
        assert!(!direct.mode.mod_host_enabled());
        assert_eq!(
            effective_mode_from(None, false).unwrap(),
            EffectiveMode {
                mode: RuntimeMode::UpstreamDirect,
                source: ModeSource::CompatibilityDefault,
            }
        );
    }

    #[test]
    fn removed_modes_and_manifests_fail_with_the_replacement() {
        for removed in ["platform", "enabled"] {
            let error = effective_mode_from(Some(OsStr::new(removed)), false).unwrap_err();
            assert!(error.contains("OMD_MODE=omd"), "{error}");
        }
        let error = effective_mode_from(Some(OsStr::new("omd")), true).unwrap_err();
        assert!(error.contains("OMD_MODE=omd"), "{error}");
        assert!(
            effective_mode_from(Some(OsStr::new("off")), false)
                .unwrap_err()
                .contains("expected omd or upstream_direct")
        );
    }
}
