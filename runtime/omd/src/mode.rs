pub const MODE_ENV: &str = "OMD_MODE";
pub const MOD_STORE_ENV: &str = "OMD_MOD_STORE";

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

pub fn effective_mode() -> Result<RuntimeMode, String> {
    let Some(selected) = std::env::var_os(MODE_ENV) else {
        return Ok(RuntimeMode::UpstreamDirect);
    };
    match selected.to_str() {
        Some("upstream_direct") => Ok(RuntimeMode::UpstreamDirect),
        Some("omd") => Ok(RuntimeMode::Omd),
        Some(value) => Err(format!(
            "invalid {MODE_ENV} value {value:?}; expected omd or upstream_direct"
        )),
        None => Err(format!(
            "invalid non-Unicode {MODE_ENV}; expected omd or upstream_direct"
        )),
    }
}
