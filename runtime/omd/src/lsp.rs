use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::process::Child;
use std::process::ChildStdin;
use std::process::Command;
use std::process::Stdio;
use std::sync::mpsc;
use std::time::Duration;
use std::time::Instant;

pub const LSP_PREFERENCE_SCHEMA: u32 = 1;
pub const LSP_RESULT_SCHEMA: u32 = 1;

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum LspLanguage {
    Rust,
    TypeScript,
    JavaScript,
    Python,
    Java,
}

impl LspLanguage {
    pub fn from_path(path: &Path) -> Option<Self> {
        match path.extension()?.to_str()? {
            "rs" => Some(Self::Rust),
            "ts" | "tsx" | "mts" | "cts" => Some(Self::TypeScript),
            "js" | "jsx" | "mjs" | "cjs" => Some(Self::JavaScript),
            "py" | "pyi" => Some(Self::Python),
            "java" => Some(Self::Java),
            _ => None,
        }
    }

    pub fn language_id(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Python => "python",
            Self::Java => "java",
        }
    }

    fn candidates(self) -> &'static [(&'static str, &'static [&'static str])] {
        match self {
            Self::Rust => &[("rust-analyzer", &[])],
            Self::TypeScript | Self::JavaScript => &[
                ("typescript-language-server", &["--stdio"]),
                ("vtsls", &["--stdio"]),
            ],
            Self::Python => &[
                ("pyright-langserver", &["--stdio"]),
                ("pylsp", &[]),
                ("jedi-language-server", &[]),
            ],
            Self::Java => &[("jdtls", &[])],
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LspLimits {
    pub startup_ms: u64,
    pub request_ms: u64,
    pub diagnostic_batch_ms: u64,
    pub idle_ms: u64,
    pub max_workspace_files: usize,
    pub max_workspace_bytes: usize,
    pub max_response_bytes: usize,
    pub max_edit_files: usize,
    pub max_text_edits: usize,
    pub max_check_output_bytes: usize,
    pub check_timeout_ms: u64,
}

impl Default for LspLimits {
    fn default() -> Self {
        Self {
            startup_ms: 10_000,
            request_ms: 10_000,
            diagnostic_batch_ms: 150,
            idle_ms: 60_000,
            max_workspace_files: 20_000,
            max_workspace_bytes: 128 * 1024 * 1024,
            max_response_bytes: 4 * 1024 * 1024,
            max_edit_files: 128,
            max_text_edits: 4_096,
            max_check_output_bytes: 1024 * 1024,
            check_timeout_ms: 120_000,
        }
    }
}

impl LspLimits {
    pub fn validate(&self) -> io::Result<()> {
        if self.startup_ms == 0
            || self.startup_ms > 120_000
            || self.request_ms == 0
            || self.request_ms > 120_000
            || self.diagnostic_batch_ms == 0
            || self.diagnostic_batch_ms > self.request_ms
            || self.idle_ms < self.request_ms
            || self.idle_ms > 3_600_000
            || self.max_workspace_files == 0
            || self.max_workspace_files > 1_000_000
            || self.max_workspace_bytes == 0
            || self.max_workspace_bytes > 2 * 1024 * 1024 * 1024
            || self.max_response_bytes == 0
            || self.max_response_bytes > 64 * 1024 * 1024
            || self.max_edit_files == 0
            || self.max_edit_files > 4_096
            || self.max_text_edits == 0
            || self.max_text_edits > 100_000
            || self.max_check_output_bytes == 0
            || self.max_check_output_bytes > 16 * 1024 * 1024
            || self.check_timeout_ms == 0
            || self.check_timeout_ms > 30 * 60 * 1_000
        {
            return Err(io::Error::other("invalid LSP limits"));
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LspPreference {
    pub repository_identity: String,
    pub enabled: bool,
    pub revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct LspPreferenceFile {
    schema: u32,
    repositories: BTreeMap<String, LspPreference>,
}

pub struct LspPreferenceStore {
    path: PathBuf,
    state: LspPreferenceFile,
}

impl LspPreferenceStore {
    pub fn open(path: PathBuf) -> io::Result<Self> {
        let state = if path.exists() {
            let bytes = fs::read(&path)?;
            if bytes.len() > 1024 * 1024 {
                return Err(io::Error::other("LSP preference store exceeds limit"));
            }
            let state: LspPreferenceFile = serde_json::from_slice(&bytes)?;
            if state.schema != LSP_PREFERENCE_SCHEMA || state.repositories.len() > 10_000 {
                return Err(io::Error::other("invalid LSP preference store"));
            }
            state
        } else {
            LspPreferenceFile {
                schema: LSP_PREFERENCE_SCHEMA,
                repositories: BTreeMap::new(),
            }
        };
        Ok(Self { path, state })
    }

    pub fn preference(&self, repository_identity: &str) -> Option<&LspPreference> {
        self.state.repositories.get(repository_identity)
    }

    pub fn set(&mut self, repository_identity: String, enabled: bool) -> io::Result<LspPreference> {
        if repository_identity.is_empty() || repository_identity.len() > 512 {
            return Err(io::Error::other("invalid repository identity"));
        }
        let revision = self
            .state
            .repositories
            .get(&repository_identity)
            .map_or(1, |prior| prior.revision.saturating_add(1));
        let preference = LspPreference {
            repository_identity: repository_identity.clone(),
            enabled,
            revision,
        };
        self.state
            .repositories
            .insert(repository_identity, preference.clone());
        self.write()?;
        Ok(preference)
    }

    fn write(&self) -> io::Result<()> {
        let parent = self
            .path
            .parent()
            .ok_or_else(|| io::Error::other("LSP preference parent missing"))?;
        fs::create_dir_all(parent)?;
        let name = self
            .path
            .file_name()
            .and_then(|name| name.to_str())
            .ok_or_else(|| io::Error::other("invalid LSP preference path"))?;
        let temporary = parent.join(format!(".{name}.tmp-{}", std::process::id()));
        let bytes = serde_json::to_vec_pretty(&self.state)?;
        fs::write(&temporary, bytes)?;
        fs::rename(temporary, &self.path)
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct InstalledServer {
    pub language: LspLanguage,
    pub executable: Option<PathBuf>,
    pub arguments: Vec<String>,
}

pub fn detect_installed_servers() -> Vec<InstalledServer> {
    [
        LspLanguage::Rust,
        LspLanguage::TypeScript,
        LspLanguage::JavaScript,
        LspLanguage::Python,
        LspLanguage::Java,
    ]
    .into_iter()
    .map(|language| {
        let found = language.candidates().iter().find_map(|(name, arguments)| {
            resolve_executable(name)
                .filter(|path| executable_responds(path))
                .map(|path| {
                    (
                        path,
                        arguments.iter().map(|value| (*value).to_string()).collect(),
                    )
                })
        });
        InstalledServer {
            language,
            executable: found.as_ref().map(|found| found.0.clone()),
            arguments: found.map_or_else(Vec::new, |found| found.1),
        }
    })
    .collect()
}

fn resolve_executable(name: &str) -> Option<PathBuf> {
    let path = Path::new(name);
    if path.components().count() > 1 {
        return path.is_file().then(|| path.to_path_buf());
    }
    env::split_paths(&env::var_os("PATH")?).find_map(|directory| {
        let candidate = directory.join(name);
        candidate.is_file().then_some(candidate)
    })
}

fn executable_responds(path: &Path) -> bool {
    let mut child = match Command::new(path)
        .arg("--version")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
    {
        Ok(child) => child,
        Err(_) => return false,
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => return status.success(),
            Ok(None) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return false;
            }
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LspPosition {
    pub line: u32,
    pub character: u32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LspRange {
    pub start: LspPosition,
    pub end: LspPosition,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SemanticOperation {
    Definition,
    References,
    CodeAction,
    RenameSymbol,
    RenameFile,
}

#[derive(Clone, Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SemanticFallback {
    pub status: String,
    pub operation: SemanticOperation,
    pub reason: String,
    pub fallback: String,
}

impl SemanticFallback {
    fn new(operation: SemanticOperation, reason: impl Into<String>) -> Self {
        Self {
            status: "unsupported".into(),
            operation,
            reason: reason.into(),
            fallback: "Use exact text search and ordinary scoped edits, then run the selected executable check; do not claim semantic coverage.".into(),
        }
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct LspCapabilities {
    pub definition: bool,
    pub references: bool,
    pub rename_symbol: bool,
    pub prepare_rename: bool,
    pub code_action: bool,
    pub rename_file: bool,
}

#[derive(Clone, Debug)]
struct Document {
    version: i64,
    sha256: String,
    text: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SyncResult {
    pub schema: u32,
    pub candidate_sha256: String,
    pub documents: BTreeMap<String, DocumentVersion>,
    pub diagnostics: BTreeMap<String, Value>,
    pub diagnostic_fallbacks: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentVersion {
    pub version: i64,
    pub sha256: String,
}

pub struct LspSession {
    repository: PathBuf,
    language: LspLanguage,
    limits: LspLimits,
    process: RpcProcess,
    capabilities: Value,
    documents: BTreeMap<String, Document>,
    diagnostics: BTreeMap<String, Value>,
    diagnostic_fallbacks: BTreeMap<String, String>,
    last_used: Instant,
}

impl LspSession {
    pub fn start(
        repository: PathBuf,
        language: LspLanguage,
        limits: LspLimits,
        server: Option<InstalledServer>,
    ) -> Result<Self, SemanticFallback> {
        if let Err(error) = limits.validate() {
            return Err(SemanticFallback::new(
                SemanticOperation::Definition,
                error.to_string(),
            ));
        }
        let canonical = repository.canonicalize().map_err(|error| {
            SemanticFallback::new(SemanticOperation::Definition, error.to_string())
        })?;
        if canonical != repository {
            return Err(SemanticFallback::new(
                SemanticOperation::Definition,
                "repository path must be canonical",
            ));
        }
        bound_workspace(&repository, &limits).map_err(|error| {
            SemanticFallback::new(SemanticOperation::Definition, error.to_string())
        })?;
        let server = server
            .or_else(|| {
                detect_installed_servers()
                    .into_iter()
                    .find(|server| server.language == language && server.executable.is_some())
            })
            .filter(|server| server.language == language)
            .ok_or_else(|| {
                SemanticFallback::new(
                    SemanticOperation::Definition,
                    format!(
                        "no installed {} language server detected",
                        language.language_id()
                    ),
                )
            })?;
        let executable = server.executable.ok_or_else(|| {
            SemanticFallback::new(
                SemanticOperation::Definition,
                format!(
                    "no installed {} language server detected",
                    language.language_id()
                ),
            )
        })?;
        let mut process = RpcProcess::spawn(
            &executable,
            &server.arguments,
            &repository,
            limits.max_response_bytes,
        )
        .map_err(|error| SemanticFallback::new(SemanticOperation::Definition, error.to_string()))?;
        let root_uri = path_to_uri(&repository);
        let response = process
            .request(
                "initialize",
                json!({
                    "processId": std::process::id(),
                    "clientInfo": {"name": "oh-my-diff", "version": env!("CARGO_PKG_VERSION")},
                    "rootUri": root_uri,
                    "workspaceFolders": [{"uri": root_uri, "name": repository.file_name().and_then(|value| value.to_str()).unwrap_or("workspace")}],
                    "capabilities": {
                        "textDocument": {
                            "definition": {"dynamicRegistration": false, "linkSupport": true},
                            "references": {"dynamicRegistration": false},
                            "rename": {"dynamicRegistration": false, "prepareSupport": true},
                            "codeAction": {"dynamicRegistration": false, "isPreferredSupport": true, "dataSupport": true, "resolveSupport": {"properties": ["edit"]}},
                            "publishDiagnostics": {"relatedInformation": true, "versionSupport": true}
                        },
                        "workspace": {
                            "applyEdit": true,
                            "workspaceEdit": {"documentChanges": true, "resourceOperations": ["rename"], "failureHandling": "transactional"},
                            "fileOperations": {"dynamicRegistration": false, "willRename": true, "didRename": true}
                        }
                    }
                }),
                Duration::from_millis(limits.startup_ms),
            )
            .map_err(|error| {
                SemanticFallback::new(SemanticOperation::Definition, error.to_string())
            })?;
        let capabilities = response.get("capabilities").cloned().unwrap_or(Value::Null);
        process.notify("initialized", json!({})).map_err(|error| {
            SemanticFallback::new(SemanticOperation::Definition, error.to_string())
        })?;
        Ok(Self {
            repository,
            language,
            limits,
            process,
            capabilities,
            documents: BTreeMap::new(),
            diagnostics: BTreeMap::new(),
            diagnostic_fallbacks: BTreeMap::new(),
            last_used: Instant::now(),
        })
    }

    pub fn capabilities(&self) -> LspCapabilities {
        let capability = |name: &str| {
            self.capabilities
                .get(name)
                .is_some_and(|value| value == true || value.is_object())
        };
        LspCapabilities {
            definition: capability("definitionProvider"),
            references: capability("referencesProvider"),
            rename_symbol: capability("renameProvider"),
            prepare_rename: self
                .capabilities
                .get("renameProvider")
                .and_then(Value::as_object)
                .and_then(|value| value.get("prepareProvider"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            code_action: capability("codeActionProvider"),
            rename_file: self
                .capabilities
                .pointer("/workspace/fileOperations/willRename")
                .is_some(),
        }
    }

    pub fn is_idle(&self) -> bool {
        self.last_used.elapsed() >= Duration::from_millis(self.limits.idle_ms)
    }

    pub fn is_running(&mut self) -> bool {
        self.process
            .child
            .try_wait()
            .ok()
            .is_some_and(|status| status.is_none())
    }

    pub fn language(&self) -> LspLanguage {
        self.language
    }

    pub fn sync_open_documents(&mut self) -> io::Result<Option<SyncResult>> {
        let paths = self.documents.keys().cloned().collect::<Vec<_>>();
        if paths.is_empty() {
            Ok(None)
        } else {
            self.sync(&paths).map(Some)
        }
    }

    pub fn sync(&mut self, paths: &[String]) -> io::Result<SyncResult> {
        if paths.is_empty() || paths.len() > self.limits.max_edit_files {
            return Err(io::Error::other(
                "sync path batch is empty or exceeds limit",
            ));
        }
        let mut seen = BTreeSet::new();
        let mut changed = false;
        for relative in paths {
            if !seen.insert(relative.clone()) {
                return Err(io::Error::other("duplicate sync path"));
            }
            let path = resolve_relative(&self.repository, relative)?;
            if LspLanguage::from_path(&path) != Some(self.language) {
                return Err(io::Error::other("sync path language does not match server"));
            }
            let text = fs::read_to_string(&path)?;
            let sha256 = hash(text.as_bytes());
            let uri = path_to_uri(&path);
            match self.documents.get_mut(relative) {
                Some(document) if document.sha256 != sha256 => {
                    changed = true;
                    document.version = document.version.saturating_add(1);
                    document.sha256 = sha256;
                    document.text = text.clone();
                    self.diagnostics.remove(relative);
                    self.diagnostic_fallbacks.remove(relative);
                    self.process.notify(
                        "textDocument/didChange",
                        json!({"textDocument": {"uri": uri, "version": document.version}, "contentChanges": [{"text": text}]}),
                    )?;
                }
                Some(_) => {}
                None => {
                    changed = true;
                    self.documents.insert(
                        relative.clone(),
                        Document {
                            version: 1,
                            sha256,
                            text: text.clone(),
                        },
                    );
                    self.process.notify(
                        "textDocument/didOpen",
                        json!({"textDocument": {"uri": uri, "languageId": self.language.language_id(), "version": 1, "text": text}}),
                    )?;
                }
            }
        }
        self.last_used = Instant::now();
        if changed {
            self.batch_diagnostics()?;
        }
        let documents = paths
            .iter()
            .filter_map(|path| {
                self.documents.get(path).map(|document| {
                    (
                        path.clone(),
                        DocumentVersion {
                            version: document.version,
                            sha256: document.sha256.clone(),
                        },
                    )
                })
            })
            .collect::<BTreeMap<_, _>>();
        let diagnostics = paths
            .iter()
            .filter_map(|path| {
                self.diagnostics
                    .get(path)
                    .cloned()
                    .map(|value| (path.clone(), value))
            })
            .collect();
        let diagnostic_fallbacks = paths
            .iter()
            .filter_map(|path| {
                self.diagnostic_fallbacks
                    .get(path)
                    .cloned()
                    .map(|value| (path.clone(), value))
            })
            .collect();
        Ok(SyncResult {
            schema: LSP_RESULT_SCHEMA,
            candidate_sha256: candidate_hash(&documents),
            documents,
            diagnostics,
            diagnostic_fallbacks,
        })
    }

    pub fn definition(
        &mut self,
        path: &str,
        position: LspPosition,
    ) -> Result<Value, SemanticFallback> {
        self.position_request(
            SemanticOperation::Definition,
            "definitionProvider",
            "textDocument/definition",
            path,
            position,
            None,
        )
    }

    pub fn references(
        &mut self,
        path: &str,
        position: LspPosition,
        include_declaration: bool,
    ) -> Result<Value, SemanticFallback> {
        self.position_request(
            SemanticOperation::References,
            "referencesProvider",
            "textDocument/references",
            path,
            position,
            Some(json!({"includeDeclaration": include_declaration})),
        )
    }

    pub fn code_actions(&mut self, path: &str, range: LspRange) -> Result<Value, SemanticFallback> {
        if !self.capabilities().code_action {
            return Err(SemanticFallback::new(
                SemanticOperation::CodeAction,
                "server does not advertise code actions",
            ));
        }
        self.ensure_synced(path, SemanticOperation::CodeAction)?;
        let uri = self.uri(path, SemanticOperation::CodeAction)?;
        let diagnostics = self
            .diagnostics
            .get(path)
            .and_then(|value| value.get("diagnostics"))
            .cloned()
            .unwrap_or_else(|| json!([]));
        self.last_used = Instant::now();
        self.process
            .request(
                "textDocument/codeAction",
                json!({"textDocument": {"uri": uri}, "range": range, "context": {"diagnostics": diagnostics}}),
                Duration::from_millis(self.limits.request_ms),
            )
            .map_err(|error| SemanticFallback::new(SemanticOperation::CodeAction, error.to_string()))
    }

    pub fn rename_symbol(
        &mut self,
        path: &str,
        position: LspPosition,
        new_name: &str,
        scope: &[String],
        expected: &BTreeMap<String, Option<String>>,
    ) -> Result<AppliedEdit, SemanticFallback> {
        if new_name.is_empty() || new_name.len() > 512 {
            return Err(SemanticFallback::new(
                SemanticOperation::RenameSymbol,
                "new symbol name is empty or exceeds limit",
            ));
        }
        let capabilities = self.capabilities();
        if !capabilities.rename_symbol {
            return Err(SemanticFallback::new(
                SemanticOperation::RenameSymbol,
                "server does not advertise symbol rename",
            ));
        }
        self.ensure_synced(path, SemanticOperation::RenameSymbol)?;
        let uri = self.uri(path, SemanticOperation::RenameSymbol)?;
        if capabilities.prepare_rename {
            let prepared = self
                .process
                .request(
                    "textDocument/prepareRename",
                    json!({"textDocument": {"uri": uri}, "position": position}),
                    Duration::from_millis(self.limits.request_ms),
                )
                .map_err(|error| {
                    SemanticFallback::new(SemanticOperation::RenameSymbol, error.to_string())
                })?;
            if prepared.is_null() {
                return Err(SemanticFallback::new(
                    SemanticOperation::RenameSymbol,
                    "server rejected rename at this position",
                ));
            }
        }
        let edit = self
            .process
            .request(
                "textDocument/rename",
                json!({"textDocument": {"uri": uri}, "position": position, "newName": new_name}),
                Duration::from_millis(self.limits.request_ms),
            )
            .map_err(|error| {
                SemanticFallback::new(SemanticOperation::RenameSymbol, error.to_string())
            })?;
        if edit.is_null() {
            return Err(SemanticFallback::new(
                SemanticOperation::RenameSymbol,
                "server returned no rename edit",
            ));
        }
        self.apply_workspace_edit(SemanticOperation::RenameSymbol, &edit, scope, expected)
    }

    pub fn rename_file(
        &mut self,
        old_path: &str,
        new_path: &str,
        scope: &[String],
        expected: &BTreeMap<String, Option<String>>,
    ) -> Result<AppliedEdit, SemanticFallback> {
        if !self.capabilities().rename_file {
            return Err(SemanticFallback::new(
                SemanticOperation::RenameFile,
                "server does not advertise workspace file rename support",
            ));
        }
        let old = resolve_relative(&self.repository, old_path).map_err(|error| {
            SemanticFallback::new(SemanticOperation::RenameFile, error.to_string())
        })?;
        let new = resolve_relative_for_create(&self.repository, new_path).map_err(|error| {
            SemanticFallback::new(SemanticOperation::RenameFile, error.to_string())
        })?;
        let backups = capture_files(&self.repository, scope).map_err(|error| {
            SemanticFallback::new(SemanticOperation::RenameFile, error.to_string())
        })?;
        let edit = self
            .process
            .request(
                "workspace/willRenameFiles",
                json!({"files": [{"oldUri": path_to_uri(&old), "newUri": path_to_uri(&new)}]}),
                Duration::from_millis(self.limits.request_ms),
            )
            .map_err(|error| {
                SemanticFallback::new(SemanticOperation::RenameFile, error.to_string())
            })?;
        let mut combined = if edit.is_null() {
            json!({"documentChanges": []})
        } else {
            edit
        };
        let changes = combined
            .as_object_mut()
            .and_then(|object| {
                object
                    .entry("documentChanges")
                    .or_insert_with(|| json!([]))
                    .as_array_mut()
            })
            .ok_or_else(|| {
                SemanticFallback::new(
                    SemanticOperation::RenameFile,
                    "invalid file rename workspace edit",
                )
            })?;
        changes.push(
            json!({"kind": "rename", "oldUri": path_to_uri(&old), "newUri": path_to_uri(&new)}),
        );
        let applied =
            self.apply_workspace_edit(SemanticOperation::RenameFile, &combined, scope, expected)?;
        if let Err(error) = self.process.notify(
            "workspace/didRenameFiles",
            json!({"files": [{"oldUri": path_to_uri(&old), "newUri": path_to_uri(&new)}]}),
        ) {
            let rollback = self.rollback_synchronized_edit(scope, &backups);
            let reason = rollback.map_or_else(
                |rollback| format!("language server synchronization failed: {error}; rollback failed: {rollback}"),
                |()| format!("language server synchronization failed: {error}; filesystem edit rolled back"),
            );
            return Err(SemanticFallback::new(SemanticOperation::RenameFile, reason));
        }
        Ok(applied)
    }

    pub fn apply_code_action(
        &mut self,
        action: &Value,
        scope: &[String],
        expected: &BTreeMap<String, Option<String>>,
    ) -> Result<AppliedEdit, SemanticFallback> {
        let mut resolved = action.clone();
        if resolved.get("edit").is_none()
            && self
                .capabilities
                .pointer("/codeActionProvider/resolveProvider")
                .and_then(Value::as_bool)
                .unwrap_or(false)
        {
            resolved = self
                .process
                .request(
                    "codeAction/resolve",
                    resolved,
                    Duration::from_millis(self.limits.request_ms),
                )
                .map_err(|error| {
                    SemanticFallback::new(SemanticOperation::CodeAction, error.to_string())
                })?;
        }
        if resolved.get("command").is_some() {
            return Err(SemanticFallback::new(
                SemanticOperation::CodeAction,
                "code actions containing commands are not executed",
            ));
        }
        let edit = resolved.get("edit").ok_or_else(|| {
            SemanticFallback::new(
                SemanticOperation::CodeAction,
                "code action has no workspace edit",
            )
        })?;
        self.apply_workspace_edit(SemanticOperation::CodeAction, edit, scope, expected)
    }

    fn position_request(
        &mut self,
        operation: SemanticOperation,
        capability: &str,
        method: &str,
        path: &str,
        position: LspPosition,
        context: Option<Value>,
    ) -> Result<Value, SemanticFallback> {
        if !self
            .capabilities
            .get(capability)
            .is_some_and(|value| value == true || value.is_object())
        {
            return Err(SemanticFallback::new(
                operation,
                format!("server does not advertise {capability}"),
            ));
        }
        self.ensure_synced(path, operation.clone())?;
        let uri = self.uri(path, operation.clone())?;
        let mut params = json!({"textDocument": {"uri": uri}, "position": position});
        if let Some(context) = context {
            params["context"] = context;
        }
        self.last_used = Instant::now();
        self.process
            .request(
                method,
                params,
                Duration::from_millis(self.limits.request_ms),
            )
            .map_err(|error| SemanticFallback::new(operation, error.to_string()))
    }

    fn ensure_synced(
        &mut self,
        path: &str,
        operation: SemanticOperation,
    ) -> Result<(), SemanticFallback> {
        let actual = resolve_relative(&self.repository, path)
            .and_then(fs::read)
            .map(|bytes| hash(&bytes))
            .map_err(|error| SemanticFallback::new(operation.clone(), error.to_string()))?;
        if self
            .documents
            .get(path)
            .is_none_or(|document| document.sha256 != actual)
        {
            return Err(SemanticFallback::new(
                operation,
                "document is not synchronized to its current bytes; call sync after the coherent write batch",
            ));
        }
        Ok(())
    }

    fn uri(&self, path: &str, operation: SemanticOperation) -> Result<String, SemanticFallback> {
        resolve_relative(&self.repository, path)
            .map(|path| path_to_uri(&path))
            .map_err(|error| SemanticFallback::new(operation, error.to_string()))
    }

    fn batch_diagnostics(&mut self) -> io::Result<()> {
        let quiet = Duration::from_millis(self.limits.diagnostic_batch_ms);
        let deadline = Instant::now() + Duration::from_millis(self.limits.request_ms);
        loop {
            let now = Instant::now();
            if now >= deadline {
                break;
            }
            let wait = quiet.min(deadline.saturating_duration_since(now));
            match self.process.receive(wait) {
                Ok(Some(message)) => self.handle_message(message)?,
                Ok(None) => break,
                Err(error) if error.kind() == io::ErrorKind::TimedOut => break,
                Err(error) => return Err(error),
            }
        }
        Ok(())
    }

    fn handle_message(&mut self, message: Value) -> io::Result<()> {
        if message.get("method").and_then(Value::as_str) == Some("textDocument/publishDiagnostics")
        {
            let Some(params) = message.get("params") else {
                return Ok(());
            };
            let Some(uri) = params.get("uri").and_then(Value::as_str) else {
                return Ok(());
            };
            if let Ok(path) = uri_to_relative(&self.repository, uri) {
                match params.get("version").and_then(Value::as_i64) {
                    Some(version)
                        if self
                            .documents
                            .get(&path)
                            .is_some_and(|document| document.version == version) =>
                    {
                        self.diagnostic_fallbacks.remove(&path);
                        self.diagnostics.insert(path, params.clone());
                    }
                    Some(_) => {}
                    None => {
                        self.diagnostics.remove(&path);
                        self.diagnostic_fallbacks.insert(
                            path,
                            "server omitted the document version; use an input-bound intermediate check and do not claim fresh LSP diagnostics"
                                .into(),
                        );
                    }
                }
            }
        }
        Ok(())
    }

    fn apply_workspace_edit(
        &mut self,
        operation: SemanticOperation,
        edit: &Value,
        scope: &[String],
        expected: &BTreeMap<String, Option<String>>,
    ) -> Result<AppliedEdit, SemanticFallback> {
        let plan = EditPlan::parse(
            &self.repository,
            edit,
            &self.documents,
            &self.limits,
            scope,
            expected,
        )
        .map_err(|error| SemanticFallback::new(operation.clone(), error.to_string()))?;
        let backups = capture_files(&self.repository, scope)
            .map_err(|error| SemanticFallback::new(operation.clone(), error.to_string()))?;
        let applied = plan
            .apply(&self.repository)
            .map_err(|error| SemanticFallback::new(operation.clone(), error.to_string()))?;
        let closed_paths = applied
            .files
            .iter()
            .filter_map(|(path, sha256)| sha256.is_none().then_some(path.clone()))
            .collect::<Vec<_>>();
        let sync_paths = applied
            .files
            .keys()
            .filter(|path| resolve_relative(&self.repository, path).is_ok())
            .cloned()
            .collect::<Vec<_>>();
        let synchronize = (|| -> io::Result<()> {
            for path in &closed_paths {
                if self.documents.contains_key(path) {
                    let resolved = resolve_relative_for_create(&self.repository, path)?;
                    self.process.notify(
                        "textDocument/didClose",
                        json!({"textDocument": {"uri": path_to_uri(&resolved)}}),
                    )?;
                    self.documents.remove(path);
                    self.diagnostics.remove(path);
                    self.diagnostic_fallbacks.remove(path);
                }
            }
            if !sync_paths.is_empty() {
                self.sync(&sync_paths)?;
            }
            Ok(())
        })();
        if let Err(error) = synchronize {
            let rollback = self.rollback_synchronized_edit(scope, &backups);
            let reason = rollback.map_or_else(
                |rollback| format!("language server synchronization failed: {error}; rollback failed: {rollback}"),
                |()| format!("language server synchronization failed: {error}; filesystem edit rolled back"),
            );
            return Err(SemanticFallback::new(operation, reason));
        }
        Ok(applied)
    }

    fn rollback_synchronized_edit(
        &mut self,
        scope: &[String],
        backups: &FileBackups,
    ) -> io::Result<()> {
        for path in scope {
            if self.documents.contains_key(path)
                && let Ok(resolved) = resolve_relative_for_create(&self.repository, path)
            {
                let _ = self.process.notify(
                    "textDocument/didClose",
                    json!({"textDocument": {"uri": path_to_uri(&resolved)}}),
                );
            }
        }
        restore_files(&self.repository, backups)?;
        for path in scope {
            self.documents.remove(path);
            self.diagnostics.remove(path);
            self.diagnostic_fallbacks.remove(path);
        }
        let restored = scope
            .iter()
            .filter(|path| {
                resolve_relative(&self.repository, path)
                    .ok()
                    .is_some_and(|resolved| {
                        LspLanguage::from_path(&resolved) == Some(self.language)
                    })
            })
            .cloned()
            .collect::<Vec<_>>();
        if !restored.is_empty() && self.is_running() {
            self.sync(&restored)?;
        }
        Ok(())
    }
}

impl Drop for LspSession {
    fn drop(&mut self) {
        let _ = self
            .process
            .request("shutdown", Value::Null, Duration::from_millis(500));
        let _ = self.process.notify("exit", Value::Null);
        let _ = self.process.child.kill();
        let _ = self.process.child.wait();
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AppliedEdit {
    pub schema: u32,
    pub candidate_sha256: String,
    pub files: BTreeMap<String, Option<String>>,
}

#[derive(Clone, Debug)]
struct TextEdit {
    range: LspRange,
    text: String,
}

#[derive(Clone, Debug)]
enum FileOperation {
    Rename { old: String, new: String },
}

type FileBackup = Option<(Vec<u8>, fs::Permissions)>;
type FileBackups = BTreeMap<String, FileBackup>;

struct EditPlan {
    writes: BTreeMap<String, String>,
    operations: Vec<FileOperation>,
}

impl EditPlan {
    fn parse(
        repository: &Path,
        edit: &Value,
        documents: &BTreeMap<String, Document>,
        limits: &LspLimits,
        scope: &[String],
        expected: &BTreeMap<String, Option<String>>,
    ) -> io::Result<Self> {
        if scope.is_empty() || scope.len() > limits.max_edit_files {
            return Err(io::Error::other("edit scope is empty or exceeds limit"));
        }
        let scope = scope.iter().cloned().collect::<BTreeSet<_>>();
        if scope.len() != expected.len() || scope.iter().any(|path| !expected.contains_key(path)) {
            return Err(io::Error::other(
                "expected versions must exactly match declared scope",
            ));
        }
        for (path, expected_hash) in expected {
            let resolved = resolve_relative_for_create(repository, path)?;
            let actual = if resolved.exists() {
                Some(hash(&fs::read(&resolved)?))
            } else {
                None
            };
            if &actual != expected_hash {
                return Err(io::Error::other(format!(
                    "stale expected version for {path}"
                )));
            }
        }
        let mut grouped = BTreeMap::<String, Vec<TextEdit>>::new();
        let mut versions = BTreeMap::<String, Option<i64>>::new();
        if let Some(changes) = edit.get("changes").and_then(Value::as_object) {
            for (uri, edits) in changes {
                let path = uri_to_relative(repository, uri)?;
                grouped
                    .entry(path)
                    .or_default()
                    .extend(parse_text_edits(edits)?);
            }
        }
        let mut operations = Vec::new();
        if let Some(changes) = edit.get("documentChanges").and_then(Value::as_array) {
            for change in changes {
                if change.get("kind").and_then(Value::as_str) == Some("rename") {
                    operations.push(FileOperation::Rename {
                        old: uri_to_relative(
                            repository,
                            change
                                .get("oldUri")
                                .and_then(Value::as_str)
                                .ok_or_else(|| io::Error::other("rename oldUri missing"))?,
                        )?,
                        new: uri_to_relative(
                            repository,
                            change
                                .get("newUri")
                                .and_then(Value::as_str)
                                .ok_or_else(|| io::Error::other("rename newUri missing"))?,
                        )?,
                    });
                } else if change.get("kind").is_some() {
                    return Err(io::Error::other(
                        "create/delete workspace operations are unsupported",
                    ));
                } else {
                    let document = change
                        .get("textDocument")
                        .ok_or_else(|| io::Error::other("textDocument edit missing"))?;
                    let path = uri_to_relative(
                        repository,
                        document
                            .get("uri")
                            .and_then(Value::as_str)
                            .ok_or_else(|| io::Error::other("textDocument uri missing"))?,
                    )?;
                    versions.insert(
                        path.clone(),
                        document.get("version").and_then(Value::as_i64),
                    );
                    grouped.entry(path).or_default().extend(parse_text_edits(
                        change
                            .get("edits")
                            .ok_or_else(|| io::Error::other("textDocument edits missing"))?,
                    )?);
                }
            }
        }
        let affected = grouped
            .keys()
            .cloned()
            .chain(operations.iter().flat_map(|operation| match operation {
                FileOperation::Rename { old, new } => [old.clone(), new.clone()],
            }))
            .collect::<BTreeSet<_>>();
        if affected != scope {
            return Err(io::Error::other(
                "workspace edit paths do not exactly match declared scope",
            ));
        }
        if affected.len() > limits.max_edit_files
            || grouped.values().map(Vec::len).sum::<usize>() > limits.max_text_edits
        {
            return Err(io::Error::other(
                "workspace edit exceeds file or text-edit limit",
            ));
        }
        let mut writes = BTreeMap::new();
        for (path, edits) in grouped {
            if let Some(Some(version)) = versions.get(&path)
                && documents.get(&path).map(|document| document.version) != Some(*version)
            {
                return Err(io::Error::other(format!(
                    "stale LSP document version for {path}"
                )));
            }
            let resolved = resolve_relative(repository, &path)?;
            let text = fs::read_to_string(&resolved)?;
            writes.insert(path, apply_text_edits(&text, edits)?);
        }
        Ok(Self { writes, operations })
    }

    fn apply(self, repository: &Path) -> io::Result<AppliedEdit> {
        let mut backup_paths = self.writes.keys().cloned().collect::<BTreeSet<_>>();
        let mut operation_paths = BTreeSet::new();
        for operation in &self.operations {
            match operation {
                FileOperation::Rename { old, new } => {
                    if !operation_paths.insert(old.clone()) || !operation_paths.insert(new.clone())
                    {
                        return Err(io::Error::other(
                            "overlapping file operations are unsupported",
                        ));
                    }
                    let old_path = resolve_relative(repository, old)?;
                    let new_path = resolve_relative_for_create(repository, new)?;
                    if !old_path.is_file() || new_path.exists() {
                        return Err(io::Error::other(
                            "rename source must exist and destination must be absent",
                        ));
                    }
                    backup_paths.insert(old.clone());
                    backup_paths.insert(new.clone());
                }
            }
        }
        let backups = capture_files(repository, &backup_paths.into_iter().collect::<Vec<_>>())?;
        match self.apply_inner(repository) {
            Ok(applied) => Ok(applied),
            Err(error) => match restore_files(repository, &backups) {
                Ok(()) => Err(error),
                Err(rollback) => Err(io::Error::other(format!(
                    "workspace edit failed: {error}; rollback failed: {rollback}"
                ))),
            },
        }
    }

    fn apply_inner(self, repository: &Path) -> io::Result<AppliedEdit> {
        let mut final_files = BTreeMap::new();
        for (relative, text) in &self.writes {
            let path = resolve_relative(repository, relative)?;
            write_atomic(&path, text.as_bytes())?;
            final_files.insert(relative.clone(), Some(hash(text.as_bytes())));
        }
        for operation in self.operations {
            match operation {
                FileOperation::Rename { old, new } => {
                    let old_path = resolve_relative(repository, &old)?;
                    let new_path = resolve_relative_for_create(repository, &new)?;
                    if new_path.exists() {
                        return Err(io::Error::other("rename destination already exists"));
                    }
                    fs::rename(&old_path, &new_path)?;
                    final_files.insert(old, None);
                    final_files.insert(new, Some(hash(&fs::read(new_path)?)));
                }
            }
        }
        Ok(AppliedEdit {
            schema: LSP_RESULT_SCHEMA,
            candidate_sha256: candidate_optional_hash(&final_files),
            files: final_files,
        })
    }
}

fn capture_files(repository: &Path, paths: &[String]) -> io::Result<FileBackups> {
    paths
        .iter()
        .map(|relative| {
            let path = resolve_relative_for_create(repository, relative)?;
            Ok((
                relative.clone(),
                if path.exists() {
                    Some((fs::read(&path)?, fs::metadata(&path)?.permissions()))
                } else {
                    None
                },
            ))
        })
        .collect()
}

fn restore_files(repository: &Path, backups: &FileBackups) -> io::Result<()> {
    for (relative, backup) in backups {
        if backup.is_none() {
            let path = resolve_relative_for_create(repository, relative)?;
            if path.exists() {
                fs::remove_file(path)?;
            }
        }
    }
    for (relative, backup) in backups {
        if let Some((bytes, permissions)) = backup {
            let path = resolve_relative_for_create(repository, relative)?;
            write_atomic_with_permissions(&path, bytes, permissions.clone())?;
        }
    }
    Ok(())
}

fn parse_text_edits(value: &Value) -> io::Result<Vec<TextEdit>> {
    let edits = value
        .as_array()
        .ok_or_else(|| io::Error::other("text edits must be an array"))?;
    edits
        .iter()
        .map(|edit| {
            Ok(TextEdit {
                range: serde_json::from_value(
                    edit.get("range")
                        .cloned()
                        .ok_or_else(|| io::Error::other("text edit range missing"))?,
                )?,
                text: edit
                    .get("newText")
                    .and_then(Value::as_str)
                    .ok_or_else(|| io::Error::other("text edit newText missing"))?
                    .to_string(),
            })
        })
        .collect()
}

fn apply_text_edits(text: &str, edits: Vec<TextEdit>) -> io::Result<String> {
    let mut positioned = edits
        .into_iter()
        .map(|edit| {
            let start = utf16_position_to_byte(text, &edit.range.start)?;
            let end = utf16_position_to_byte(text, &edit.range.end)?;
            if start > end {
                return Err(io::Error::other("text edit range is reversed"));
            }
            Ok((start, end, edit.text))
        })
        .collect::<io::Result<Vec<_>>>()?;
    positioned.sort_by_key(|(start, end, _)| (*start, *end));
    if positioned.windows(2).any(|pair| pair[0].1 > pair[1].0) {
        return Err(io::Error::other("overlapping text edits are unsupported"));
    }
    let mut output = text.to_string();
    for (start, end, replacement) in positioned.into_iter().rev() {
        output.replace_range(start..end, &replacement);
    }
    Ok(output)
}

fn utf16_position_to_byte(text: &str, position: &LspPosition) -> io::Result<usize> {
    let line_start = if position.line == 0 {
        0
    } else {
        text.match_indices('\n')
            .nth(position.line as usize - 1)
            .map(|(index, _)| index + 1)
            .ok_or_else(|| io::Error::other("LSP line exceeds document"))?
    };
    let line_end = text[line_start..]
        .find('\n')
        .map_or(text.len(), |offset| line_start + offset);
    let line = &text[line_start..line_end];
    let mut units = 0_u32;
    for (offset, character) in line.char_indices() {
        if units == position.character {
            return Ok(line_start + offset);
        }
        units = units.saturating_add(character.len_utf16() as u32);
        if units > position.character {
            return Err(io::Error::other("LSP position splits a UTF-16 character"));
        }
    }
    if units == position.character {
        Ok(line_end)
    } else {
        Err(io::Error::other("LSP character exceeds line"))
    }
}

struct RpcProcess {
    child: Child,
    stdin: ChildStdin,
    receiver: mpsc::Receiver<io::Result<Value>>,
    next_id: u64,
}

impl RpcProcess {
    fn spawn(
        executable: &Path,
        arguments: &[String],
        repository: &Path,
        max_response_bytes: usize,
    ) -> io::Result<Self> {
        let mut child = Command::new(executable)
            .args(arguments)
            .current_dir(repository)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("language server stdin missing"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| io::Error::other("language server stdout missing"))?;
        let (sender, receiver) = mpsc::sync_channel(128);
        std::thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let result = read_rpc_message(&mut reader, max_response_bytes);
                let terminal = result.is_err();
                if sender.send(result).is_err() || terminal {
                    break;
                }
            }
        });
        Ok(Self {
            child,
            stdin,
            receiver,
            next_id: 1,
        })
    }

    fn notify(&mut self, method: &str, params: Value) -> io::Result<()> {
        self.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}))
    }

    fn request(&mut self, method: &str, params: Value, timeout: Duration) -> io::Result<Value> {
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1);
        self.send(&json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params}))?;
        let deadline = Instant::now() + timeout;
        loop {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                let _ = self.child.kill();
                return Err(io::Error::new(
                    io::ErrorKind::TimedOut,
                    "language server request timed out",
                ));
            }
            let message = match self.receiver.recv_timeout(remaining) {
                Ok(message) => message?,
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let _ = self.child.kill();
                    return Err(io::Error::new(
                        io::ErrorKind::TimedOut,
                        "language server request timed out",
                    ));
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(io::Error::other("language server stopped"));
                }
            };
            if message.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(error) = message.get("error") {
                    return Err(io::Error::other(format!("language server error: {error}")));
                }
                return Ok(message.get("result").cloned().unwrap_or(Value::Null));
            }
            if let Some(server_id) = message.get("id").cloned()
                && message.get("method").is_some()
            {
                self.send(&json!({"jsonrpc": "2.0", "id": server_id, "result": default_server_request_result(&message)}))?;
            }
        }
    }

    fn receive(&mut self, timeout: Duration) -> io::Result<Option<Value>> {
        match self.receiver.recv_timeout(timeout) {
            Ok(result) => result.map(Some),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                Err(io::Error::other("language server stopped"))
            }
        }
    }

    fn send(&mut self, message: &Value) -> io::Result<()> {
        let bytes = serde_json::to_vec(message)?;
        write!(self.stdin, "Content-Length: {}\r\n\r\n", bytes.len())?;
        self.stdin.write_all(&bytes)?;
        self.stdin.flush()
    }
}

impl Drop for RpcProcess {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn default_server_request_result(message: &Value) -> Value {
    match message.get("method").and_then(Value::as_str) {
        Some("workspace/configuration") => message
            .pointer("/params/items")
            .and_then(Value::as_array)
            .map_or_else(
                || json!([]),
                |items| Value::Array(items.iter().map(|_| Value::Null).collect()),
            ),
        Some("workspace/applyEdit") => {
            json!({"applied": false, "failureReason": "server-initiated edits require an explicit scoped omd_lsp request"})
        }
        _ => Value::Null,
    }
}

fn read_rpc_message(reader: &mut impl BufRead, max_response_bytes: usize) -> io::Result<Value> {
    let mut content_length = None;
    loop {
        let mut line = String::new();
        if reader.read_line(&mut line)? == 0 {
            return Err(io::Error::new(
                io::ErrorKind::UnexpectedEof,
                "language server closed stdout",
            ));
        }
        if line == "\r\n" || line == "\n" {
            break;
        }
        if let Some(value) = line.strip_prefix("Content-Length:") {
            content_length = Some(value.trim().parse::<usize>().map_err(io::Error::other)?);
        }
    }
    let length = content_length
        .ok_or_else(|| io::Error::other("language server response has no content length"))?;
    if length == 0 || length > max_response_bytes {
        return Err(io::Error::other("language server response exceeds limit"));
    }
    let mut bytes = vec![0; length];
    reader.read_exact(&mut bytes)?;
    serde_json::from_slice(&bytes).map_err(io::Error::other)
}

fn bound_workspace(repository: &Path, limits: &LspLimits) -> io::Result<()> {
    let mut stack = vec![repository.to_path_buf()];
    let mut files = 0_usize;
    let mut bytes = 0_usize;
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name();
            if path.is_dir() {
                if !matches!(
                    name.to_str(),
                    Some(
                        ".git"
                            | ".omd"
                            | "target"
                            | "node_modules"
                            | ".venv"
                            | "venv"
                            | "build"
                            | "dist"
                    )
                ) {
                    stack.push(path);
                }
            } else if LspLanguage::from_path(&path).is_some() {
                files = files.saturating_add(1);
                bytes = bytes.saturating_add(entry.metadata()?.len() as usize);
                if files > limits.max_workspace_files || bytes > limits.max_workspace_bytes {
                    return Err(io::Error::other(
                        "language-server workspace exceeds configured bounds",
                    ));
                }
            }
        }
    }
    Ok(())
}

fn resolve_relative(repository: &Path, relative: &str) -> io::Result<PathBuf> {
    let path = resolve_relative_for_create(repository, relative)?;
    let canonical = path.canonicalize()?;
    if !canonical.starts_with(repository) || canonical != path {
        return Err(io::Error::other(
            "path escapes repository or traverses a symlink",
        ));
    }
    Ok(canonical)
}

fn resolve_relative_for_create(repository: &Path, relative: &str) -> io::Result<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(io::Error::other(
            "path must be a normalized repository-relative path",
        ));
    }
    let path = repository.join(relative);
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("path parent missing"))?;
    let canonical_parent = parent.canonicalize()?;
    if canonical_parent != parent || !canonical_parent.starts_with(repository) {
        return Err(io::Error::other(
            "path parent escapes repository or traverses a symlink",
        ));
    }
    Ok(path)
}

fn uri_to_relative(repository: &Path, uri: &str) -> io::Result<String> {
    let encoded = uri
        .strip_prefix("file://")
        .ok_or_else(|| io::Error::other("only file URIs are supported"))?;
    let decoded = percent_decode(encoded)?;
    let path = PathBuf::from(decoded);
    let relative = path
        .strip_prefix(repository)
        .map_err(|_| io::Error::other("language server edit escapes repository"))?;
    let relative = relative
        .to_str()
        .ok_or_else(|| io::Error::other("non-UTF-8 paths are unsupported"))?
        .replace('\\', "/");
    resolve_relative_for_create(repository, &relative)?;
    Ok(relative)
}

fn path_to_uri(path: &Path) -> String {
    let text = path.to_string_lossy();
    let mut output = String::from("file://");
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || matches!(byte, b'/' | b'-' | b'_' | b'.' | b'~') {
            output.push(byte as char);
        } else {
            output.push_str(&format!("%{byte:02X}"));
        }
    }
    output
}

