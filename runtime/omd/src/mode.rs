use std::ffi::OsStr;

pub const MODE_ENV: &str = "OMD_MODE";
pub const MANIFEST_ENV: &str = "OMD_CONTROLLED_MANIFEST";
pub const MOD_STORE_ENV: &str = "OMD_MOD_STORE";
pub const PINNED_UPSTREAM: &str = "rust-v0.162.1 / 092d3acd6bec3e3a14bdc7e7a2810ab628ab759d";

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

