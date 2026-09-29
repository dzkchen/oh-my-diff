use crate::resource_data::{ResourceBinding, ResourceStore, hash};
use crate::sessions::SessionIndex;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;

pub struct ScopedDataHost {
    pub root: PathBuf,
    pub repository: PathBuf,
    pub session_root: Option<PathBuf>,
    pub session_database: Option<PathBuf>,
    pub binding: ResourceBinding,
    pub(crate) session_bytes: usize,
}

pub fn operation(name: &str) -> bool {
    matches!(
        name,
        "evidence.read" | "evidence.write" | "sessions.list" | "sessions.read"
    )
}

impl ScopedDataHost {
    pub fn new(
        root: PathBuf,
        repository: PathBuf,
        session_root: Option<PathBuf>,
        session_database: Option<PathBuf>,
        owner: String,
        thread: String,
        source_sha256: String,
    ) -> io::Result<Self> {
        if repository.canonicalize()? != repository
            || root.canonicalize()? != root
            || root.starts_with(&repository)
        {
            return Err(io::Error::other("data_scope_invalid"));
        }
        let configuration = crate::ModStore::open(root.clone())?.configuration()?;
        if !configuration
            .mods
            .iter()
            .any(|selection| selection.enabled && selection.sha256 == source_sha256)
        {
            return Err(io::Error::other("data_source_not_selected"));
        }
        let binding = ResourceBinding {
            repository: hash(repository.as_os_str().as_encoded_bytes()),
            owner,
            thread,
            generation: configuration.revision,
            source_sha256,
        };
        binding.validate()?;
        Ok(Self {
            root,
            repository,
            session_root,
            session_database,
            binding,
            session_bytes: 0,
        })
    }

    pub fn call(
        &mut self,
        name: &str,
        arguments: Value,
        active: impl Fn() -> bool,
    ) -> io::Result<Value> {
        if !active() {
            return Err(io::Error::other("data_operation_cancelled"));
        }
        let configuration = crate::ModStore::open(self.root.clone())?.configuration()?;
        let selection = configuration
            .mods
            .iter()
            .find(|selection| selection.enabled && selection.sha256 == self.binding.source_sha256)
            .ok_or_else(|| io::Error::other("data_source_not_selected"))?;
        let required = crate::ModHostCall {
            operation: name.into(),
            arguments: Value::Null,
        }
        .capability()
        .map_err(|error| io::Error::other(error.to_string()))?;
        if configuration.revision != self.binding.generation
            || !selection.capabilities.iter().any(|cap| cap == required)
        {
            return Err(io::Error::other("data_selection_changed_or_revoked"));
        }
        if name == "evidence.read" {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Input {
                reference: crate::resource_data::ResourceRef,
                cursor: Option<usize>,
                max_bytes: Option<usize>,
            }
            let input: Input = serde_json::from_value(arguments)?;
            let mut last = io::Error::other("resource_unavailable");
            for kind in ["turn", "evidence"] {
                match self.resources().page(
                    &input.reference,
                    kind,
                    input.cursor.unwrap_or(0),
                    input.max_bytes.unwrap_or(crate::resource_data::PAGE_BYTES),
                ) {
                    Ok(page) => return Ok(page),
                    Err(error) => last = error,
                }
            }
            return Err(last);
        }
        if name == "evidence.write" {
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Input {
                media_type: String,
                content: Value,
                #[serde(default)]
                label: Option<String>,
            }
            let input: Input = serde_json::from_value(arguments)?;
            if !matches!(input.media_type.as_str(), "application/json" | "text/plain")
                || input.media_type == "text/plain" && !input.content.is_string()
                || input.label.as_deref().is_some_and(|label| {
                    label.is_empty() || label.len() > 128 || label.chars().any(char::is_control)
                })
            {
                return Err(io::Error::other("evidence_record_invalid"));
            }
            let reference = self.resources().save(
                "evidence",
                json!({"media_type": input.media_type, "label": input.label, "content": input.content}),
            )?;
            return Ok(serde_json::to_value(reference)?);
        }
        if name.starts_with("sessions.") {
            let root = self
                .session_root
                .as_ref()
                .ok_or_else(|| io::Error::other("session_access_unavailable"))?;
            let result = SessionIndex {
                root,
                database: self.session_database.as_deref(),
                repository: &self.repository,
                enabled: true,
            }
            .call(name, arguments, active)?;
            self.session_bytes = self
                .session_bytes
                .saturating_add(serde_json::to_vec(&result)?.len());
            if self.session_bytes > 1_048_576 {
                return Err(io::Error::other("session_invocation_limit"));
            }
            return Ok(result);
        }
        Err(io::Error::other("data_operation_unavailable"))
    }

    pub fn resources(&self) -> ResourceStore<'_> {
        ResourceStore {
            root: &self.root,
            binding: &self.binding,
        }
    }
}

pub struct ScopedDataHosts {
    root: PathBuf,
    repository: PathBuf,
    session_root: Option<PathBuf>,
    session_database: Option<PathBuf>,
    thread: String,
    hosts: BTreeMap<String, ScopedDataHost>,
}

impl ScopedDataHosts {
    pub fn new(
        root: PathBuf,
        repository: PathBuf,
        session_root: Option<PathBuf>,
        session_database: Option<PathBuf>,
        thread: String,
    ) -> Self {
        Self {
            root,
            repository,
            session_root,
            session_database,
            thread,
            hosts: BTreeMap::new(),
        }
    }

    pub fn call(
        &mut self,
        owner: &str,
        source_sha256: &str,
        name: &str,
        arguments: Value,
        active: impl Fn() -> bool,
    ) -> io::Result<Value> {
        let host = match self.hosts.entry(owner.to_owned()) {
            std::collections::btree_map::Entry::Occupied(entry) => entry.into_mut(),
            std::collections::btree_map::Entry::Vacant(entry) => entry.insert(ScopedDataHost::new(
                self.root.clone(),
                self.repository.clone(),
                self.session_root.clone(),
                self.session_database.clone(),
                owner.to_owned(),
                self.thread.clone(),
                source_sha256.to_owned(),
            )?),
        };
        if host.binding.source_sha256 != source_sha256 {
            return Err(io::Error::other("data_selection_changed_or_revoked"));
        }
        host.call(name, arguments, active)
    }
}
