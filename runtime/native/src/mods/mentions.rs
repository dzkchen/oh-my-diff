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
        let mut consumed = 0;
        for (index, _) in text.match_indices('@') {
            if index < consumed {
                continue;
            }
            if !text[..index]
                .chars()
                .next_back()
                .is_none_or(char::is_whitespace)
            {
                continue;
            }
            let rest = &text[index + 1..];
            let name = if rest.starts_with('"') {
                let mut quoted = serde_json::Deserializer::from_str(rest).into_iter::<String>();
                let Some(Ok(name)) = quoted.next() else {
                    break;
                };
                consumed = index + 1 + quoted.byte_offset();
                name
            } else {
                rest.split(char::is_whitespace)
                    .next()
                    .unwrap_or_default()
                    .trim_end_matches(|c: char| ",.;:!?)]}'\"`".contains(c))
                    .to_owned()
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
            let Ok(authority) = crate::workspace_operations::WorkspaceAuthority::for_environments(
                &lead,
                &input.environments,
            )
            .await
            else {
                return Vec::new();
            };
            let (user_input, repository, runtime) = (
                input.user_input,
                authority.repository.clone(),
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
            let repository = authority.repository.clone();
            tokio::task::spawn_blocking(move || {
                read_mentions(&repository, paths, |path| {
                    authority
                        .call("workspace.read", json!({"paths": [path]}), || {
                            !cancelled.load(Ordering::Acquire)
                        })
                        .ok()
                })
            })
            .await
            .unwrap_or_default()
        })
    }
}

fn read_mentions(
    repository: &std::path::Path,
    paths: Vec<String>,
    mut read: impl FnMut(&str) -> Option<Value>,
) -> Vec<Box<dyn ContextualUserFragment + Send>> {
    let mut budget = MENTION_BYTES;
    let mut fragments: Vec<Box<dyn ContextualUserFragment + Send>> = Vec::new();
    for path in paths {
        let fits = codex_omd::workspace_path(repository, &path)
            .and_then(std::fs::metadata)
            .is_ok_and(|metadata| metadata.is_file() && metadata.len() <= budget);
        let result = fits.then(|| read(&path)).flatten();
        if let Some(contents) = result
            .as_ref()
            .and_then(|read| read["files"][&path]["text"].as_str())
            .filter(|contents| contents.len() as u64 <= budget)
        {
            budget -= contents.len() as u64;
            fragments.push(Box::new(MentionedFile {
                contents: contents.to_owned(),
                path,
            }));
        }
    }
    fragments
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_mentions_consume_the_whole_filename() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["notes @secret.txt", "secret.txt", "next.txt"] {
            std::fs::write(directory.path().join(name), name).unwrap();
        }
        let input = [UserInput::Text {
            text: "@\"notes @secret.txt\" @next.txt".into(),
            text_elements: Vec::new(),
        }];
        assert_eq!(
            mentioned(&input, directory.path()),
            ["notes @secret.txt", "next.txt"]
        );
    }

    #[test]
    fn quoted_mentions_preserve_filenames_and_reject_unsafe_paths() {
        let directory = tempfile::tempdir().unwrap();
        for name in [
            "report!",
            "notes \"quoted\".txt",
            "notes\\file.txt",
            "report",
        ] {
            std::fs::write(directory.path().join(name), name).unwrap();
        }
        let input = [UserInput::Text {
            text: r#"@"report!" @"notes \"quoted\".txt" @"notes\\file.txt""#.into(),
            text_elements: Vec::new(),
        }];
        assert_eq!(
            mentioned(&input, directory.path()),
            ["report!", "notes \"quoted\".txt"]
        );
    }

    #[test]
    fn mention_budget_checks_contents_when_files_grow_after_metadata() {
        let directory = tempfile::tempdir().unwrap();
        for name in ["first.txt", "growing.txt", "last.txt"] {
            std::fs::write(directory.path().join(name), "small").unwrap();
        }
        let fragments = read_mentions(
            directory.path(),
            ["first.txt", "growing.txt", "last.txt"]
                .map(str::to_owned)
                .to_vec(),
            |path| {
                let content = match path {
                    "first.txt" => "x".repeat(200_000),
                    "growing.txt" => "é".repeat(40_000),
                    _ => "last".into(),
                };
                std::fs::write(directory.path().join(path), content).unwrap();
                Some(
                    json!({"files": {path: {"text": std::fs::read_to_string(directory.path().join(path)).unwrap()}}}),
                )
            },
        );
        assert_eq!(fragments.len(), 2);
        assert!(fragments[0].body().starts_with("\n<path>first.txt</path>"));
        assert_eq!(fragments[1].body(), "\n<path>last.txt</path>\nlast\n");
    }
}
