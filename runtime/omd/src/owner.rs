use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum OwnerKind {
    Bundled,
    Mod,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PolicyOwner {
    pub kind: OwnerKind,
    pub id: String,
    pub version: String,
    pub source: String,
    pub sha256: String,
}

impl PolicyOwner {
    pub fn bundled() -> Self {
        Self {
            kind: OwnerKind::Bundled,
            id: "oh-my-diff".into(),
            version: crate::PINNED_UPSTREAM.into(),
            source: "bundled native host".into(),
            sha256: format!("{:x}", Sha256::digest(crate::PINNED_UPSTREAM.as_bytes())),
        }
    }
}
