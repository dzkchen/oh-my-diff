use codex_file_system::FileSystemSandboxContext;
use codex_protocol::permissions::FileSystemAccessMode;
use codex_protocol::permissions::FileSystemPath;
use codex_protocol::permissions::FileSystemSandboxEntry;
use codex_protocol::permissions::FileSystemSandboxPolicy;
use codex_protocol::permissions::FileSystemSandboxPolicyContext;
use codex_protocol::permissions::ReadDenyMatcher;
use codex_utils_absolute_path::AbsolutePathBuf;
use codex_utils_path_uri::PathUri;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeSet;
use std::path::PathBuf;

pub(super) struct WorkspaceAuthority {
    pub repository: PathBuf,
    pub session_root: Option<PathBuf>,
    pub session_database: Option<PathBuf>,
    pub policy: FileSystemSandboxPolicy,
    pub context: FileSystemSandboxContext,
}

fn local_context(
    profile: codex_protocol::models::PermissionProfile,
    cwd: PathUri,
) -> Result<FileSystemSandboxContext, String> {
    let mut context = FileSystemSandboxContext::from_permission_profile(profile, cwd);
    context.user_home_dir = PathUri::from_host_native_path("~").ok();
    context.temporary_directories = Some(
        match std::env::var_os("TMPDIR").filter(|path| !path.is_empty()) {
            Some(path) => vec![PathUri::from(
                AbsolutePathBuf::from_absolute_path(PathBuf::from(path))
                    .map_err(|e| e.to_string())?,
            )],
            None => Vec::new(),
        },
    );
    Ok(context)
}

pub(super) async fn workspace_snapshot(lead: &crate::Lead) -> Result<codex_omd::Snapshot, String> {
    let authority = WorkspaceAuthority::for_lead(lead).await?;
    let approved = lead
        .host
        .config
        .approved_untracked
        .iter()
        .cloned()
        .collect();
    let limit = lead.host.config.snapshot_bytes;
    tokio::task::spawn_blocking(move || {
        let snapshot = codex_omd::capture_tracked(&authority.repository, &approved, limit)
            .map_err(|error| error.to_string())?;
        if snapshot
            .files
            .keys()
            .any(|path| !authority.readable(&authority.repository.join(path)))
        {
            return Err("workspace_snapshot_permission_denied".to_owned());
        }
        Ok(snapshot)
    })
    .await
    .map_err(|error| error.to_string())?
}

