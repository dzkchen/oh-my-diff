use serde_json::Value;
use std::io;
use std::path::Path;
use std::path::PathBuf;

const INVENTORY_FILE: &str = "tool-inventory.json";
const TYPES_FILE: &str = "tool-types.d.ts";

fn escape(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

fn kind(value: &Value) -> &'static str {
    match value {
        Value::Null => "null",
        Value::Bool(_) => "boolean",
        Value::Number(_) => "number",
        Value::String(_) => "string",
        Value::Array(_) => "array",
        Value::Object(_) => "object",
    }
}

fn is_type(value: &Value, name: &str) -> bool {
    match name {
        "integer" => value.as_f64().is_some_and(|number| number.fract() == 0.0),
        name => kind(value) == name,
    }
}

fn check(schema: &Value, value: &Value, pointer: &str) -> Result<(), String> {
    let Some(schema) = schema.as_object() else {
        return Ok(());
    };
    let at = |reason: String| {
        let pointer = if pointer.is_empty() { "/" } else { pointer };
        format!("{pointer}: {reason}")
    };
    match schema.get("type") {
        Some(Value::String(name)) if !is_type(value, name) => {
            return Err(at(format!("expected {name}, got {}", kind(value))));
        }
        Some(Value::Array(names))
            if !names
                .iter()
                .filter_map(Value::as_str)
                .any(|name| is_type(value, name)) =>
        {
            return Err(at(format!(
                "expected one of {}",
                Value::Array(names.clone())
            )));
        }
        _ => {}
    }
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array)
        && !allowed.contains(value)
    {
        return Err(at(format!(
            "expected one of {}",
            Value::Array(allowed.clone())
        )));
    }
    if let Some(variants) = schema.get("anyOf").and_then(Value::as_array)
        && !variants
            .iter()
            .any(|variant| check(variant, value, pointer).is_ok())
    {
        return Err(at("matches no anyOf variant".into()));
    }
    if let Some(object) = value.as_object() {
        for name in schema
            .get("required")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            if !object.contains_key(name) {
                return Err(format!("{pointer}/{}: required", escape(name)));
            }
        }
        let properties = schema.get("properties").and_then(Value::as_object);
        for (name, member) in object {
            let child = format!("{pointer}/{}", escape(name));
            match (
                properties.and_then(|known| known.get(name)),
                schema.get("additionalProperties"),
            ) {
                (Some(known), _) => check(known, member, &child)?,
                (None, Some(Value::Bool(false))) => return Err(format!("{child}: not allowed")),
                (None, Some(extra @ Value::Object(_))) => check(extra, member, &child)?,
                _ => {}
            }
        }
    }
    if let (Some(items), Some(values)) = (schema.get("items"), value.as_array()) {
        for (index, member) in values.iter().enumerate() {
            check(items, member, &format!("{pointer}/{index}"))?;
        }
    }
    Ok(())
}

/// Checks `value` against the JSON-schema subset tool parameters use; the error is `<json-pointer>: <reason>`.
pub fn validate(schema: &Value, value: &Value) -> Result<(), String> {
    check(schema, value, "")
}

fn comment(text: &str) -> String {
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    format!("/** {} */", text.replace("*/", "*\\/"))
}

fn documented(text: Option<&str>) -> String {
    text.filter(|text| !text.trim().is_empty())
        .map(|text| format!("{} ", comment(text)))
        .unwrap_or_default()
}

fn union(members: Vec<String>) -> String {
    if members.is_empty() {
        "Json".into()
    } else {
        members.join(" | ")
    }
}

fn named(name: &str, schema: &Value) -> String {
    match name {
        "string" | "boolean" | "null" => name.into(),
        "number" | "integer" => "number".into(),
        "array" => format!(
            "Array<{}>",
            schema.get("items").map_or("Json".into(), ts_type)
        ),
        "object" => object(schema),
        _ => "Json".into(),
    }
}

fn object(schema: &Value) -> String {
    let Some(properties) = schema
        .get("properties")
        .and_then(Value::as_object)
        .filter(|properties| !properties.is_empty())
    else {
        let rest = schema
            .get("additionalProperties")
            .filter(|extra| extra.is_object())
            .map_or("Json".into(), ts_type);
        return format!("Record<string, {rest}>");
    };
    let required = schema
        .get("required")
        .and_then(Value::as_array)
        .map(|names| names.iter().filter_map(Value::as_str).collect::<Vec<_>>())
        .unwrap_or_default();
    let members = properties.iter().map(|(name, member)| {
        let optional = if required.contains(&name.as_str()) {
            ""
        } else {
            "?"
        };
        format!(
            "{}{}{optional}: {};",
            documented(member["description"].as_str()),
            Value::from(name.as_str()),
            ts_type(member)
        )
    });
    format!("{{ {} }}", members.collect::<Vec<_>>().join(" "))
}

