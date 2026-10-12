use super::*;
use codex_extension_api::PersistedTextInput;
use codex_extension_api::PersistedTextRewrite;

const CHUNK_BYTES: usize = 98_304;
const WITHHELD: &str = "[withheld: a required history_persist interceptor failed]";

/// Where a chunk of `text` ends: the last whitespace within `CHUNK_BYTES`, so a token stays whole.
pub(super) fn cut(text: &str) -> usize {
    let end = text.floor_char_boundary(CHUNK_BYTES);
    if end == text.len() {
        return end;
    }
    text[..end]
        .rfind(|c: char| c.is_ascii_whitespace())
        .map_or(end, |at| at + 1)
}

/// Runs `history_persist` interceptors over the texts in chunks that fit one callback;
/// a longer text arrives as consecutive entries with the same index.
pub(super) async fn rewrite(
    runtime: Arc<Mutex<ModHost>>,
    intercepted: &Mutex<Vec<&'static str>>,
    input: PersistedTextInput<'_>,
) -> Option<PersistedTextRewrite> {
    if !intercepted
        .lock()
        .is_ok_and(|surfaces| surfaces.contains(&"history_persist"))
    {
        return None;
    }
    let thread = input.thread_store.get::<Lead>()?.thread.to_string();
    let mut chunks: Vec<Vec<(usize, Value)>> = vec![Vec::new()];
    let mut size = 0;
    for (index, entry) in input.entries.iter().enumerate() {
        let mut rest = entry.text.as_str();
        loop {
            let cut = cut(rest);
            if size + cut > CHUNK_BYTES {
                chunks.push(Vec::new());
                size = 0;
            }
            size += cut;
            chunks.last_mut()?.push((
                index,
                json!({"index":index,"kind":entry.kind,"role":entry.role,
                    "call_id":entry.call_id,"text":&rest[..cut]}),
            ));
            rest = &rest[cut..];
            if rest.is_empty() {
                break;
            }
        }
    }
    let count = input.entries.len();
    tokio::task::spawn_blocking(move || {
        let _thread = codex_omd::StateThread::enter(Some(thread.clone()));
        let required = {
            let mut runtime = runtime.lock().ok()?;
            runtime.turn_boundary();
            runtime.intercepts("history_persist")?
        };
        let mut texts = vec![String::new(); count];
        let mut withheld = vec![false; count];
        let mut by = Vec::new();
        for chunk in chunks {
            let entries = chunk.iter().map(|(_, entry)| entry.clone()).collect::<Vec<_>>();
            let chain = codex_omd::intercept_shared(
                &runtime,
                "history_persist",
                required,
                json!({"thread_id":thread,"entries":entries}),
                json!({"caller":"host","thread_id":thread}),
                || true,
                |_, call| {
                    Err(std::io::Error::other(format!(
                        "host_operation_unavailable: history_persist interceptors run while history is persisted ({})",
                        call.operation
                    )))
                },
                |input| Ok(json!({"entries": input["entries"]})),
            )
            .ok();
            let rewritten = chain
                .as_ref()
                .and_then(|chain| chain.result["entries"].as_array());
            for (position, (index, original)) in chunk.iter().enumerate() {
                let given = original["text"].as_str().unwrap_or_default();
                let text = rewritten
                    .and_then(|entries| entries.get(position))
                    .and_then(|entry| entry["text"].as_str());
                match (text, &chain) {
                    (Some(text), Some(chain)) => {
                        if text != given {
                            by.extend(
                                chain
                                    .trace
                                    .iter()
                                    .filter(|entry| {
                                        matches!(entry["outcome"].as_str(), Some("returned" | "passed"))
                                    })
                                    .filter_map(|entry| entry["mod"].as_str())
                                    .filter(|id| *id != "engine")
                                    .map(|id| format!("mod:{id}")),
                            );
                        }
                        texts[*index].push_str(text);
                    }
                    _ => {
                        withheld[*index] |= required;
                        texts[*index].push_str(given);
                    }
                }
            }
        }
        for (text, withheld) in texts.iter_mut().zip(&withheld) {
            if *withheld {
                *text = WITHHELD.to_owned();
            }
        }
        if withheld.contains(&true) {
            by.push("host".to_owned());
        }
        by.sort();
        by.dedup();
        (!by.is_empty()).then(|| PersistedTextRewrite {
            texts,
            by: by.join(", "),
        })
    })
    .await
    .ok()
    .flatten()
}
