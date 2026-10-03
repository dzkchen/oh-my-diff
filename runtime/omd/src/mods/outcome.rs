use super::*;

const TEXT_LIMIT: usize = 16_384;

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ModCommandOutcome {
    pub display: Option<String>,
    pub insert: Option<String>,
    pub submit: Option<String>,
}

fn text(value: &Value, limit: usize) -> Result<String> {
    let text = value
        .as_str()
        .ok_or_else(|| failure("invalid_outcome_text"))?;
    if text.is_empty()
        || text.len() > limit
        || text
            .chars()
            .any(|c| c.is_control() && c != '\n' && c != '\t')
    {
        return Err(failure("invalid_outcome_text"));
    }
    Ok(text.to_owned())
}

fn truncated(mut text: String) -> String {
    if text.len() > TEXT_LIMIT {
        let mut end = TEXT_LIMIT;
        while !text.is_char_boundary(end) {
            end -= 1;
        }
        text.truncate(end);
    }
    text.chars()
        .filter(|c| !c.is_control() || *c == '\n' || *c == '\t')
        .collect()
}

impl ModCommandOutcome {
    pub fn parse(value: &Value) -> Result<Self> {
        match value {
            Value::Null => Ok(Self::default()),
            Value::String(display) => Ok(Self {
                display: Some(truncated(display.clone())).filter(|s| !s.is_empty()),
                ..Self::default()
            }),
            Value::Object(object)
                if !object.is_empty()
                    && object
                        .keys()
                        .all(|key| ["display", "insert", "submit"].contains(&key.as_str())) =>
            {
                let outcome = Self {
                    display: object
                        .get("display")
                        .map(|v| text(v, TEXT_LIMIT))
                        .transpose()?,
                    insert: object
                        .get("insert")
                        .map(|v| text(v, TEXT_LIMIT))
                        .transpose()?,
                    submit: object
                        .get("submit")
                        .map(|v| text(v, TEXT_LIMIT))
                        .transpose()?,
                };
                if outcome.insert.is_some() && outcome.submit.is_some() {
                    return Err(failure("command_outcome_conflict: insert or submit"));
                }
                Ok(outcome)
            }
            other => Ok(Self {
                display: Some(truncated(serde_json::to_string_pretty(other)?)),
                ..Self::default()
            }),
        }
    }
}