pub fn ts_type(schema: &Value) -> String {
    if let Some(allowed) = schema.get("enum").and_then(Value::as_array) {
        let literals = allowed
            .iter()
            .map(|value| (!value.is_array() && !value.is_object()).then(|| value.to_string()))
            .collect::<Option<Vec<_>>>();
        return literals.map_or("Json".into(), union);
    }
    if let Some(variants) = schema.get("anyOf").and_then(Value::as_array) {
        return union(variants.iter().map(ts_type).collect());
    }
    match schema.get("type") {
        Some(Value::String(name)) => named(name, schema),
        Some(Value::Array(names)) => union(
            names
                .iter()
                .filter_map(Value::as_str)
                .map(|name| named(name, schema))
                .collect(),
        ),
        _ => "Json".into(),
    }
}

pub fn types(inventory: &Value) -> String {
    let mut output = String::from(
        "import type { Json } from '@oh-my-diff/mod-api';\n\ndeclare module '@oh-my-diff/mod-api' {\n  interface ToolArguments {\n",
    );
    for tool in inventory["tools"].as_array().into_iter().flatten() {
        let original = &tool["original"];
        let Some(name) = tool["name"].as_str() else {
            continue;
        };
        let arguments = if original["freeform"] == true {
            "string".into()
        } else {
            ts_type(&original["parameters"])
        };
        output.push_str(&format!(
            "    {}{}: {arguments};\n",
            documented(original["description"].as_str()),
            Value::from(name)
        ));
    }
    output.push_str("  }\n}\n");
    output
}

pub fn write_inventory(root: &Path, inventory: &Value) -> io::Result<()> {
    crate::fsio::write_if_changed(&root.join(INVENTORY_FILE), &serde_json::to_vec(inventory)?)
}

pub fn write_types(root: &Path) -> io::Result<()> {
    let Ok(bytes) = std::fs::read(root.join(INVENTORY_FILE)) else {
        return Ok(());
    };
    let inventory = serde_json::from_slice(&bytes)?;
    crate::fsio::write_if_changed(&root.join(TYPES_FILE), types(&inventory).as_bytes())
}

pub fn types_path(root: &Path) -> Option<PathBuf> {
    Some(root.join(TYPES_FILE)).filter(|path| path.exists())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn schema() -> Value {
        json!({"type": "object", "properties": {
            "cmd": {"type": "string", "description": "shell */ command"},
            "mode": {"enum": ["a", "b"]},
            "paths": {"type": "array", "items": {"anyOf": [{"type": "string"}, {"type": "number"}]}},
            "timeout": {"type": ["integer", "null"]}},
            "required": ["cmd"], "additionalProperties": false})
    }

    #[test]
    fn validation_refuses_with_a_pointer_and_reason() {
        let schema = schema();
        assert_eq!(
            validate(&schema, &json!({"cmd": "ls", "timeout": 3})),
            Ok(())
        );
        let refusals = [
            (json!({}), "/cmd: required"),
            (json!({"cmd": 1}), "/cmd: expected string, got number"),
            (
                json!({"cmd": "x", "timeout": 1.5}),
                "/timeout: expected one of [\"integer\",\"null\"]",
            ),
            (
                json!({"cmd": "x", "mode": "c"}),
                "/mode: expected one of [\"a\",\"b\"]",
            ),
            (
                json!({"cmd": "x", "paths": ["a", null]}),
                "/paths/1: matches no anyOf variant",
            ),
            (json!({"cmd": "x", "extra": 1}), "/extra: not allowed"),
            (json!("x"), "/: expected object, got string"),
        ];
        for (arguments, reason) in refusals {
            assert_eq!(validate(&schema, &arguments), Err(reason.to_owned()));
        }
    }

    #[test]
    fn types_convert_the_schema_subset_and_default_to_json() {
        let inventory = json!({"tools": [
            {"name": "run", "original": {"description": "Run */ it", "freeform": false, "parameters": schema()}},
            {"name": "patch", "original": {"description": "", "freeform": true, "parameters": null}},
            {"name": "odd", "original": {"description": "", "freeform": false, "parameters": {"$ref": "#/x"}}}]});
        let output = types(&inventory);
        assert!(
            output.contains("\"run\": { /** shell *\\/ command */ \"cmd\": string; \"mode\"?: \"a\" | \"b\"; \"paths\"?: Array<string | number>; \"timeout\"?: number | null; };"),
            "{output}"
        );
        assert!(output.contains("/** Run *\\/ it */ \"run\""));
        assert!(output.contains("    \"patch\": string;"));
        assert!(output.contains("    \"odd\": Json;"));
    }
}
