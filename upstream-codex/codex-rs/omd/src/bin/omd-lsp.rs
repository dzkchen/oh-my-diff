use codex_omd::LspAdapterRequest;
use codex_omd::LspLanguage;
use codex_omd::LspLimits;
use codex_omd::LspPreferenceStore;
use codex_omd::LspWorkspaceBindingStore;
use codex_omd::detect_installed_servers;
use codex_omd::execute_lsp_adapter_request;
use codex_omd::lsp_workspace_binding_path;
use serde::Serialize;
use serde_json::json;
use std::error::Error;
use std::io;
use std::io::Read;
use std::path::PathBuf;

type AppResult<T> = Result<T, Box<dyn Error>>;

fn print<T: Serialize>(value: &T) -> AppResult<()> {
    println!("{}", serde_json::to_string_pretty(value)?);
    Ok(())
}

fn language(value: &str) -> AppResult<LspLanguage> {
    match value {
        "rust" => Ok(LspLanguage::Rust),
        "typescript" => Ok(LspLanguage::TypeScript),
        "javascript" => Ok(LspLanguage::JavaScript),
        "python" => Ok(LspLanguage::Python),
        "java" => Ok(LspLanguage::Java),
        _ => Err(io::Error::other(
            "language must be rust, typescript, javascript, python, or java",
        )
        .into()),
    }
}

fn canonical_repository(value: &str) -> AppResult<PathBuf> {
    let supplied = PathBuf::from(value);
    if !supplied.is_absolute() || supplied.is_symlink() {
        return Err(io::Error::other(
            "repository must be a canonical absolute directory without a symlink endpoint",
        )
        .into());
    }
    let repository = supplied.canonicalize()?;
    if supplied != repository || !repository.is_dir() {
        return Err(io::Error::other(
            "repository must be a canonical absolute directory without symlink traversal",
        )
        .into());
    }
    Ok(repository)
}

fn adapter(
    repository: &str,
    store: &str,
    repository_identity: &str,
    language_name: &str,
) -> AppResult<()> {
    let repository = canonical_repository(repository)?;
    let supplied_store_path = PathBuf::from(store);
    if !supplied_store_path.is_absolute() || supplied_store_path.is_symlink() {
        return Err(io::Error::other(
            "preference store must be an existing canonical absolute file without symlink traversal",
        )
        .into());
    }
    let store_path = supplied_store_path.canonicalize()?;
    if supplied_store_path != store_path || !store_path.is_file() {
        return Err(io::Error::other(
            "preference store must be an existing canonical absolute file without symlink traversal",
        )
        .into());
    }
    let language = language(language_name)?;
    let mut input = Vec::new();
    io::stdin().take(1024 * 1024 + 1).read_to_end(&mut input)?;
    if input.len() > 1024 * 1024 {
        return Err(io::Error::other("adapter request exceeds the 1 MiB limit").into());
    }
    let request: LspAdapterRequest = serde_json::from_slice(&input)?;
    let command = request.command();
    let preferences = LspPreferenceStore::open(store_path.clone())?;
    let preference = preferences.preference(repository_identity);
    let binding_path = lsp_workspace_binding_path(&store_path)?;
    let bindings = LspWorkspaceBindingStore::open(binding_path)?;
    if !preference.is_some_and(|preference| preference.enabled)
        || !bindings.matches(repository_identity, &repository)
    {
        return print(&json!({
            "schema": 1,
            "status": "unsupported",
            "language": language,
            "command": command,
            "reason": "semantic LSP is not enabled for the exact repository identity and canonical workspace",
            "fallback": "Bind and enable the repository explicitly with omd-lsp preference before using semantic tools; until then use ordinary search, edits, and executable checks.",
            "repository_identity": repository_identity,
            "opt_in": "disabled",
        }));
    }
    let revision = preference.map(|preference| preference.revision);
    let binding_revision = bindings
        .binding(repository_identity)
        .map(|binding| binding.revision);
    let mut result =
        execute_lsp_adapter_request(repository, language, LspLimits::default(), None, request);
    result["repository_identity"] = json!(repository_identity);
    result["preference_revision"] = json!(revision);
    result["workspace_binding_revision"] = json!(binding_revision);
    result["opt_in"] = json!("enabled");
    print(&result)
}

fn run(args: Vec<String>) -> AppResult<()> {
    match args.as_slice() {
        [_, command] if command == "detect" => print(&detect_installed_servers()),
        [_, command, store, repository_identity, enabled] if command == "preference" => {
            let enabled = match enabled.as_str() {
                "enabled" => true,
                "disabled" => false,
                _ => return Err(io::Error::other("preference must be enabled or disabled").into()),
            };
            let mut store = LspPreferenceStore::open(PathBuf::from(store))?;
            print(&store.set(repository_identity.clone(), enabled)?)
        }
        [_, command, store, repository_identity, enabled, repository]
            if command == "preference" =>
        {
            let enabled = match enabled.as_str() {
                "enabled" => true,
                "disabled" => false,
                _ => return Err(io::Error::other("preference must be enabled or disabled").into()),
            };
            let store_path = PathBuf::from(store);
            let mut store = LspPreferenceStore::open(store_path.clone())?;
            let preference = store.set(repository_identity.clone(), enabled)?;
            let binding_path = lsp_workspace_binding_path(&store_path)?;
            let mut bindings = LspWorkspaceBindingStore::open(binding_path.clone())?;
            let binding = bindings.set(
                repository_identity.clone(),
                canonical_repository(repository)?,
            )?;
            print(&json!({
                "preference": preference,
                "workspace_binding": binding,
                "workspace_binding_store": binding_path,
            }))
        }
        [_, command, store, repository_identity] if command == "status" => {
            let store_path = PathBuf::from(store);
            let store = LspPreferenceStore::open(store_path.clone())?;
            let binding_path = lsp_workspace_binding_path(&store_path)?;
            let bindings = LspWorkspaceBindingStore::open(binding_path.clone())?;
            print(&json!({
                "repository_identity": repository_identity,
                "preference": store.preference(repository_identity),
                "workspace_binding": bindings.binding(repository_identity),
                "workspace_binding_store": binding_path,
                "installed_servers": detect_installed_servers(),
            }))
        }
        [_, command, repository, store, repository_identity, language]
            if command == "adapter" =>
        {
            adapter(repository, store, repository_identity, language)
        }
        _ => Err(io::Error::other(
            "usage: omd-lsp detect | preference STORE REPOSITORY_ID enabled|disabled [REPOSITORY] | status STORE REPOSITORY_ID | adapter REPOSITORY STORE REPOSITORY_ID LANGUAGE < REQUEST.json",
        )
        .into()),
    }
}

fn main() {
    if let Err(error) = run(std::env::args().collect()) {
        eprintln!("{error}");
        std::process::exit(1);
    }
}