fn percent_decode(value: &str) -> io::Result<String> {
    let bytes = value.as_bytes();
    let mut output = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            if index + 2 >= bytes.len() {
                return Err(io::Error::other("invalid file URI escape"));
            }
            let pair =
                std::str::from_utf8(&bytes[index + 1..index + 3]).map_err(io::Error::other)?;
            output.push(u8::from_str_radix(pair, 16).map_err(io::Error::other)?);
            index += 3;
        } else {
            output.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(output).map_err(io::Error::other)
}

fn write_atomic(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let permissions = fs::metadata(path)?.permissions();
    write_atomic_with_permissions(path, bytes, permissions)
}

fn write_atomic_with_permissions(
    path: &Path,
    bytes: &[u8],
    permissions: fs::Permissions,
) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::other("write parent missing"))?;
    let name = path
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| io::Error::other("invalid write path"))?;
    let temporary = parent.join(format!(".{name}.omd-lsp-{}", std::process::id()));
    fs::write(&temporary, bytes)?;
    fs::set_permissions(&temporary, permissions)?;
    fs::rename(temporary, path)
}

pub fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn candidate_hash(documents: &BTreeMap<String, DocumentVersion>) -> String {
    let value = documents
        .iter()
        .map(|(path, version)| (path, &version.sha256))
        .collect::<Vec<_>>();
    hash(&serde_json::to_vec(&value).expect("serializable candidate versions"))
}

