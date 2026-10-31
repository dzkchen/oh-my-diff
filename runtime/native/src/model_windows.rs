use codex_models_manager::runtime_models;
use codex_omd::fsio::Durability;
use codex_omd::fsio::write_bytes;
use serde_json::Value;
use serde_json::json;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;
use std::sync::PoisonError;
use std::time::SystemTime;

const FILE: &str = "model-windows.json";
const MAX_MODELS: usize = 64;
const MAX_SLUG_BYTES: usize = 128;
const MAX_TOKENS: i64 = 10_000_000;

type Stamp = Option<(u64, SystemTime)>;

static SEEN: Mutex<Option<Stamp>> = Mutex::new(None);

fn stamp(root: &Path) -> Stamp {
    let metadata = std::fs::metadata(root.join(FILE)).ok()?;
    Some((metadata.len(), metadata.modified().ok()?))
}

fn read(root: &Path) -> BTreeMap<String, i64> {
    std::fs::read(root.join(FILE))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

pub(crate) fn load(root: &Path) {
    let current = stamp(root);
    let mut seen = SEEN.lock().unwrap_or_else(PoisonError::into_inner);
    if seen.as_ref() != Some(&current) {
        runtime_models::set_context_windows(read(root).into_iter().collect());
        *seen = Some(current);
    }
}

pub(crate) fn call(root: &Path, arguments: Value) -> Result<Value, String> {
    let Value::Object(mut input) = arguments else {
        return Err("model_context_window_invalid: expected {model, tokens?}".into());
    };
    let model = match input.remove("model") {
        Some(Value::String(model)) if !model.is_empty() && model.len() <= MAX_SLUG_BYTES => model,
        _ => return Err("model_context_window_invalid: model is a slug of 1 to 128 bytes".into()),
    };
    let tokens = input.remove("tokens");
    if let Some(field) = input.keys().next() {
        return Err(format!("model_context_window_invalid: unknown field {field}"));
    }
    let mut seen = SEEN.lock().unwrap_or_else(PoisonError::into_inner);
    let mut windows = read(root);
    let changed = tokens.is_some();
    match tokens {
        None => {}
        Some(Value::Null) => {
            windows.remove(&model);
        }
        Some(value) => {
            let tokens = value
                .as_i64()
                .filter(|tokens| (1..=MAX_TOKENS).contains(tokens))
                .ok_or("model_context_window_invalid: tokens is a whole number from 1 to 10000000")?;
            if !windows.contains_key(&model) && windows.len() >= MAX_MODELS {
                return Err(format!("model_context_window_limit: at most {MAX_MODELS} models"));
            }
            windows.insert(model.clone(), tokens);
        }
    }
    if changed {
        let bytes = serde_json::to_vec(&windows).map_err(|error| error.to_string())?;
        write_bytes(&root.join(FILE), &bytes, Durability::Volatile).map_err(|error| error.to_string())?;
        *seen = Some(stamp(root));
    }
    runtime_models::set_context_windows(windows.iter().map(|(slug, tokens)| (slug.clone(), *tokens)).collect());
    let max = runtime_models::find(&model)
        .and_then(|(_, info)| info.max_context_window.or(info.context_window));
    Ok(json!({"model": model, "tokens": windows.get(&model), "max": max}))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picked_windows_persist_clear_and_validate() {
        let root = tempfile::tempdir().expect("root");
        let stored = || -> BTreeMap<String, i64> {
            serde_json::from_slice(&std::fs::read(root.path().join(FILE)).expect("file")).expect("json")
        };
        let set = call(root.path(), json!({"model": "omd-window-test", "tokens": 400_000})).expect("set");
        assert_eq!(set, json!({"model": "omd-window-test", "tokens": 400_000, "max": null}));
        assert_eq!(stored(), BTreeMap::from([("omd-window-test".to_string(), 400_000)]));
        assert_eq!(call(root.path(), json!({"model": "omd-window-test"})).expect("read")["tokens"], 400_000);
        assert_eq!(call(root.path(), json!({"model": "omd-window-test", "tokens": null})).expect("clear")["tokens"], Value::Null);
        assert_eq!(stored(), BTreeMap::new());
        for bad in [json!({"model": "", "tokens": 1}), json!({"model": "m", "tokens": 0}), json!({"model": "m", "tokens": 2.5}), json!({"model": "m", "extra": 1})] {
            assert!(call(root.path(), bad).unwrap_err().starts_with("model_context_window_invalid"));
        }
    }
}
