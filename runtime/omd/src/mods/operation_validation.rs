use serde_json::Value;
use std::sync::LazyLock;

static SCHEMAS: LazyLock<Value> = LazyLock::new(|| {
    let schemas: Value = serde_json::from_str(include_str!("operation_schema.json"))
        .expect("generated operation schemas");
    for operation in schemas["operations"].as_object().expect("operations").values() {
        for field in ["arguments", "result"] {
            supported(&operation[field], &schemas).expect("supported operation schema");
        }
    }
    for definition in schemas["$defs"].as_object().expect("definitions").values() {
        supported(definition, &schemas).expect("supported schema definition");
    }
    schemas
});

fn supported(schema: &Value, document: &Value) -> Result<(), String> {
    if let Some(object) = schema.as_object() {
        for (name, child) in object {
            match name.as_str() {
                "properties" => {
                    for child in child.as_object().ok_or("schema properties invalid")?.values() {
                        supported(child, document)?;
                    }
                }
                "anyOf" | "allOf" | "prefixItems" => {
                    for child in child.as_array().ok_or("schema alternatives invalid")? {
                        supported(child, document)?;
                    }
                }
                "items" | "additionalProperties" => supported(child, document)?,
                "$ref" => {
                    let name = child.as_str().and_then(|value| value.strip_prefix("#/$defs/"))
                        .ok_or("schema reference invalid")?;
                    if document["$defs"].get(name).is_none() { return Err("schema reference missing".into()); }
                }
                "type" | "const" | "required" | "minItems" | "maxItems" | "format" => {}
                _ => return Err(format!("unsupported schema keyword {name}")),
            }
        }
    } else if !schema.is_boolean() {
        return Err("schema must be an object or boolean".into());
    }
    Ok(())
}

fn check(schema: &Value, value: &Value, path: &str) -> Result<(), String> {
    let invalid = |reason: &str| Err(format!("{path}: {reason}"));
    if let Some(reference) = schema["$ref"].as_str() {
        return check(&SCHEMAS["$defs"][&reference["#/$defs/".len()..]], value, path);
    }
    if schema == &Value::Bool(false) {
        return invalid("value forbidden");
    }
    if let Some(kind) = schema["type"].as_str() {
        let valid = match kind {
            "null" => value.is_null(),
            "boolean" => value.is_boolean(),
            "number" => value.is_number(),
            "string" => value.is_string(),
            "array" => value.is_array(),
            "object" => value.is_object(),
            _ => false,
        };
        if !valid { return invalid(&format!("expected {kind}")); }
    }
    if let Some(expected) = schema.get("const") {
        if value != expected { return invalid("literal mismatch"); }
    }
    if let Some(variants) = schema["anyOf"].as_array() {
        if !variants.iter().any(|variant| check(variant, value, path).is_ok()) {
            return invalid("no union member matched");
        }
    }
    if let Some(variants) = schema["allOf"].as_array() {
        for variant in variants { check(variant, value, path)?; }
    }
    if let Some(format) = schema.get("format") {
        let valid = match (format.as_str(), value.as_str()) {
            (Some("dotted-string"), Some(text)) => text.contains('.'),
            (Some("hash-prefixed-string"), Some(text)) => text.starts_with('#'),
            _ => false,
        };
        if !valid { return invalid("string format mismatch or unsupported format"); }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = schema["required"].as_array() {
            for name in required.iter().filter_map(Value::as_str) {
                if !object.contains_key(name) { return invalid(&format!("missing {name}")); }
            }
        }
        for (name, member) in object {
            let member_schema = schema["properties"].get(name).or_else(|| schema.get("additionalProperties"));
            if let Some(member_schema) = member_schema {
                check(member_schema, member, &format!("{path}/{name}"))?;
            }
        }
    }
    if let Some(values) = value.as_array() {
        if schema["minItems"].as_u64().is_some_and(|min| (values.len() as u64) < min)
            || schema["maxItems"].as_u64().is_some_and(|max| values.len() as u64 > max) {
            return invalid("array length invalid");
        }
        for (index, member) in values.iter().enumerate() {
            let member_schema = schema["prefixItems"].get(index).or_else(|| schema.get("items"));
            if let Some(member_schema) = member_schema {
                check(member_schema, member, &format!("{path}/{index}"))?;
            }
        }
    }
    Ok(())
}

pub(super) fn validate(operation: &str, field: &str, value: &Value) -> Result<(), String> {
    let schema = SCHEMAS["operations"].get(operation).and_then(|entry| entry.get(field))
        .ok_or_else(|| format!("offline_unknown_host_operation: {operation}"))?;
    check(schema, value, field).map_err(|reason| format!("offline_invalid_{field}: {operation}: {reason}"))?;
    if field == "arguments" {
        match operation {
            operation if operation.starts_with("store.") => crate::data_store::validate_request(operation, value).map_err(|error| error.to_string())?,
            "environment.read" => { crate::host::validate_environment_read(value)?; }
            "environment.set" => { crate::host::validate_environment_set(value)?; }
            "events.schedule" | "events.cancel" => { crate::host::validate_timer_request(operation, value)?; }
            _ => {}
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn generated_schema_dialect_checks_tuples_templates_and_closed_records() {
        assert!(check(&json!({"type":"string","format":"dotted-string"}), &json!("a.b"), "").is_ok());
        assert!(check(&json!({"type":"string","format":"dotted-string"}), &json!("ab"), "").is_err());
        assert!(check(&json!({"type":"string","format":"hash-prefixed-string"}), &json!("#aaa"), "").is_ok());
        assert!(check(&json!({"type":"string","format":"hash-prefixed-string"}), &json!("aaa"), "").is_err());
        assert!(check(&json!({"format":"invented"}), &json!("anything"), "").is_err());
        let tuple = json!({"type":"array","prefixItems":[{"type":"string"},{"type":"number"}],"minItems":2,"maxItems":2});
        assert!(check(&tuple, &json!(["x",1]), "").is_ok());
        for value in [json!(["x"]), json!(["x",1,2]), json!(["x","1"])] { assert!(check(&tuple, &value, "").is_err()); }
        assert!(check(&json!({"type":"object","additionalProperties":false}), &json!({"extra":1}), "").is_err());
        assert!(supported(&json!({"futureConstraint":true}), &SCHEMAS).is_err());
        assert!(supported(&json!({"$ref":"#/$defs/missing"}), &SCHEMAS).is_err());
        let mut result = json!({"snapshot":{"reference":"fixture","sha256":"hash"},"candidate_sha256":"hash"});
        assert!(validate("workspace.snapshot", "result", &result).is_ok());
        result["snapshot"]["sha256"] = json!(42);
        assert!(validate("workspace.snapshot", "result", &result).is_err());
    }

    #[test]
    fn generated_schema_covers_every_host_operation() {
        for operation in super::super::MOD_HOST_OPERATIONS {
            assert!(SCHEMAS["operations"][*operation]["arguments"].is_object() || SCHEMAS["operations"][*operation]["arguments"].is_boolean(), "{operation}");
            assert!(SCHEMAS["operations"][*operation]["result"].is_object() || SCHEMAS["operations"][*operation]["result"].is_boolean(), "{operation}");
        }
        assert_eq!(SCHEMAS["operations"].as_object().unwrap().len(), super::super::MOD_HOST_OPERATIONS.len());
    }
}
