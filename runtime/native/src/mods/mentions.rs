use super::*;
use codex_extension_api::ContentItemKind;
use codex_extension_api::ContextualUserFragment;
use codex_extension_api::ExtensionMetrics;
use codex_extension_api::TurnInputContext;
use codex_extension_api::TurnInputContributor;
use codex_protocol::user_input::UserInput;

const MENTIONS: usize = 16;
const MENTION_BYTES: u64 = 256 * 1024;

struct MentionedFile {
    path: String,
    contents: String,
}

impl ContextualUserFragment for MentionedFile {
    fn role(&self) -> &'static str {
        "user"
    }

    fn content_kind(&self) -> ContentItemKind {
        ContentItemKind("mentions.file".to_string())
    }

    fn markers(&self) -> (&'static str, &'static str) {
        Self::type_markers()
    }

    fn type_markers() -> (&'static str, &'static str) {
        ("<mentioned_file>", "</mentioned_file>")
    }

    fn body(&self) -> String {
        format!("\n<path>{}</path>\n{}\n", self.path, self.contents)
    }
}

/// Workspace-relative `@path` and `@"quoted path"` mentions in the submitted text that name existing files, in order.
pub(super) fn mentioned(input: &[UserInput], repository: &std::path::Path) -> Vec<String> {
    let mut names = Vec::new();
    for item in input {
        let UserInput::Text { text, .. } = item else {
            continue;
        };
        for (index, _) in text.match_indices('@') {
            if !text[..index].chars().next_back().is_none_or(char::is_whitespace) {
                continue;
            }
            let rest = &text[index + 1..];
            let name = match rest.strip_prefix('"') {
                Some(quoted) => match quoted.find('"') {
                    Some(end) => &quoted[..end],
                    None => continue,
                },
                None => rest
                    .split(char::is_whitespace)
                    .next()
                    .unwrap_or_default()
                    .trim_end_matches(|c: char| ",.;:!?)]}'\"`".contains(c)),
            };
            let name = name.trim_start_matches("./");
            if names.len() < MENTIONS
                && !names.iter().any(|known| known == name)
                && codex_omd::workspace_path(repository, name).is_ok_and(|path| path.is_file())
            {
                names.push(name.to_owned());
            }
        }
    }
    names
}

impl Mods {
    /// The path `mention` interceptors settle on; `None` when one denied the read or the chain failed.
    async fn mention(
        &self,
        lead: &Arc<Lead>,
        required: bool,
        name: String,
        cancelled: &Arc<AtomicBool>,
    ) -> Option<String> {
        let thread = lead.thread.to_string();
        let chain = intercept::chain(
            self.core.clone(),
            lead.clone(),
            self.input_runtime.clone(),
            "mention",
            required,
            json!({"thread_id": thread, "path": name}),
            json!({"caller": "user", "thread_id": thread}),
            cancelled.clone(),
            |input| Ok(json!({"path": input["path"]})),
        )
        .await
        .ok()?;
        chain.result["path"].as_str().map(str::to_owned)
    }
}

impl TurnInputContributor for Mods {
    fn contribute<'a>(
        &'a self,
        input: TurnInputContext<'a>,
        _metrics: Option<Arc<dyn ExtensionMetrics>>,
        _session_store: &'a ExtensionData,
        thread_store: &'a ExtensionData,
        _turn_store: &'a ExtensionData,
    ) -> ExtensionFuture<'a, Vec<Box<dyn ContextualUserFragment + Send>>> {
        Box::pin(async move {
            let Some(lead) = thread_store.get::<Lead>() else {
                return Vec::new();
            };
            let (user_input, repository, runtime) = (
                input.user_input,
                lead.host.repository.clone(),
                self.input_runtime.clone(),
            );
            let Ok(Some((names, required))) = tokio::task::spawn_blocking(move || {
                let names = mentioned(&user_input, &repository);
                if names.is_empty() {
                    return None;
                }
                let required = runtime.lock().ok()?.intercepts("mention");
                Some((names, required))
            })
            .await
            else {
                return Vec::new();
            };
            let Ok(authority) =
                crate::workspace_operations::WorkspaceAuthority::for_lead(&lead).await
            else {
                return Vec::new();
            };
            let cancelled = Arc::new(AtomicBool::new(false));
            let _cancellation = Cancellation(cancelled.clone());
            let mut paths: Vec<String> = Vec::new();
            for name in names {
                let path = match required {
                    Some(required) => self.mention(&lead, required, name, &cancelled).await,
                    None => Some(name),
                };
                if let Some(path) = path.filter(|path| !paths.contains(path)) {
                    paths.push(path);
                }
            }
            let repository = lead.host.repository.clone();
            tokio::task::spawn_blocking(move || {
                let mut budget = MENTION_BYTES;
                let mut fragments: Vec<Box<dyn ContextualUserFragment + Send>> = Vec::new();
                for path in paths {
                    let fits = codex_omd::workspace_path(&repository, &path)
                        .and_then(std::fs::metadata)
                        .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= budget);
                    let read = fits
                        .then(|| {
                            authority.call("workspace.read", json!({"paths": [path]}), || {
                                !cancelled.load(Ordering::Acquire)
                            })
                        })
                        .and_then(Result::ok);
                    if let Some(contents) = read
                        .as_ref()
                        .and_then(|read| read["files"][&path]["text"].as_str())
                    {
                        budget = budget.saturating_sub(contents.len() as u64);
                        fragments.push(Box::new(MentionedFile {
                            contents: contents.to_owned(),
                            path,
                        }));
                    }
                }
                fragments
            })
            .await
            .unwrap_or_default()
        })
    }
}
