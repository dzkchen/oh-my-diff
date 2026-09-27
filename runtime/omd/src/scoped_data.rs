use crate::KnowledgeStore;
use crate::knowledge_access::KnowledgeAccess;
use crate::resource_data::{ResourceBinding, ResourceStore, hash};
use crate::sessions::SessionIndex;
use serde_json::{Value, json};
use std::io;
use std::path::{Path, PathBuf};

pub struct ScopedDataHost {
    pub root: PathBuf,
    pub repository: PathBuf,
    pub session_root: Option<PathBuf>,
    pub session_database: Option<PathBuf>,
    pub binding: ResourceBinding,
    pub confirmation: Option<String>,
    pub(crate) session_bytes: usize,
}

pub fn operation(name: &str) -> bool {
    matches!(
        name,
        "evidence.read"
            | "sessions.list"
            | "sessions.read"
            | "knowledge.inspect"
            | "knowledge.retain"
            | "knowledge.propose"
            | "knowledge.approve"
            | "knowledge.remove"
            | "knowledge.reset"
            | "knowledge.snapshot"
            | "context.freeze"
            | "context.deliver"
    )
}

impl ScopedDataHost {
    pub fn new(
        root: PathBuf,
        repository: PathBuf,
        session_root: Option<PathBuf>,
        owner: String,
        thread: String,
        generation: u64,
        source_sha256: String,
    ) -> io::Result<Self> {
        if repository.canonicalize()? != repository
            || root.canonicalize()? != root
            || root.starts_with(&repository)
        {
            return Err(io::Error::other("data_scope_invalid"));
        }
        if generation == 0 {
            return Err(io::Error::other("data_dispatch_generation_invalid"));
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
            session_database: None,
            binding,
            confirmation: None,
            session_bytes: 0,
        })
    }

    pub fn call(
        &mut self,
        name: &str,
        arguments: Value,
        readable: &dyn Fn(&Path) -> bool,
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
        .capability()?;
        if configuration.revision != self.binding.generation
            || !selection.capabilities.iter().any(|cap| cap == required)
            || name.starts_with("context.")
                && !selection.capabilities.iter().any(|cap| cap == "context")
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
            return self.resources().page(
                &input.reference,
                "turn",
                input.cursor.unwrap_or(0),
                input.max_bytes.unwrap_or(crate::resource_data::PAGE_BYTES),
            );
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
        if !operation(name) {
            return Err(io::Error::other("data_operation_unavailable"));
        }
        let resources = ResourceStore {
            root: &self.root,
            binding: &self.binding,
        };
        let directory = resources.directory()?;
        let path = directory.join("knowledge");
        let store = if path.try_exists()? {
            KnowledgeStore::open(path)?
        } else {
            KnowledgeStore::create(path, self.binding.repository.clone())?
        };
        let user_action = if matches!(
            name,
            "knowledge.approve" | "knowledge.remove" | "knowledge.reset"
        ) {
            let token = hash(&serde_json::to_vec(
                &json!({"binding":self.binding,"operation":name,"arguments":arguments}),
            )?);
            if self.confirmation.as_deref() != Some(&token) {
                return Err(io::Error::other(format!(
                    "explicit_user_confirmation_required:{token}"
                )));
            }
            Some(crate::KnowledgeAction {
                actor: "user".into(),
                reason: format!("explicit {name} confirmation {token}"),
            })
        } else {
            None
        };
        KnowledgeAccess {
            store: &store,
            repository: &self.repository,
            resources,
            user_action,
            readable,
        }
        .call(name, arguments, active)
    }

    pub fn resources(&self) -> ResourceStore<'_> {
        ResourceStore {
            root: &self.root,
            binding: &self.binding,
        }
    }
}
