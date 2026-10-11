use super::*;

type Scope = (String, String, String);
pub type EnvironmentValues = BTreeMap<String, String>;

#[derive(Default)]
pub struct Environment(Mutex<BTreeMap<Scope, EnvironmentValues>>);

impl Environment {
    pub fn values(
        &self,
        thread: Option<&str>,
        owner: &str,
        source: &str,
        declared: &[String],
    ) -> Result<EnvironmentValues, String> {
        let Some(thread) = thread else {
            return Ok(BTreeMap::new());
        };
        let values = self
            .0
            .lock()
            .map_err(|_| "environment_state_poisoned")?
            .get(&(thread.to_owned(), owner.to_owned(), source.to_owned()))
            .cloned()
            .unwrap_or_default();
        if values.keys().any(|name| !declared.contains(name)) {
            return Err("exec_environment_undeclared".into());
        }
        Ok(values)
    }

    pub fn snapshot(
        &self,
        thread: &str,
        owner: &str,
        source: &str,
        declared: &[String],
    ) -> Result<Self, String> {
        let values = self.values(Some(thread), owner, source, declared)?;
        Ok(Self(Mutex::new(BTreeMap::from([(
            (thread.to_owned(), owner.to_owned(), source.to_owned()),
            values,
        )]))))
    }

    pub fn clear(&self, thread: Option<&str>, owner: Option<&str>) {
        if let Ok(mut values) = self.0.lock() {
            values.retain(|(t, id, _), _| {
                thread.is_some_and(|thread| thread != t) || owner.is_some_and(|owner| owner != id)
            });
        }
    }

    pub fn retain(&self, sources: &BTreeMap<String, String>) {
        if let Ok(mut values) = self.0.lock() {
            values.retain(|(_, id, source), _| sources.get(id) == Some(source));
        }
    }

    pub(super) fn set(&self, caller: &Caller<'_>, arguments: Value) -> Result<Value, String> {
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
        if !environment_name_valid(name) {
            return Err("environment_name_invalid".into());
        }
        let set = !input.value.is_null();
        let value = match input.value {
            Value::Null => None,
            Value::String(value) if value.len() <= 4096 && !value.contains('\0') => Some(value),
            _ => return Err("environment_value_invalid".into()),
        };
        let mut scopes = self.0.lock().map_err(|_| "environment_state_poisoned")?;
        let key = (
            thread.to_owned(),
            caller.id.to_owned(),
            caller.source_sha256.to_owned(),
        );
        let mut values = scopes.get(&key).cloned().unwrap_or_default();
        if let Some(value) = value {
            values.insert(name.clone(), value);
        } else {
            values.remove(name);
        }
        validate_environment(&values)?;
        if values.is_empty() {
            scopes.remove(&key);
        } else {
            scopes.insert(key, values);
        }
        Ok(json!({"name": name, "set": set}))
    }
}

pub fn environment_name_valid(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && !name.as_bytes()[0].is_ascii_digit()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_')
        && !RESERVED_EXEC_ENVIRONMENT.contains(&name)
        && !RESERVED_EXEC_PREFIXES
            .iter()
            .any(|prefix| name.starts_with(prefix))
        && name != "XDG_CACHE_HOME"
}

pub fn validate_environment(values: &EnvironmentValues) -> Result<(), String> {
    if values.len() > 16 || values.values().map(String::len).sum::<usize>() > 16 * 1024 {
        return Err("environment_limit".into());
    }
    if values.keys().any(|name| !environment_name_valid(name)) {
        return Err("environment_name_invalid".into());
    }
    if values
        .values()
        .any(|value| value.len() > 4096 || value.contains('\0'))
    {
        return Err("environment_value_invalid".into());
    }
    Ok(())
}

pub fn environment_evidence(values: &EnvironmentValues) -> Value {
    Value::Object(
        values
            .iter()
            .map(|(name, value)| {
                let value = if secret_like(name) {
                    json!({"sha256": format!("{:x}", Sha256::digest(value.as_bytes()))})
                } else {
                    json!({"value": value})
                };
                (name.clone(), value)
            })
            .collect(),
    )
}
