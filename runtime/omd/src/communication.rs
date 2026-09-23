use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;
use std::io;

#[derive(Clone, Copy, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum WorkerReportStatus {
    Completed,
    Partial,
    Blocked,
}

#[derive(Clone, Debug, Deserialize, Serialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct WorkerReport {
    pub schema: u32,
    pub status: WorkerReportStatus,
    pub summary: String,
    pub scope: Vec<String>,
    pub uncertainty: Vec<String>,
    pub evidence: Vec<String>,
    pub required_clarification: Vec<String>,
}

fn invalid(message: &str) -> io::Error {
    io::Error::other(message)
}

fn valid_text(value: &str, max: usize) -> bool {
    !value.trim().is_empty() && value.len() <= max
}

fn unique_text(values: &[String], max_items: usize, max_bytes: usize) -> bool {
    values.len() <= max_items
        && values.iter().all(|value| valid_text(value, max_bytes))
        && values.iter().collect::<BTreeSet<_>>().len() == values.len()
}

impl WorkerReport {
    pub fn parse(value: &str) -> io::Result<Self> {
        if value.len() > 65_536 {
            return Err(invalid("worker report exceeds size limit"));
        }
        let report: Self = serde_json::from_str(value)?;
        report.validate()?;
        Ok(report)
    }

    pub fn validate(&self) -> io::Result<()> {
        if self.schema != 1
            || !valid_text(&self.summary, 4096)
            || self.scope.is_empty()
            || !unique_text(&self.scope, 32, 1024)
            || !unique_text(&self.uncertainty, 32, 1024)
            || !unique_text(&self.evidence, 64, 4096)
            || !unique_text(&self.required_clarification, 16, 1024)
            || (self.status == WorkerReportStatus::Blocked
                && self.required_clarification.is_empty())
            || (self.status == WorkerReportStatus::Completed
                && !self.required_clarification.is_empty())
        {
            return Err(invalid("invalid structured worker report"));
        }
        Ok(())
    }
}
