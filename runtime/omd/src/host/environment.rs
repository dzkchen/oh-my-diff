use super::*;

type Scope = (PathBuf, String, String, String);
type Values = BTreeMap<String, Option<String>>;
static OVERRIDES: std::sync::LazyLock<Mutex<BTreeMap<Scope, Values>>> =
    std::sync::LazyLock::new(|| Mutex::new(BTreeMap::new()));

pub fn environment_overrides(
    root: &Path,
    thread: Option<&str>,
    owner: &str,
    source: &str,
    declared: &[String],
) -> Result<Values, String> {
    let Some(thread) = thread else {
        return Ok(BTreeMap::new());
    };
    let values = OVERRIDES
        .lock()
        .map_err(|_| "environment_state_poisoned")?
        .get(&(
            root.to_owned(),
            thread.to_owned(),
            owner.to_owned(),
            source.to_owned(),
        ))
        .cloned()
        .unwrap_or_default();
    if values.keys().any(|name| !declared.contains(name)) {
        return Err("exec_environment_undeclared".into());
    }
    Ok(values)
}

pub fn clear_environment(root: &Path, thread: Option<&str>, owner: Option<&str>) {
    if let Ok(mut values) = OVERRIDES.lock() {
        values.retain(|(path, t, id, _), _| {
            path != root
                || thread.is_some_and(|thread| thread != t)
                || owner.is_some_and(|owner| owner != id)
        });
    }
}

pub fn retain_environment(root: &Path, sources: &BTreeMap<String, String>) {
    if let Ok(mut values) = OVERRIDES.lock() {
        values.retain(|(path, _, id, source), _| path != root || sources.get(id) == Some(source));
    }
}

pub(super) fn set(root: &Path, caller: &Caller<'_>, arguments: Value) -> Result<Value, String> {
    #[derive(Deserialize)]
    #[serde(deny_unknown_fields)]
    struct Input {
        name: String,
        value: Value,
    }
    let input: Input =
        serde_json::from_value(arguments).map_err(|_| "environment_arguments_invalid")?;
    let thread = caller.thread.ok_or("environment_thread_required")?;
    let name = &input.name;
    if !caller.exec_environment.contains(name) {
        return Err("exec_environment_undeclared".into());
    }
    if name.is_empty()
        || name.len() > 64
        || name.as_bytes()[0].is_ascii_digit()
        || !name
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        || RESERVED_EXEC_ENVIRONMENT.contains(&name.as_str())
        || RESERVED_EXEC_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
    {
        return Err("environment_name_invalid".into());
    }
    let set = !input.value.is_null();
    let value = match input.value {
        Value::Null => None,
        Value::String(value) if value.len() <= 4096 && !value.contains('\0') => Some(value),
        _ => return Err("environment_value_invalid".into()),
    };
    let mut scopes = OVERRIDES.lock().map_err(|_| "environment_state_poisoned")?;
    let key = (
        root.to_owned(),
        thread.to_owned(),
        caller.id.to_owned(),
        caller.source_sha256.to_owned(),
    );
    let mut values = scopes.get(&key).cloned().unwrap_or_default();
    values.insert(name.clone(), value);
    if values.len() > 16 || values.values().flatten().map(String::len).sum::<usize>() > 16 * 1024 {
        return Err("environment_limit".into());
    }
    scopes.insert(key, values);
    Ok(json!({"name": name, "set": set}))
}
