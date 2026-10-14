use super::*;

/// JSON bytes of entries per callback; the payload carries them twice (`input` and `original`).
pub const PERSIST_CHUNK_BYTES: usize = 49_152;
pub const PERSIST_WITHHELD: &str = "[withheld: a required history_persist interceptor failed]";

/// Replacement texts in entry order and who supplied them.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PersistedRewrite {
    pub texts: Vec<String>,
    pub by: String,
}

fn escaped(c: char) -> usize {
    match c {
        '"' | '\\' | '\n' | '\r' | '\t' | '\u{8}' | '\u{c}' => 2,
        c if u32::from(c) < 0x20 => 6,
        c => c.len_utf8(),
    }
}

/// Where a chunk of `text` ends: within `budget` JSON-escaped bytes, after the last whitespace
/// there so a token stays whole, and after at least one character.
pub fn persist_cut(text: &str, budget: usize) -> usize {
    let mut size = 0;
    let end = text
        .char_indices()
        .find(|(_, c)| {
            size += escaped(*c);
            size > budget
        })
        .map_or(
            text.len(),
            |(at, c)| if at == 0 { c.len_utf8() } else { at },
        );
    if end == text.len() {
        return end;
    }
    text[..end]
        .rfind(|c: char| c.is_ascii_whitespace())
        .map_or(end, |at| at + 1)
}

/// Entries (`{kind, role, call_id, text}`) in callbacks of at most `PERSIST_CHUNK_BYTES` of JSON;
/// a longer text arrives as consecutive entries with the same index.
pub fn persist_chunks(entries: &[Value]) -> Vec<Vec<(usize, Value)>> {
    let mut chunks: Vec<Vec<(usize, Value)>> = vec![Vec::new()];
    let mut size = 0;
    for (index, entry) in entries.iter().enumerate() {
        let mut rest = entry["text"].as_str().unwrap_or_default();
        let value = |text: &str| {
            json!({"index":index,"kind":entry["kind"],"role":entry["role"],
                "call_id":entry["call_id"],"text":text})
        };
        let overhead = value("").to_string().len();
        loop {
            let cut = persist_cut(rest, PERSIST_CHUNK_BYTES.saturating_sub(overhead));
            let piece = value(&rest[..cut]);
            let bytes = piece.to_string().len();
            if size + bytes > PERSIST_CHUNK_BYTES {
                chunks.push(Vec::new());
                size = 0;
            }
            size += bytes;
            if let Some(chunk) = chunks.last_mut() {
                chunk.push((index, piece));
            }
            rest = &rest[cut..];
            if rest.is_empty() {
                break;
            }
        }
    }
    chunks
}

/// Mods whose link changed the entries: what it passed down or returned differs from its
/// downstream's, or, answering alone, its result differs from its input. Every mod that ran
/// when a truncated trace shows no such link.
pub fn persist_changed_by(trace: &[Value]) -> Vec<String> {
    let ran = |entry: &&Value| entry.get("returned").is_some();
    let links = trace
        .iter()
        .filter(ran)
        .filter(|entry| entry["mod"] != "engine")
        .collect::<Vec<_>>();
    let changed = links
        .iter()
        .copied()
        .filter(|link| {
            match trace
                .iter()
                .filter(ran)
                .filter(|entry| entry["index"].as_u64() > link["index"].as_u64())
                .min_by_key(|entry| entry["index"].as_u64())
            {
                Some(next) => {
                    link["received"] != next["received"] || link["returned"] != next["returned"]
                }
                None => link["received"] != link["returned"],
            }
        })
        .collect::<Vec<_>>();
    if changed.is_empty() { links } else { changed }
        .into_iter()
        .filter_map(|link| link["mod"].as_str())
        .map(|id| format!("mod:{id}"))
        .collect()
}

/// Runs `history_persist` interceptors over `entries` in chunks that fit one callback: `None`
/// when none is installed or nothing changed; a required interceptor's failure withholds its
/// entries. `Err` means the runtime itself was unusable, so the caller decides from the
/// published requirement.
pub fn persist_texts(
    runtime: &Mutex<ModHost>,
    thread: &str,
    entries: &[Value],
    active: impl Fn() -> bool,
) -> std::result::Result<Option<PersistedRewrite>, ()> {
    if !active() {
        return Err(());
    }
    let _thread = StateThread::enter(Some(thread.to_owned()));
    let mut runtime = runtime.lock().map_err(|_| ())?;
    runtime.refresh_guarded(&active).map_err(|_| ())?;
    let required = match runtime.intercepts("history_persist") {
        Some(required) => required,
        None => return Ok(None),
    };
    let mut texts = vec![String::new(); entries.len()];
    let mut withheld = vec![false; entries.len()];
    let mut by = Vec::new();
    for chunk in persist_chunks(entries) {
        if !active() {
            return Err(());
        }
        let values = chunk
            .iter()
            .map(|(_, entry)| entry.clone())
            .collect::<Vec<_>>();
        let chain = chain::intercept(
            &mut Access::Held(&mut runtime),
            &mut |_, call| {
                Err(std::io::Error::other(format!(
                    "host_operation_unavailable: history_persist interceptors run while history is persisted ({})",
                    call.operation
                )))
            },
            &mut chain::Core::Call(&mut |input| Ok(json!({"entries": input["entries"]}))),
            "history_persist",
            required,
            json!({"thread_id":thread,"entries":values}),
            json!({"caller":"host","thread_id":thread}),
            &active,
            &InvocationScope::default(),
        )
        .ok();
        let rewritten = chain
            .as_ref()
            .and_then(|chain| chain.result["entries"].as_array());
        let mut changed = false;
        for (position, (index, original)) in chunk.iter().enumerate() {
            let given = original["text"].as_str().unwrap_or_default();
            let text = rewritten
                .and_then(|entries| entries.get(position))
                .and_then(|entry| entry["text"].as_str());
            match text {
                Some(text) => {
                    changed |= text != given;
                    texts[*index].push_str(text);
                }
                None => {
                    withheld[*index] |= required;
                    texts[*index].push_str(given);
                }
            }
        }
        if changed && let Some(chain) = &chain {
            by.extend(persist_changed_by(&chain.trace));
        }
    }
    if !active() {
        return Err(());
    }
    for (text, withheld) in texts.iter_mut().zip(&withheld) {
        if *withheld {
            *text = PERSIST_WITHHELD.to_owned();
        }
    }
    if withheld.contains(&true) {
        by.push("host".to_owned());
    }
    by.sort();
    by.dedup();
    Ok((!by.is_empty()).then(|| PersistedRewrite {
        texts,
        by: by.join(", "),
    }))
}
