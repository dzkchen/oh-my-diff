use super::*;
use codex_extension_api::ElicitationAnswer;
use codex_extension_api::ElicitationInterceptInput;
use codex_extension_api::ElicitationResultInput;

const FORMS: &[&str] = &["form", "openai/form", "openaiForm"];

/// Properties a user types as secrets; mods never fill them and never see them.
fn secret_fields(schema: &Value) -> Vec<String> {
    schema["properties"]
        .as_object()
        .into_iter()
        .flatten()
        .filter(|(_, property)| property["format"] == "password" || property["writeOnly"] == true)
        .map(|(name, _)| name.clone())
        .collect()
}

/// Without the request's secret list the fields cannot be told apart, so the whole answer is withheld.
pub(super) fn redact(content: Option<&Value>, secrets: Option<&[String]>) -> Value {
    let Some(secrets) = secrets else {
        return content.map_or(Value::Null, |_| json!("[redacted]"));
    };
    let mut content = content.cloned().unwrap_or(Value::Null);
    if let Some(object) = content.as_object_mut() {
        for name in secrets {
            if let Some(value) = object.get_mut(name) {
                *value = json!("[redacted]");
            }
        }
    }
    content
}

/// An accepted answer must fill every required field with declared fields only.
fn fills(schema: &Value, content: &Value) -> bool {
    let (Some(content), Some(properties)) = (content.as_object(), schema["properties"].as_object())
    else {
        return false;
    };
    content.keys().all(|key| properties.contains_key(key))
        && schema["required"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .all(|key| content.contains_key(key))
}

impl Mods {
    pub(super) async fn elicitation_answer(
        &self,
        input: ElicitationInterceptInput<'_>,
    ) -> Option<ElicitationAnswer> {
        let lead = input
            .thread_store
            .get::<Lead>()
            .filter(|lead| lead.owner == "lead")?;
        let schema = &input.request["requested_schema"];
        let secrets = secret_fields(schema);
        if let Ok(mut pending) = self.elicitations.lock() {
            let key = format!("{}\0{}", input.server, input.request_id);
            pending.retain(|(pending, _)| *pending != key);
            if pending.len() >= 64 {
                pending.pop_front();
            }
            pending.push_back((key, secrets.clone()));
        }
        let mode = input.request["mode"].as_str().unwrap_or_default();
        if !FORMS.contains(&mode) || !secrets.is_empty() {
            return None;
        }
        let (runtime, thread) = (self.runtime.clone(), lead.thread.to_string());
        let scope = thread.clone();
        let required = tokio::task::spawn_blocking(move || {
            let _thread = codex_omd::StateThread::enter(Some(scope));
            runtime
                .lock()
                .ok()
                .and_then(|runtime| runtime.intercepts("elicitation"))
        })
        .await
        .ok()
        .flatten()?;
        let payload = json!({"thread_id": thread, "turn_id": input.turn_id, "server": input.server,
            "request_id": input.request_id, "mode": mode, "message": input.request["message"],
            "schema": schema});
        let chain = intercept::chain(
            self.core.clone(),
            lead,
            self.runtime.clone(),
            "elicitation",
            required,
            payload,
            json!({"caller": "engine", "thread_id": thread}),
            Arc::new(AtomicBool::new(false)),
            |_| Ok(json!({"action": "ask"})),
        )
        .await;
        let chain = match chain {
            Ok(chain) => chain,
            Err(error) => {
                self.views.diagnostic(
                    &self.host,
                    "elicitation",
                    Some(format!("{error}; the user was asked")),
                );
                return None;
            }
        };
        let by = chain
            .answered_by
            .clone()
            .unwrap_or_else(|| intercept::settled_by(&chain));
        let result = &chain.result;
        if let Some(content) = result.get("accept") {
            if !fills(schema, content) {
                self.views.diagnostic(
                    &self.host,
                    "elicitation",
                    Some(format!(
                        "{by} answered fields the form does not ask for; the user was asked"
                    )),
                );
                return None;
            }
            return Some(ElicitationAnswer {
                action: "accept".into(),
                content: Some(content.clone()),
                by,
            });
        }
        ["decline", "cancel"]
            .into_iter()
            .find(|action| result.get(*action).is_some())
            .map(|action| ElicitationAnswer {
                action: action.into(),
                content: None,
                by,
            })
    }

    pub(super) async fn elicitation_result(&self, input: ElicitationResultInput<'_>) {
        let Some(lead) = input
            .thread_store
            .get::<Lead>()
            .filter(|lead| lead.owner == "lead")
        else {
            return;
        };
        let key = format!("{}\0{}", input.server, input.request_id);
        let secrets = self.elicitations.lock().ok().and_then(|mut pending| {
            let at = pending.iter().position(|(pending, _)| *pending == key)?;
            pending.remove(at).map(|(_, secrets)| secrets)
        });
        self.event(
            "elicitation_result",
            json!({"server": input.server, "request_id": input.request_id, "action": input.action,
                "content": redact(input.content, secrets.as_deref()), "by": input.by}),
            Some(&*lead),
        )
        .await;
    }
}
