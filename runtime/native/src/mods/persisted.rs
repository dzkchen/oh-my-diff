use super::*;
use codex_extension_api::PersistedTextInput;
use codex_extension_api::PersistedTextRewrite;

/// Runs `history_persist` interceptors off the async runtime; when the persist runtime itself
/// fails, a required interceptor withholds every entry.
pub(super) async fn rewrite(
    runtime: Arc<Mutex<ModHost>>,
    required: Arc<Mutex<Vec<&'static str>>>,
    input: PersistedTextInput<'_>,
) -> Option<PersistedTextRewrite> {
    let thread = input.thread_id.to_owned();
    let entries = input
        .entries
        .iter()
        .map(|entry| {
            json!({"kind":entry.kind,"role":entry.role,"call_id":entry.call_id,"text":entry.text})
        })
        .collect::<Vec<_>>();
    let count = entries.len();
    let rewritten =
        tokio::task::spawn_blocking(move || codex_omd::persist_texts(&runtime, &thread, &entries))
            .await;
    match rewritten {
        Ok(Ok(rewrite)) => rewrite.map(|rewrite| PersistedTextRewrite {
            texts: rewrite.texts,
            by: rewrite.by,
        }),
        _ => required
            .lock()
            .is_ok_and(|surfaces| surfaces.contains(&"history_persist"))
            .then(|| PersistedTextRewrite {
                texts: vec![codex_omd::PERSIST_WITHHELD.to_owned(); count],
                by: "host".to_owned(),
            }),
    }
}