impl WorkspaceAuthority {
    pub async fn for_call(lead: &crate::Lead, call: &crate::ToolCall<'_>) -> Result<Self, String> {
        let host = &lead.host;
        let manager = host
            .manager
            .upgrade()
            .ok_or("native_thread_manager_stopped")?;
        let config = manager
            .get_thread(lead.thread)
            .await
            .map_err(|e| e.to_string())?
            .config()
            .await;
        let environment = call.environments.as_slice();
        if environment.len() != 1
            || environment[0].environment_id != "local"
            || environment[0].cwd != codex_utils_path_uri::PathUri::from_abs_path(&config.cwd)
            || config.cwd.as_path() != host.repository
        {
            return Err("workspace_operation_requires_local_repository".into());
        }
        let context = environment[0].file_system_sandbox_context.clone();
        let mut roots = context
            .workspace_roots
            .iter()
            .map(codex_utils_path_uri::PathUri::to_abs_path)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|e| e.to_string())?;
        if roots.is_empty() {
            roots.push(config.cwd.clone());
        }
        let configured = config
            .permissions
            .permission_profile()
            .clone()
            .materialize_project_roots_with_workspace_roots(&roots);
        let actual = context
            .permissions
            .clone()
            .materialize_project_roots_with_workspace_roots(&roots);
        let effective = crate::execution::intersect(&configured, &actual, config.cwd.as_path())?;
        let current = lead
            .permission_profile
            .lock()
            .map_err(|_| "permission_profile_poisoned")?
            .clone();
        let effective = crate::execution::intersect(&effective, &current, config.cwd.as_path())?;
        let mut context = context;
        context.permissions = effective.clone();
        Ok(Self {
            repository: host.repository.clone(),
            policy: effective.file_system_sandbox_policy(),
            context,
            session_root: Some(config.codex_home.join("sessions").to_path_buf()),
            session_database: Some(config.sqlite.state_db_path()),
        })
    }

    pub fn readable(&self, path: &std::path::Path) -> bool {
        self.access(path, false)
    }

    pub fn writable(&self, path: &std::path::Path) -> bool {
        self.access(path, true)
    }

    fn access(&self, path: &std::path::Path, write: bool) -> bool {
        let Some(name) = path
            .strip_prefix(&self.repository)
            .ok()
            .and_then(std::path::Path::to_str)
        else {
            return false;
        };
        if !name.is_empty() {
            return self.paths(&[name.to_owned()], write).is_ok();
        }
        let Ok(absolute) = AbsolutePathBuf::from_absolute_path_checked(&self.repository) else {
            return false;
        };
        let context = FileSystemSandboxPolicyContext {
            cwd: &self.context.cwd,
            workspace_roots: &self.context.workspace_roots,
            user_home_dir: self.context.user_home_dir.as_ref(),
            temporary_directories: self.context.temporary_directories.as_deref(),
        };
        let uri = PathUri::from_abs_path(&absolute);
        self.policy.can_read_path(&uri, &context)
            && (!write || self.policy.can_write_path(&uri, &context))
    }

    #[cfg(test)]
    pub fn for_platform(
        repository: &std::path::Path,
        profile: codex_protocol::models::PermissionProfile,
    ) -> Result<Self, String> {
        let absolute = AbsolutePathBuf::from_absolute_path_checked(repository)
            .map_err(|error| error.to_string())?;
        let profile =
            profile.materialize_project_roots_with_workspace_roots(std::slice::from_ref(&absolute));
        let context = FileSystemSandboxContext::from_permission_profile(
            profile.clone(),
            PathUri::from_abs_path(&absolute),
        );
        Ok(Self {
            repository: repository.to_path_buf(),
            session_root: None,
            session_database: None,
            policy: profile.file_system_sandbox_policy(),
            context,
        })
    }

    pub fn visible_changes(
        &self,
        changes: Vec<codex_omd::WorkspaceChange>,
    ) -> Result<Vec<codex_omd::WorkspaceChange>, String> {
        for change in &changes {
            if self
                .paths(std::slice::from_ref(&change.path), false)
                .is_err()
            {
                return Err("workspace_change_scope_unavailable".into());
            }
        }
        Ok(changes)
    }

    pub fn rename_input(
        &self,
        old: &str,
        new: &str,
        active: impl Fn() -> bool,
    ) -> Result<Value, String> {
        self.paths(&[old.to_owned(), new.to_owned()], true)?;
        let read = self.call("workspace.read", json!({"paths":[old,new]}), active)?;
        let source = read["files"][old]["sha256"]
            .as_str()
            .ok_or("rename_source_missing")?;
        if !read["files"][new].is_null() {
            return Err("rename_destination_exists".into());
        }
        let mut expected = serde_json::Map::new();
        expected.insert(old.to_owned(), Value::String(source.to_owned()));
        expected.insert(new.to_owned(), Value::Null);
        Ok(json!({"repository":self.repository,"old":old,"new":new,"expected":expected}))
    }

    pub fn apply_rename_plan(
        &self,
        input: &Value,
        plan: Value,
        active: impl Fn() -> bool,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(tag = "status", rename_all = "snake_case", deny_unknown_fields)]
        enum Plan {
            Ready {
                expected: std::collections::BTreeMap<String, Option<String>>,
                writes: std::collections::BTreeMap<String, String>,
            },
            Fallback {
                reason: String,
            },
        }
        let plan: Plan = serde_json::from_value(plan).map_err(|error| error.to_string())?;
        let Plan::Ready { expected, writes } = plan else {
            let Plan::Fallback { reason } = plan else {
                unreachable!()
            };
            return Ok(
                json!({"status":"fallback","reason":reason.chars().take(512).collect::<String>()}),
            );
        };
        let old = input["old"].as_str().ok_or("rename_old_missing")?;
        let new = input["new"].as_str().ok_or("rename_new_missing")?;
        if expected
            .get(old)
            .and_then(Option::as_ref)
            .map(String::as_str)
            != input["expected"][old].as_str()
            || expected.get(new) != Some(&None)
        {
            return Err("rename_plan_stale_or_unscoped".into());
        }
        let result = self.call(
            "workspace.transaction",
            json!({"expected":expected,"writes":writes,"renames":[{"old":old,"new":new}]}),
            active,
        )?;
        Ok(json!({"status":"renamed","files":result["files"]}))
    }

    pub fn request_rename(
        &self,
        arguments: Value,
        runtime: &mut codex_omd::ModHost,
        processes: &crate::managed_process::ManagedProcesses,
        generation: u64,
        active: impl Fn() -> bool,
    ) -> Result<Value, String> {
        #[derive(Deserialize)]
        #[serde(deny_unknown_fields)]
        struct Input {
            old: String,
            new: String,
        }
        let request: Input =
            serde_json::from_value(arguments).map_err(|error| error.to_string())?;
        let payload = self.rename_input(&request.old, &request.new, &active)?;
        if !runtime.has_event("workspace_pre_rename") {
            return Ok(json!({"status":"fallback","reason":"no_pre_rename_handler"}));
        }
        let proposals = runtime.event_guarded_with(
            "workspace_pre_rename",
            payload.clone(),
            &active,
            |id, call| {
                let result = match call.operation.as_str() {
                    "workspace.read" => self.call(&call.operation, call.arguments, &active),
                    "process.start"
                        if call
                            .arguments
                            .as_object()
                            .is_some_and(|fields| fields.contains_key("network")) =>
                    {
                        Err("pre_rename_operation_unavailable".into())
                    }
                    operation if operation.starts_with("process.") => processes.call(
                        crate::managed_process::ProcessOwner {
                            id,
                            generation,
                            repository: &self.repository,
                            policy: &self.policy,
                            protected: &[],
                            os_access: None,
                        },
                        operation,
                        call.arguments,
                        &active,
                    ),
                    _ => Err("pre_rename_operation_unavailable".into()),
                };
                result.map_err(std::io::Error::other)
            },
        );
        let mut ready = Vec::new();
        let mut fallback = "server_rename_unavailable".to_owned();
        for (_, proposal) in proposals {
            match proposal {
                Ok(value) if value["status"] == "ready" => ready.push(value),
                Ok(value) if value["status"] == "fallback" => {
                    fallback = value["reason"]
                        .as_str()
                        .unwrap_or("server_rename_unavailable")
                        .chars()
                        .take(512)
                        .collect();
                }
                Ok(value) if value.is_null() => (),
                Ok(_) => return Err("invalid_pre_rename_result".into()),
                Err(error) => return Err(format!("pre_rename_handler_failed: {error}")),
            }
        }
        match ready.len() {
            0 => Ok(json!({"status":"fallback","reason":fallback})),
            1 => self.apply_rename_plan(&payload, ready.remove(0), active),
            _ => Err("pre_rename_handler_conflict".into()),
        }
    }

    pub async fn for_lead(lead: &crate::Lead) -> Result<Self, String> {
        let host = &lead.host;
        let manager = host
            .manager
            .upgrade()
            .ok_or("native_thread_manager_stopped")?;
        let config = manager
            .get_thread(lead.thread)
            .await
            .map_err(|error| error.to_string())?
            .config()
            .await;
        if config.cwd.as_path() != host.repository {
            return Err("workspace_operation_requires_local_repository".into());
        }
        let current = lead
            .permission_profile
            .lock()
            .map_err(|_| "permission_profile_poisoned")?
            .clone();
        let profile = crate::execution::intersect(
            &config.permissions.effective_permission_profile(),
            &current,
            config.cwd.as_path(),
        )?
        .materialize_project_roots_with_workspace_roots(std::slice::from_ref(&config.cwd));
        let context = local_context(profile.clone(), PathUri::from_abs_path(&config.cwd))?;
        Ok(Self {
            repository: host.repository.clone(),
            session_root: Some(config.codex_home.join("sessions").to_path_buf()),
            session_database: Some(config.sqlite.state_db_path()),
            policy: profile.file_system_sandbox_policy(),
            context,
        })
    }

    fn paths(&self, names: &[String], write: bool) -> Result<Vec<PathBuf>, String> {
        if names.is_empty()
            || names.len() > 128
            || names.iter().collect::<BTreeSet<_>>().len() != names.len()
        {
            return Err("workspace_path_scope_invalid".into());
        }
        let context = FileSystemSandboxPolicyContext {
            cwd: &self.context.cwd,
            workspace_roots: &self.context.workspace_roots,
            user_home_dir: self.context.user_home_dir.as_ref(),
            temporary_directories: self.context.temporary_directories.as_deref(),
        };
        let deny_read = ReadDenyMatcher::try_new_with_context(&self.policy, &context)?;
        let mut paths = Vec::with_capacity(names.len());
        for name in names {
            let path =
                codex_omd::workspace_path(&self.repository, name).map_err(|e| e.to_string())?;
            let absolute =
                AbsolutePathBuf::from_absolute_path_checked(&path).map_err(|e| e.to_string())?;
            let uri = PathUri::from_abs_path(&absolute);
            let readable = self.policy.can_read_path(&uri, &context)
                && !deny_read
                    .as_ref()
                    .is_some_and(|matcher| matcher.is_read_denied_uri(&uri, &context));
            if !readable || write && !self.policy.can_write_path(&uri, &context) {
                return Err(if write {
                    "workspace_write_permission_denied"
                } else {
                    "workspace_read_permission_denied"
                }
                .into());
            }
            paths.push(path);
        }
        Ok(paths)
    }

    pub fn call(
        &self,
        operation: &str,
        arguments: Value,
        active: impl Fn() -> bool,
    ) -> Result<Value, String> {
        if !active() {
            return Err("workspace_operation_cancelled".into());
        }
        match operation {
            "workspace.read" => {
                #[derive(Deserialize)]
                #[serde(deny_unknown_fields)]
                struct Input {
                    paths: Vec<String>,
                }
                let input: Input = serde_json::from_value(arguments).map_err(|e| e.to_string())?;
                self.paths(&input.paths, false)?;
                let selected = input.paths.into_iter().collect::<BTreeSet<_>>();
                let snapshot =
                    codex_omd::Snapshot::capture(&self.repository, &selected, 4 * 1024 * 1024)
                        .map_err(|e| e.to_string())?;
                let mut files = serde_json::Map::new();
                for name in selected {
                    let value = match snapshot.files.get(&name) {
                        Some(file) => json!({
                            "text": String::from_utf8(file.bytes.clone()).map_err(|_| "workspace_text_not_utf8")?,
                            "sha256": crate::execution::hash(&file.bytes),
                        }),
                        None => Value::Null,
                    };
                    files.insert(name, value);
                }
                Ok(json!({"files": files}))
            }
            "workspace.transaction" => {
                let transaction: codex_omd::WorkspaceTransaction =
                    serde_json::from_value(arguments).map_err(|e| e.to_string())?;
                self.paths(
                    &transaction.expected.keys().cloned().collect::<Vec<_>>(),
                    true,
                )?;
                let result = transaction
                    .apply(&self.repository, active)
                    .map_err(|e| e.to_string())?;
                serde_json::to_value(result).map_err(|e| e.to_string())
            }
            _ => Err("unsupported_workspace_operation".into()),
        }
    }
}

