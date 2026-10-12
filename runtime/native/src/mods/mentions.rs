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
    async fn mention(&self, lead: &Arc<Lead>, name: String) -> Option<String> {
        let runtime = self.input_runtime.clone();
        let required = tokio::task::spawn_blocking(move || {
            runtime.lock().ok().map(|runtime| runtime.intercepts("mention"))
        })
        .await
        .ok()??;
        let Some(required) = required else {
            return Some(name);
        };
        let thread = lead.thread.to_string();
        let chain = intercept::chain(
            self.core.clone(),
            lead.clone(),
            self.input_runtime.clone(),
            "mention",
            required,
            json!({"thread_id": thread, "path": name}),
            json!({"caller": "user", "thread_id": thread}),
            Arc::new(AtomicBool::new(false)),
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
            let names = mentioned(&input.user_input, &lead.host.repository);
            if names.is_empty() {
                return Vec::new();
            }
            let Ok(authority) =
                crate::workspace_operations::WorkspaceAuthority::for_lead(&lead).await
            else {
                return Vec::new();
            };
            let mut fragments: Vec<Box<dyn ContextualUserFragment + Send>> = Vec::new();
            for name in names {
                let Some(path) = self.mention(&lead, name).await else {
                    continue;
                };
                let small = codex_omd::workspace_path(&lead.host.repository, &path)
                    .and_then(std::fs::metadata)
                    .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= MENTION_BYTES);
                let read = small
                    .then(|| authority.call("workspace.read", json!({"paths": [path]}), || true))
                    .and_then(Result::ok);
                if let Some(contents) = read
                    .as_ref()
                    .and_then(|read| read["files"][&path]["text"].as_str())
                {
                    fragments.push(Box::new(MentionedFile {
                        contents: contents.to_owned(),
                        path,
                    }));
                }
            }
            fragments
        })
    }
}
