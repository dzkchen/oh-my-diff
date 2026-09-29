use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct PolicyOwner {
    pub id: String,
    pub version: String,
    pub source: String,
    pub sha256: String,
}