/// Keeps host-written checkout state under `<repository>/.omd/state` read-only for the session.
pub(crate) fn protect_checkout_state(
    policy: &mut FileSystemSandboxPolicy,
    repository: &std::path::Path,
) -> Result<(), String> {
    let path = AbsolutePathBuf::from_absolute_path_checked(repository.join(".omd").join("state"))
        .map_err(|error| error.to_string())?;
    std::fs::create_dir_all(&path).map_err(|error| error.to_string())?;
    policy.entries.push(FileSystemSandboxEntry::new(
        FileSystemPath::Path { path: path.into() },
        FileSystemAccessMode::Read,
    ));
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use codex_protocol::models::PermissionProfile;
    use codex_protocol::permissions::NetworkSandboxPolicy;

    #[test]
    fn checkout_state_stays_read_only_inside_a_writable_repository() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let cwd =
            PathUri::from_abs_path(&AbsolutePathBuf::from_absolute_path_checked(&root).unwrap());
        let mut policy = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry::new(
            FileSystemPath::Path { path: cwd.clone() },
            FileSystemAccessMode::Write,
        )]);
        protect_checkout_state(&mut policy, &root).unwrap();
        let profile =
            PermissionProfile::from_runtime_permissions(&policy, NetworkSandboxPolicy::Restricted);
        codex_protocol::intersect_effective_permission_profiles(&profile, &profile, &root).unwrap();
        let context = FileSystemSandboxContext::from_permission_profile(profile, cwd);
        let authority = WorkspaceAuthority {
            repository: root.clone(),
            session_root: None,
            session_database: None,
            policy,
            context,
        };
        assert!(authority.writable(&root.join("src/app.rs")));
        assert!(authority.readable(&root.join(".omd/state/board.json")));
        assert!(!authority.writable(&root.join(".omd/state/board.json")));
        assert!(authority.writable(&root.join(".omd/session-1/scratch")));
    }

    #[test]
    fn local_snapshot_authority_keeps_temporary_metadata_and_read_denials() {
        use codex_protocol::permissions::FileSystemSpecialPath;
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path().canonicalize().unwrap();
        let absolute = AbsolutePathBuf::from_absolute_path_checked(&root).unwrap();
        let cwd = PathUri::from_abs_path(&absolute);
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry::new(
                FileSystemPath::Special {
                    value: FileSystemSpecialPath::Root,
                },
                FileSystemAccessMode::Read,
            ),
            FileSystemSandboxEntry::new(
                FileSystemPath::Path { path: cwd.clone() },
                FileSystemAccessMode::Write,
            ),
            FileSystemSandboxEntry::new(
                FileSystemPath::Special {
                    value: FileSystemSpecialPath::Tmpdir,
                },
                FileSystemAccessMode::Write,
            ),
            FileSystemSandboxEntry::new(
                FileSystemPath::Path {
                    path: cwd.join("private").unwrap(),
                },
                FileSystemAccessMode::Deny,
            ),
        ]);
        let profile =
            PermissionProfile::from_runtime_permissions(&policy, NetworkSandboxPolicy::Restricted);
        let context = local_context(profile, cwd).unwrap();
        let authority = WorkspaceAuthority {
            repository: root.clone(),
            session_root: None,
            session_database: None,
            policy,
            context,
        };
        assert!(authority.readable(&root.join("source")));
        assert!(!authority.readable(&root.join("private/secret")));
        assert!(authority.writable(&root.join("source")));
    }

    fn authority(repository: PathBuf, access: FileSystemAccessMode) -> WorkspaceAuthority {
        let absolute = AbsolutePathBuf::from_absolute_path_checked(&repository).unwrap();
        let cwd = PathUri::from_abs_path(&absolute);
        let policy = FileSystemSandboxPolicy::restricted(vec![FileSystemSandboxEntry::new(
            FileSystemPath::Path { path: cwd.clone() },
            access,
        )]);
        let profile =
            PermissionProfile::from_runtime_permissions(&policy, NetworkSandboxPolicy::Restricted);
        let context = FileSystemSandboxContext::from_permission_profile(profile, cwd);
        WorkspaceAuthority {
            repository,
            session_root: None,
            session_database: None,
            policy,
            context,
        }
    }

    #[test]
    fn workspace_read_and_transaction_obey_effective_permissions() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(root.join("a.py"), "old\n").unwrap();
        let read_only = authority(root.clone(), FileSystemAccessMode::Read);
        let read = read_only
            .call("workspace.read", json!({"paths":["a.py"]}), || true)
            .unwrap();
        let sha = read["files"]["a.py"]["sha256"].as_str().unwrap();
        assert_eq!(read["files"]["a.py"]["text"], "old\n");
        let edit = json!({"expected":{"a.py":sha},"writes":{"a.py":"new\n"}});
        assert!(
            read_only
                .call("workspace.transaction", edit.clone(), || true)
                .unwrap_err()
                .contains("permission_denied")
        );
        assert_eq!(std::fs::read_to_string(root.join("a.py")).unwrap(), "old\n");
        let writable = authority(root.clone(), FileSystemAccessMode::Write);
        let result = writable
            .call("workspace.transaction", edit, || true)
            .unwrap();
        assert_eq!(result["files"]["a.py"], crate::execution::hash(b"new\n"));
        assert_eq!(std::fs::read_to_string(root.join("a.py")).unwrap(), "new\n");
    }

    #[test]
    fn workspace_paths_reject_escape_and_metadata() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let authority = authority(root, FileSystemAccessMode::Write);
        for path in ["../outside", ".git/config"] {
            assert!(
                authority
                    .call("workspace.read", json!({"paths":[path]}), || true)
                    .is_err()
            );
        }
    }

    #[test]
    fn write_observation_hides_denied_paths() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        let root_uri =
            PathUri::from_abs_path(&AbsolutePathBuf::from_absolute_path_checked(&root).unwrap());
        let secret_uri = PathUri::from_abs_path(
            &AbsolutePathBuf::from_absolute_path_checked(root.join("secret.py")).unwrap(),
        );
        let policy = FileSystemSandboxPolicy::restricted(vec![
            FileSystemSandboxEntry::new(
                FileSystemPath::Path { path: root_uri },
                FileSystemAccessMode::Read,
            ),
            FileSystemSandboxEntry::new(
                FileSystemPath::Path { path: secret_uri },
                FileSystemAccessMode::Deny,
            ),
        ]);
        let profile =
            PermissionProfile::from_runtime_permissions(&policy, NetworkSandboxPolicy::Restricted);
        let authority = WorkspaceAuthority::for_platform(&root, profile).unwrap();
        let change = |path: &str| codex_omd::WorkspaceChange {
            path: path.to_owned(),
            before: None,
            after: Some("sha".into()),
        };
        assert_eq!(
            authority
                .visible_changes(vec![change("public.py")])
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            authority
                .visible_changes(vec![change("secret.py")])
                .unwrap_err(),
            "workspace_change_scope_unavailable"
        );
    }

    #[test]
    fn pre_rename_plan_applies_companion_write_and_move() {
        let directory = tempfile::tempdir().unwrap();
        let root = directory.path().canonicalize().unwrap();
        std::fs::write(root.join("old.ts"), "export const value = 1;\n").unwrap();
        std::fs::write(root.join("index.ts"), "export * from './old';\n").unwrap();
        let authority = authority(root.clone(), FileSystemAccessMode::Write);
        let input = authority.rename_input("old.ts", "new.ts", || true).unwrap();
        let index = authority
            .call("workspace.read", json!({"paths":["index.ts"]}), || true)
            .unwrap();
        let result = authority
            .apply_rename_plan(
                &input,
                json!({
                    "status":"ready",
                    "expected":{
                        "old.ts":input["expected"]["old.ts"],
                        "new.ts":null,
                        "index.ts":index["files"]["index.ts"]["sha256"]
                    },
                    "writes":{"index.ts":"export * from './new';\n"}
                }),
                || true,
            )
            .unwrap();
        assert_eq!(result["status"], "renamed");
        assert!(!root.join("old.ts").exists());
        assert_eq!(
            std::fs::read_to_string(root.join("new.ts")).unwrap(),
            "export const value = 1;\n"
        );
        assert_eq!(
            std::fs::read_to_string(root.join("index.ts")).unwrap(),
            "export * from './new';\n"
        );
    }
}