fn candidate_optional_hash(files: &BTreeMap<String, Option<String>>) -> String {
    hash(&serde_json::to_vec(files).expect("serializable candidate versions"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_positions_and_non_overlapping_edits_are_exact() {
        let text = "a😀b\nnext\n";
        let output = apply_text_edits(
            text,
            vec![
                TextEdit {
                    range: LspRange {
                        start: LspPosition {
                            line: 0,
                            character: 1,
                        },
                        end: LspPosition {
                            line: 0,
                            character: 3,
                        },
                    },
                    text: "x".into(),
                },
                TextEdit {
                    range: LspRange {
                        start: LspPosition {
                            line: 1,
                            character: 0,
                        },
                        end: LspPosition {
                            line: 1,
                            character: 4,
                        },
                    },
                    text: "done".into(),
                },
            ],
        )
        .unwrap();
        assert_eq!(output, "axb\ndone\n");
        assert!(
            utf16_position_to_byte(
                text,
                &LspPosition {
                    line: 0,
                    character: 2
                }
            )
            .is_err()
        );
    }

    #[test]
    fn preference_is_repository_bound_and_monotonic() {
        let temporary = tempfile::tempdir().unwrap();
        let path = temporary.path().join("lsp.json");
        let mut store = LspPreferenceStore::open(path.clone()).unwrap();
        assert!(store.preference("owner/repo").is_none());
        assert_eq!(store.set("owner/repo".into(), true).unwrap().revision, 1);
        assert_eq!(store.set("owner/repo".into(), false).unwrap().revision, 2);
        let reopened = LspPreferenceStore::open(path).unwrap();
        assert!(!reopened.preference("owner/repo").unwrap().enabled);
    }

    #[test]
    fn edit_scope_and_expected_hashes_fail_closed() {
        let temporary = tempfile::tempdir().unwrap();
        let repository = temporary.path().canonicalize().unwrap();
        fs::write(repository.join("a.rs"), "fn old() {}\n").unwrap();
        let edit = json!({"changes": {
            path_to_uri(&repository.join("a.rs")): [{"range": {"start": {"line": 0, "character": 3}, "end": {"line": 0, "character": 6}}, "newText": "new"}]
        }});
        let limits = LspLimits::default();
        let expected = BTreeMap::from([("a.rs".into(), Some(hash(b"wrong")))]);
        assert!(
            EditPlan::parse(
                &repository,
                &edit,
                &BTreeMap::new(),
                &limits,
                &["a.rs".into()],
                &expected
            )
            .is_err()
        );
        let expected = BTreeMap::from([("a.rs".into(), Some(hash(b"fn old() {}\n")))]);
        let plan = EditPlan::parse(
            &repository,
            &edit,
            &BTreeMap::new(),
            &limits,
            &["a.rs".into()],
            &expected,
        )
        .unwrap();
        let applied = plan.apply(&repository).unwrap();
        assert_eq!(
            fs::read_to_string(repository.join("a.rs")).unwrap(),
            "fn new() {}\n"
        );
        assert_eq!(applied.files.len(), 1);
    }

    #[test]
    fn file_uri_round_trip_stays_in_repository() {
        let temporary = tempfile::tempdir().unwrap();
        let repository = temporary.path().canonicalize().unwrap();
        let path = repository.join("space name.rs");
        fs::write(&path, "").unwrap();
        assert_eq!(
            uri_to_relative(&repository, &path_to_uri(&path)).unwrap(),
            "space name.rs"
        );
        assert!(uri_to_relative(&repository, "file:///tmp/outside.rs").is_err());
    }

    #[test]
    fn five_language_protocol_matrix_is_version_and_scope_bound() {
        let Some(python) = resolve_executable("python3") else {
            return;
        };
        for (language, extension) in [
            (LspLanguage::Rust, "rs"),
            (LspLanguage::TypeScript, "ts"),
            (LspLanguage::JavaScript, "js"),
            (LspLanguage::Python, "py"),
            (LspLanguage::Java, "java"),
        ] {
            let temporary = tempfile::tempdir().unwrap();
            let repository = temporary.path().canonicalize().unwrap();
            let first = format!("a.{extension}");
            let second = format!("b.{extension}");
            fs::write(repository.join(&first), "old one\n").unwrap();
            fs::write(repository.join(&second), "old two\n").unwrap();
            let server = InstalledServer {
                language,
                executable: Some(python.clone()),
                arguments: vec!["-u".into(), "-c".into(), FAKE_SERVER.into()],
            };
            let limits = LspLimits {
                startup_ms: 2_000,
                request_ms: 2_000,
                diagnostic_batch_ms: 25,
                idle_ms: 3_000,
                ..LspLimits::default()
            };
            let mut session =
                LspSession::start(repository.clone(), language, limits, Some(server)).unwrap();
            let sync = session.sync(&[first.clone(), second.clone()]).unwrap();
            assert_eq!(sync.documents.len(), 2);
            assert!(sync.diagnostics.contains_key(&first));
            assert!(session.capabilities().rename_file);
            assert!(
                !session
                    .definition(
                        &first,
                        LspPosition {
                            line: 0,
                            character: 0
                        }
                    )
                    .unwrap()
                    .is_null()
            );
            assert!(
                session
                    .references(
                        &first,
                        LspPosition {
                            line: 0,
                            character: 0
                        },
                        true,
                    )
                    .unwrap()
                    .is_array()
            );
            let actions = session
                .code_actions(
                    &first,
                    LspRange {
                        start: LspPosition {
                            line: 0,
                            character: 0,
                        },
                        end: LspPosition {
                            line: 0,
                            character: 3,
                        },
                    },
                )
                .unwrap();
            let action = actions.as_array().unwrap().first().unwrap();
            let action_expected = BTreeMap::from([(
                first.clone(),
                Some(hash(&fs::read(repository.join(&first)).unwrap())),
            )]);
            session
                .apply_code_action(action, std::slice::from_ref(&first), &action_expected)
                .unwrap();
            assert_eq!(
                fs::read_to_string(repository.join(&first)).unwrap(),
                "old uno\n"
            );
            assert!(
                session
                    .apply_code_action(
                        &json!({"title": "unsafe", "command": {"title": "run", "command": "run"}}),
                        std::slice::from_ref(&first),
                        &action_expected,
                    )
                    .is_err()
            );
            let expected = BTreeMap::from([
                (
                    first.clone(),
                    Some(hash(&fs::read(repository.join(&first)).unwrap())),
                ),
                (
                    second.clone(),
                    Some(hash(&fs::read(repository.join(&second)).unwrap())),
                ),
            ]);
            let applied = session
                .rename_symbol(
                    &first,
                    LspPosition {
                        line: 0,
                        character: 1,
                    },
                    "new",
                    &[first.clone(), second.clone()],
                    &expected,
                )
                .unwrap();
            assert_eq!(applied.files.len(), 2);
            assert_eq!(
                fs::read_to_string(repository.join(&first)).unwrap(),
                "new uno\n"
            );
            assert_eq!(
                fs::read_to_string(repository.join(&second)).unwrap(),
                "new two\n"
            );
            fs::write(repository.join(&first), "new changed\n").unwrap();
            let sync = session.sync(std::slice::from_ref(&first)).unwrap();
            assert_eq!(sync.documents[&first].version, 4);
            assert!(!sync.diagnostics.contains_key(&first));
            assert!(sync.diagnostic_fallbacks.contains_key(&first));
            let renamed = format!("renamed.{extension}");
            let expected = BTreeMap::from([
                (
                    second.clone(),
                    Some(hash(&fs::read(repository.join(&second)).unwrap())),
                ),
                (renamed.clone(), None),
            ]);
            session
                .rename_file(
                    &second,
                    &renamed,
                    &[second.clone(), renamed.clone()],
                    &expected,
                )
                .unwrap();
            assert!(!repository.join(second).exists());
            assert!(repository.join(renamed).exists());
        }
    }

    #[test]
    fn unavailable_server_has_an_explicit_non_success_fallback() {
        let temporary = tempfile::tempdir().unwrap();
        let repository = temporary.path().canonicalize().unwrap();
        fs::write(repository.join("main.java"), "class Main {}\n").unwrap();
        let fallback = LspSession::start(
            repository,
            LspLanguage::Java,
            LspLimits::default(),
            Some(InstalledServer {
                language: LspLanguage::Java,
                executable: None,
                arguments: Vec::new(),
            }),
        )
        .err()
        .unwrap();
        assert_eq!(fallback.status, "unsupported");
        assert!(
            fallback
                .reason
                .contains("no installed java language server")
        );
        assert!(fallback.fallback.contains("ordinary scoped edits"));
    }

    #[test]
    fn failed_post_edit_synchronization_rolls_back_filesystem_change() {
        let Some(python) = resolve_executable("python3") else {
            return;
        };
        let temporary = tempfile::tempdir().unwrap();
        let repository = temporary.path().canonicalize().unwrap();
        fs::write(repository.join("main.py"), "old = 1\n").unwrap();
        let server = InstalledServer {
            language: LspLanguage::Python,
            executable: Some(python),
            arguments: vec!["-u".into(), "-c".into(), FAILING_SYNC_SERVER.into()],
        };
        let limits = LspLimits {
            startup_ms: 2_000,
            request_ms: 2_000,
            diagnostic_batch_ms: 25,
            idle_ms: 3_000,
            ..LspLimits::default()
        };
        let mut session = LspSession::start(
            repository.clone(),
            LspLanguage::Python,
            limits,
            Some(server),
        )
        .unwrap();
        session.sync(&["main.py".into()]).unwrap();
        let expected = BTreeMap::from([(
            "main.py".into(),
            Some(hash(&fs::read(repository.join("main.py")).unwrap())),
        )]);
        let fallback = session
            .rename_symbol(
                "main.py",
                LspPosition {
                    line: 0,
                    character: 1,
                },
                "new",
                &["main.py".into()],
                &expected,
            )
            .unwrap_err();
        assert!(fallback.reason.contains("filesystem edit rolled back"));
        assert_eq!(
            fs::read_to_string(repository.join("main.py")).unwrap(),
            "old = 1\n"
        );
    }

    #[test]
    fn installed_server_smoke_when_requested() {
        if env::var_os("OMD_TEST_INSTALLED_LSP").is_none() {
            return;
        }
        let servers = detect_installed_servers()
            .into_iter()
            .filter(|server| {
                matches!(server.language, LspLanguage::Rust | LspLanguage::Python)
                    && server.executable.is_some()
            })
            .collect::<Vec<_>>();
        assert!(!servers.is_empty());
        for server in servers {
            let (language, path, content) = match server.language {
                LspLanguage::Rust => (
                    LspLanguage::Rust,
                    "src/lib.rs",
                    "pub fn value() -> u8 { 1 }\n",
                ),
                LspLanguage::Python => (LspLanguage::Python, "main.py", "value: int = 1\n"),
                _ => unreachable!(),
            };
            let temporary = tempfile::tempdir().unwrap();
            if language == LspLanguage::Rust {
                fs::create_dir(temporary.path().join("src")).unwrap();
                fs::write(
                    temporary.path().join("Cargo.toml"),
                    "[package]\nname = \"smoke\"\nversion = \"0.1.0\"\nedition = \"2024\"\n",
                )
                .unwrap();
            }
            fs::write(temporary.path().join(path), content).unwrap();
            let repository = temporary.path().canonicalize().unwrap();
            let limits = LspLimits {
                startup_ms: 20_000,
                request_ms: 20_000,
                diagnostic_batch_ms: 250,
                idle_ms: 30_000,
                ..LspLimits::default()
            };
            let mut session =
                LspSession::start(repository, language, limits, Some(server)).unwrap();
            let synchronized = session.sync(&[path.into()]).unwrap();
            assert_eq!(synchronized.documents.len(), 1);
            let capabilities = session.capabilities();
            assert!(capabilities.definition || capabilities.references);
        }
    }

    const FAKE_SERVER: &str = r#"
import json, sys

def read():
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            raise SystemExit
        if line in (b'\r\n', b'\n'):
            break
        if line.lower().startswith(b'content-length:'):
            length = int(line.split(b':', 1)[1].strip())
    return json.loads(sys.stdin.buffer.read(length))

def send(value):
    body = json.dumps(value, separators=(',', ':')).encode()
    sys.stdout.buffer.write(('Content-Length: %d\r\n\r\n' % len(body)).encode() + body)
    sys.stdout.buffer.flush()

documents = {}
while True:
    message = read()
    method = message.get('method')
    request_id = message.get('id')
    params = message.get('params') or {}
    if method == 'initialize':
        result = {'capabilities': {'definitionProvider': True, 'referencesProvider': True, 'renameProvider': {'prepareProvider': True}, 'codeActionProvider': True, 'workspace': {'fileOperations': {'willRename': {'filters': []}}}}}
    elif method == 'shutdown':
        result = None
    elif method == 'textDocument/definition':
        result = {'uri': params['textDocument']['uri'], 'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 3}}}
    elif method == 'textDocument/references':
        result = [{'uri': params['textDocument']['uri'], 'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 3}}}]
    elif method == 'textDocument/codeAction':
        uri = params['textDocument']['uri']
        result = [{'title': 'Replace one', 'kind': 'quickfix', 'edit': {'changes': {uri: [{'range': {'start': {'line': 0, 'character': 4}, 'end': {'line': 0, 'character': 7}}, 'newText': 'uno'}]}}}]
    elif method == 'textDocument/prepareRename':
        result = {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 3}}
    elif method == 'textDocument/rename':
        root = params['textDocument']['uri'].rsplit('/', 1)[0]
        suffix = params['textDocument']['uri'].rsplit('.', 1)[1]
        result = {'changes': {root + '/a.' + suffix: [{'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 3}}, 'newText': params['newName']}], root + '/b.' + suffix: [{'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 3}}, 'newText': params['newName']}]}}
    elif method == 'workspace/willRenameFiles':
        result = None
    else:
        result = None
    if request_id is not None:
        send({'jsonrpc': '2.0', 'id': request_id, 'result': result})
    if method == 'textDocument/didOpen':
        document = params['textDocument']
        documents[document['uri']] = document['version']
        send({'jsonrpc': '2.0', 'method': 'textDocument/publishDiagnostics', 'params': {'uri': document['uri'], 'version': document['version'], 'diagnostics': [{'severity': 2, 'message': 'fresh'}]}})
    elif method == 'textDocument/didChange':
        document = params['textDocument']
        diagnostic = {'uri': document['uri'], 'diagnostics': [{'severity': 1, 'message': 'unverified'}]}
        if document['version'] < 3:
            diagnostic['version'] = 1
        send({'jsonrpc': '2.0', 'method': 'textDocument/publishDiagnostics', 'params': diagnostic})
"#;

    const FAILING_SYNC_SERVER: &str = r#"
import json, sys

def read():
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            raise SystemExit
        if line in (b'\r\n', b'\n'):
            break
        if line.lower().startswith(b'content-length:'):
            length = int(line.split(b':', 1)[1].strip())
    return json.loads(sys.stdin.buffer.read(length))

def send(value):
    body = json.dumps(value, separators=(',', ':')).encode()
    sys.stdout.buffer.write(('Content-Length: %d\r\n\r\n' % len(body)).encode() + body)
    sys.stdout.buffer.flush()

while True:
    message = read()
    method = message.get('method')
    request_id = message.get('id')
    params = message.get('params') or {}
    if method == 'initialize':
        result = {'capabilities': {'renameProvider': True}}
    elif method == 'textDocument/rename':
        uri = params['textDocument']['uri']
        result = {'changes': {uri: [{'range': {'start': {'line': 0, 'character': 0}, 'end': {'line': 0, 'character': 3}}, 'newText': params['newName']}]}}
    else:
        result = None
    if request_id is not None:
        send({'jsonrpc': '2.0', 'id': request_id, 'result': result})
    if method == 'textDocument/didChange':
        raise SystemExit
"#;
}
