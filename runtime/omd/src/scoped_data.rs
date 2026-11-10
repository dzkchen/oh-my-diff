use crate::resource_data::{ResourceBinding, ResourceStore};
use crate::sessions::SessionIndex;
use serde_json::Value;
use std::collections::BTreeMap;
use std::io;
use std::path::PathBuf;

#[cfg(test)]
#[path = "scoped_data_tests.rs"]
mod tests;

pub struct ScopedDataHost {
    store: crate::ModStore,
    pub root: PathBuf,
    pub repository: PathBuf,
    pub session_root: Option<PathBuf>,
    pub session_database: Option<PathBuf>,
    pub binding: ResourceBinding,
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
        Self::with_store(
            crate::ModStore::open(root)?,
            repository,
            session_root,
            session_database,
            owner,
            thread,
            source_sha256,
        )
    }

    fn with_store(
        store: crate::ModStore,
        repository: PathBuf,
        session_root: Option<PathBuf>,
        session_database: Option<PathBuf>,
        owner: String,
        thread: String,
        source_sha256: String,
    ) -> io::Result<Self> {
        let root = store.root().to_path_buf();
        if repository.canonicalize()? != repository
            || root.canonicalize()? != root
            || crate::inside_repository(&root, &repository)
        {
            return Err(io::Error::other("data_scope_invalid"));
        }
        let (generation, _) = store.data_selection(&repository, &owner, &source_sha256)?;
        let binding = ResourceBinding {
            repository: crate::sha256_hex(repository.as_os_str().as_encoded_bytes()),
            owner,
            thread,
            generation,
            source_sha256,
        };
        binding.validate()?;
        Ok(Self {
            store,
            root,
            repository,
            session_root,
            session_database,
            binding,
        })
    }

    fn authorize(&mut self, name: &str) -> io::Result<crate::mods::ModSelection> {
        let (generation, selection) = self.store.data_selection(
            &self.repository,
            &self.binding.owner,
            &self.binding.source_sha256,
        )?;
        let required = crate::ModHostCall {
            operation: name.into(),
            arguments: Value::Null,
        }
        .capability()
        .map_err(|error| io::Error::other(error.to_string()))?;
        if !selection.capabilities.iter().any(|cap| cap == required) {
            return Err(io::Error::other("data_selection_changed_or_revoked"));
        }
        self.binding.generation = generation;
        Ok(selection)
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
        let selection = self.authorize(name)?;
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
            let resources = self.resources();
            let reference = resources.save("evidence", resources.evidence_record(arguments)?)?;
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
                tools: selection
                    .capabilities
                    .iter()
                    .any(|cap| cap == "sessions_tools"),
            }
            .call(name, arguments, active)?;
            if serde_json::to_vec(&result)?.len() > 1_048_576 {
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
        self.host(owner, source_sha256)?
            .call(name, arguments, active)
    }

    pub fn text_evidence(
        &mut self,
        owner: &str,
        source_sha256: &str,
        label: &str,
        text: &str,
    ) -> io::Result<crate::resource_data::ResourceRef> {
        let host = self.host(owner, source_sha256)?;
        host.authorize("evidence.write")?;
        host.resources().text_evidence(label, text)
    }

    fn host(&mut self, owner: &str, source_sha256: &str) -> io::Result<&mut ScopedDataHost> {
        if self
            .hosts
            .get(owner)
            .is_some_and(|host| host.binding.source_sha256 != source_sha256)
        {
            self.hosts.remove(owner);
        }
        Ok(match self.hosts.entry(owner.to_owned()) {
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
        })
    }
}
