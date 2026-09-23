use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::fs::OpenOptions;
use std::io;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;

pub const CODE_GRAPH_SCHEMA: u32 = 1;
pub const CODE_GRAPH_GENERATOR: &str = "omd-bounded-code-graph-v1";
const MAX_GRAPH_BYTES: usize = 16 * 1024 * 1024;
const MAX_FILE_BYTES: usize = 1024 * 1024;
const MAX_SELECTION_BYTES: usize = 256 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GraphLimits {
    pub max_files: usize,
    pub max_source_bytes: usize,
    pub max_nodes: usize,
    pub max_edges: usize,
    pub max_unknown_targets: usize,
    pub max_selection_bytes: usize,
}

impl Default for GraphLimits {
    fn default() -> Self {
        Self {
            max_files: 4_096,
            max_source_bytes: 32 * 1024 * 1024,
            max_nodes: 20_000,
            max_edges: 50_000,
            max_unknown_targets: 2_048,
            max_selection_bytes: 64 * 1024,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GraphRepository {
    pub identity: String,
    pub root: PathBuf,
    pub revision: String,
    pub source_digest: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum GraphLanguage {
    Rust,
    Python,
    TypeScript,
    JavaScript,
    Java,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GraphSource {
    pub path: PathBuf,
    pub language: GraphLanguage,
    pub bytes: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct GraphAnchor {
    pub path: PathBuf,
    pub start_line: usize,
    pub end_line: usize,
    pub sha256: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum GraphNodeKind {
    Module,
    Symbol,
    Test,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GraphNode {
    pub id: String,
    pub kind: GraphNodeKind,
    pub name: String,
    pub symbol_kind: Option<String>,
    pub anchor: Option<GraphAnchor>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum GraphRelationship {
    Contains,
    Imports,
    Calls,
    Tests,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(rename_all = "snake_case")]
pub enum GraphConfidence {
    Extracted,
    Inferred,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
#[serde(deny_unknown_fields)]
pub struct GraphEdge {
    pub from: String,
    pub to: String,
    pub relationship: GraphRelationship,
    pub confidence: GraphConfidence,
    pub evidence: GraphAnchor,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GraphCoverage {
    pub path: PathBuf,
    pub parser: String,
    pub extracted_relationships: usize,
    pub inferred_relationships: usize,
    pub unknown_relationships: usize,
    pub unknown_examples: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct CodeGraph {
    pub schema: u32,
    pub generator: String,
    pub repository: GraphRepository,
    pub limits: GraphLimits,
    pub sources: Vec<GraphSource>,
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
    pub coverage: Vec<GraphCoverage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum GraphFreshness {
    Fresh,
    Stale {
        added: Vec<PathBuf>,
        changed: Vec<PathBuf>,
        missing: Vec<PathBuf>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct GraphEvidenceSelection {
    pub schema: u32,
    pub graph_schema: u32,
    pub graph_generator: String,
    pub repository_identity: String,
    pub revision: String,
    pub source_digest: String,
    pub nodes: Vec<GraphNode>,
    pub relationships: Vec<GraphEdge>,
    pub coverage: Vec<GraphCoverage>,
}

#[derive(Clone)]
struct Definition {
    name: String,
    kind: String,
    line: usize,
    is_test: bool,
    node_id: String,
}

struct ParsedFile {
    source: GraphSource,
    text: String,
    definitions: Vec<Definition>,
    imports: Vec<(usize, String)>,
    calls: Vec<(usize, String)>,
}

fn invalid(message: impl Into<String>) -> io::Error {
    io::Error::new(io::ErrorKind::InvalidData, message.into())
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn valid_sha256(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn valid_limits(limits: GraphLimits) -> bool {
    (1..=4_096).contains(&limits.max_files)
        && (1..=32 * 1024 * 1024).contains(&limits.max_source_bytes)
        && (1..=20_000).contains(&limits.max_nodes)
        && (1..=50_000).contains(&limits.max_edges)
        && (1..=2_048).contains(&limits.max_unknown_targets)
        && (1..=MAX_SELECTION_BYTES).contains(&limits.max_selection_bytes)
}

fn clean_relative(path: &Path) -> bool {
    !path.as_os_str().is_empty()
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn language(path: &Path) -> Option<GraphLanguage> {
    match path.extension().and_then(|value| value.to_str())? {
        "rs" => Some(GraphLanguage::Rust),
        "py" => Some(GraphLanguage::Python),
        "ts" | "tsx" => Some(GraphLanguage::TypeScript),
        "js" | "jsx" | "mjs" | "cjs" => Some(GraphLanguage::JavaScript),
        "java" => Some(GraphLanguage::Java),
        _ => None,
    }
}

fn skipped_directory(name: &str) -> bool {
    name.starts_with('.')
        || matches!(
            name,
            "node_modules"
                | "target"
                | "dist"
                | "build"
                | "vendor"
                | "vendors"
                | "venv"
                | "__pycache__"
                | "coverage"
        )
}

fn collect_paths(root: &Path, directory: &Path, out: &mut Vec<PathBuf>) -> io::Result<()> {
    let mut entries = fs::read_dir(directory)?.collect::<Result<Vec<_>, _>>()?;
    entries.sort_by_key(|entry| entry.file_name());
    for entry in entries {
        let metadata = fs::symlink_metadata(entry.path())?;
        if metadata.file_type().is_symlink() {
            continue;
        }
        if metadata.is_dir() {
            if !skipped_directory(&entry.file_name().to_string_lossy()) {
                collect_paths(root, &entry.path(), out)?;
            }
        } else if metadata.is_file() {
            let relative = entry
                .path()
                .strip_prefix(root)
                .map_err(|_| invalid("source path escaped repository"))?
                .to_path_buf();
            if language(&relative).is_some() {
                out.push(relative);
            }
        }
    }
    Ok(())
}

fn safe_source_path(root: &Path, relative: &Path) -> io::Result<PathBuf> {
    if !clean_relative(relative) {
        return Err(invalid("unsafe source path"));
    }
    let mut current = root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(component) = component else {
            return Err(invalid("unsafe source path"));
        };
        current.push(component);
        if fs::symlink_metadata(&current)?.file_type().is_symlink() {
            return Err(invalid("symlink in graph source path"));
        }
    }
    Ok(current)
}

fn identifier_after(line: &str, marker: &str) -> Option<String> {
    let index = line.find(marker)? + marker.len();
    let rest = line[index..].trim_start();
    let name = rest
        .chars()
        .take_while(|value| value.is_ascii_alphanumeric() || *value == '_')
        .collect::<String>();
    (!name.is_empty()).then_some(name)
}

fn rust_definition(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    for (marker, kind) in [
        ("fn ", "function"),
        ("struct ", "type"),
        ("enum ", "type"),
        ("trait ", "type"),
        ("mod ", "module"),
        ("type ", "type"),
    ] {
        if let Some(name) = identifier_after(trimmed, marker) {
            let prefix = &trimmed[..trimmed.find(marker)?];
            if prefix.split_whitespace().all(|part| {
                matches!(
                    part,
                    "pub" | "async" | "unsafe" | "const" | "extern" | "default" | "(crate)"
                ) || part.starts_with("pub(")
            }) {
                return Some((name, kind.to_string()));
            }
        }
    }
    None
}

fn python_definition(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    for (marker, kind) in [
        ("def ", "function"),
        ("async def ", "function"),
        ("class ", "type"),
    ] {
        if trimmed.starts_with(marker) {
            return identifier_after(trimmed, marker).map(|name| (name, kind.to_string()));
        }
    }
    None
}

fn script_definition(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    for (marker, kind) in [
        ("function ", "function"),
        ("class ", "type"),
        ("interface ", "type"),
        ("type ", "type"),
        ("enum ", "type"),
    ] {
        if let Some(name) = identifier_after(trimmed, marker) {
            let prefix = &trimmed[..trimmed.find(marker)?];
            if prefix
                .split_whitespace()
                .all(|part| matches!(part, "export" | "default" | "async" | "declare"))
            {
                return Some((name, kind.to_string()));
            }
        }
    }
    for marker in ["const ", "let ", "var "] {
        if let Some(name) = identifier_after(trimmed, marker) {
            let prefix = &trimmed[..trimmed.find(marker)?];
            if prefix
                .split_whitespace()
                .all(|part| matches!(part, "export" | "default" | "declare"))
                && (trimmed.contains("=>") || trimmed.contains("function"))
            {
                return Some((name, "function".to_string()));
            }
        }
    }
    None
}

fn java_definition(line: &str) -> Option<(String, String)> {
    let trimmed = line.trim_start();
    for (marker, kind) in [
        ("class ", "type"),
        ("interface ", "type"),
        ("enum ", "type"),
        ("record ", "type"),
    ] {
        if let Some(name) = identifier_after(trimmed, marker) {
            return Some((name, kind.to_string()));
        }
    }
    let before = trimmed.split_once('(')?.0.trim_end();
    let name = before
        .split_whitespace()
        .last()?
        .trim_matches(|value: char| !value.is_ascii_alphanumeric() && value != '_');
    if name.is_empty() || matches!(name, "if" | "for" | "while" | "switch" | "catch") {
        None
    } else {
        Some((name.to_string(), "function".to_string()))
    }
}

fn definition(line: &str, language: GraphLanguage) -> Option<(String, String)> {
    match language {
        GraphLanguage::Rust => rust_definition(line),
        GraphLanguage::Python => python_definition(line),
        GraphLanguage::TypeScript | GraphLanguage::JavaScript => script_definition(line),
        GraphLanguage::Java => java_definition(line),
    }
}

fn quoted_value(line: &str) -> Option<String> {
    let mut quote = None;
    let mut start = 0;
    for (index, value) in line.char_indices() {
        if quote == Some(value) {
            return Some(line[start..index].to_string());
        }
        if quote.is_none() && matches!(value, '\'' | '"') {
            quote = Some(value);
            start = index + value.len_utf8();
        }
    }
    None
}

fn import_value(line: &str, language: GraphLanguage) -> Option<String> {
    let trimmed = line.trim();
    match language {
        GraphLanguage::Rust => {
            if let Some(import) = trimmed.strip_prefix("use ") {
                Some(
                    import
                        .trim_end_matches(';')
                        .split('{')
                        .next()?
                        .trim()
                        .to_string(),
                )
            } else if trimmed.starts_with("mod ") {
                identifier_after(trimmed, "mod ")
            } else {
                None
            }
        }
        GraphLanguage::Python => {
            if let Some(rest) = trimmed.strip_prefix("from ") {
                Some(rest.split_whitespace().next()?.to_string())
            } else {
                trimmed.strip_prefix("import ").map(|rest| {
                    rest.split_whitespace()
                        .next()
                        .unwrap_or(rest)
                        .trim_end_matches(',')
                        .to_string()
                })
            }
        }
        GraphLanguage::TypeScript | GraphLanguage::JavaScript => {
            if trimmed.starts_with("import ") || trimmed.contains("require(") {
                quoted_value(trimmed)
            } else {
                None
            }
        }
        GraphLanguage::Java => trimmed
            .strip_prefix("import ")
            .map(|rest| rest.trim_end_matches(';').to_string()),
    }
}

fn call_names(line: &str) -> Vec<String> {
    let bytes = line.as_bytes();
    let mut names = Vec::new();
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index].is_ascii_alphabetic() || bytes[index] == b'_' {
            let start = index;
            index += 1;
            while index < bytes.len()
                && (bytes[index].is_ascii_alphanumeric() || bytes[index] == b'_')
            {
                index += 1;
            }
            let mut cursor = index;
            while cursor < bytes.len() && bytes[cursor].is_ascii_whitespace() {
                cursor += 1;
            }
            if cursor < bytes.len() && bytes[cursor] == b'(' {
                let name = &line[start..index];
                if !matches!(
                    name,
                    "if" | "for"
                        | "while"
                        | "match"
                        | "loop"
                        | "switch"
                        | "catch"
                        | "return"
                        | "sizeof"
                        | "Some"
                        | "Ok"
                        | "Err"
                        | "println"
                        | "print"
                ) {
                    names.push(name.to_string());
                }
            }
        } else {
            index += 1;
        }
    }
    names
}

fn line_anchor(source: &GraphSource, line_number: usize, line: &str) -> GraphAnchor {
    GraphAnchor {
        path: source.path.clone(),
        start_line: line_number,
        end_line: line_number,
        sha256: sha256(line.as_bytes()),
    }
}

fn source_digest(sources: &[GraphSource]) -> String {
    let mut hasher = Sha256::new();
    for source in sources {
        hasher.update(source.path.to_string_lossy().as_bytes());
        hasher.update([0]);
        hasher.update(source.sha256.as_bytes());
        hasher.update([0]);
    }
    format!("{:x}", hasher.finalize())
}

fn unknown_id(label: &str) -> String {
    format!("unknown:{}", &sha256(label.as_bytes())[..16])
}

fn module_id(path: &Path) -> String {
    format!("module:{}", path.to_string_lossy())
}

fn resolve_import(path: &Path, raw: &str, sources: &BTreeSet<PathBuf>) -> Option<PathBuf> {
    let parent = path.parent().unwrap_or_else(|| Path::new(""));
    let mut bases = if raw.starts_with("./") || raw.starts_with("../") {
        vec![parent.join(raw)]
    } else if raw.starts_with("self::") {
        let normalized = raw.replace("::", "/");
        vec![parent.join(normalized.trim_start_matches("self/"))]
    } else if raw.starts_with("super::") {
        let normalized = raw.replace("::", "/");
        vec![
            parent
                .parent()
                .unwrap_or(parent)
                .join(normalized.trim_start_matches("super/")),
        ]
    } else {
        let normalized = PathBuf::from(
            raw.trim_start_matches("crate::")
                .replace("::", "/")
                .replace('.', "/"),
        );
        vec![
            normalized.clone(),
            parent.join(&normalized),
            Path::new("src").join(normalized),
        ]
    };
    if path.extension().and_then(|value| value.to_str()) == Some("rs") {
        let normalized = raw.trim_start_matches("crate::").replace("::", "/");
        let parts = normalized.split('/').collect::<Vec<_>>();
        for length in (1..parts.len()).rev() {
            let prefix = parts[..length].join("/");
            bases.push(parent.join(&prefix));
            bases.push(Path::new("src").join(prefix));
        }
    }
    let mut candidates = Vec::new();
    for relative in bases {
        if relative.extension().is_some() {
            candidates.push(relative.clone());
        }
        for extension in ["rs", "py", "ts", "tsx", "js", "jsx", "java"] {
            candidates.push(relative.with_extension(extension));
        }
        for name in [
            "mod.rs",
            "__init__.py",
            "index.ts",
            "index.tsx",
            "index.js",
            "index.jsx",
        ] {
            candidates.push(relative.join(name));
        }
    }
    candidates
        .into_iter()
        .find(|candidate| sources.contains(candidate))
}

impl CodeGraph {
    pub fn build(
        repository: &Path,
        repository_identity: String,
        revision: String,
        limits: GraphLimits,
    ) -> io::Result<Self> {
        if repository_identity.trim().is_empty() || revision.trim().is_empty() {
            return Err(invalid("repository identity and revision are required"));
        }
        if !valid_limits(limits) {
            return Err(invalid("graph limits are outside global bounds"));
        }
        let root = repository.canonicalize()?;
        if !root.is_dir() {
            return Err(invalid("repository root must be a directory"));
        }
        let mut paths = Vec::new();
        collect_paths(&root, &root, &mut paths)?;
        paths.sort();
        if paths.len() > limits.max_files {
            return Err(invalid("graph source file limit exceeded"));
        }
        let mut total_bytes = 0usize;
        let mut parsed = Vec::new();
        for path in paths {
            if !clean_relative(&path) {
                return Err(invalid("unsafe source path"));
            }
            let bytes = fs::read(safe_source_path(&root, &path)?)?;
            if bytes.len() > MAX_FILE_BYTES {
                return Err(invalid(format!(
                    "source file exceeds size limit: {}",
                    path.display()
                )));
            }
            total_bytes = total_bytes
                .checked_add(bytes.len())
                .ok_or_else(|| invalid("source size overflow"))?;
            if total_bytes > limits.max_source_bytes {
                return Err(invalid("graph source byte limit exceeded"));
            }
            let text = String::from_utf8(bytes.clone())
                .map_err(|_| invalid(format!("source is not UTF-8: {}", path.display())))?;
            let source = GraphSource {
                language: language(&path).ok_or_else(|| invalid("unsupported source language"))?,
                path: path.clone(),
                bytes: bytes.len(),
                sha256: sha256(&bytes),
            };
            let mut definitions = Vec::new();
            let mut imports = Vec::new();
            let mut calls = Vec::new();
            for (offset, line) in text.lines().enumerate() {
                let line_number = offset + 1;
                if let Some((name, kind)) = definition(line, source.language) {
                    let path_is_test = path.components().any(|part| {
                        matches!(
                            part.as_os_str().to_str(),
                            Some("test" | "tests" | "__tests__")
                        )
                    });
                    let is_test =
                        path_is_test || name.starts_with("test_") || name.ends_with("Test");
                    definitions.push(Definition {
                        node_id: format!("symbol:{}:{line_number}:{name}", path.to_string_lossy()),
                        name,
                        kind,
                        line: line_number,
                        is_test,
                    });
                }
                if let Some(value) = import_value(line, source.language) {
                    imports.push((line_number, value));
                }
                for name in call_names(line) {
                    calls.push((line_number, name));
                }
            }
            parsed.push(ParsedFile {
                source,
                text,
                definitions,
                imports,
                calls,
            });
        }
        let sources = parsed
            .iter()
            .map(|file| file.source.clone())
            .collect::<Vec<_>>();
        let source_paths = sources
            .iter()
            .map(|source| source.path.clone())
            .collect::<BTreeSet<_>>();
        let mut nodes = BTreeMap::new();
        let mut definitions_by_name: BTreeMap<String, Vec<(PathBuf, Definition)>> = BTreeMap::new();
        let mut edges = Vec::new();
        for file in &parsed {
            let first_line = file.text.lines().next().unwrap_or("");
            let module = GraphNode {
                id: module_id(&file.source.path),
                kind: GraphNodeKind::Module,
                name: file.source.path.to_string_lossy().to_string(),
                symbol_kind: Some(format!("{:?}", file.source.language).to_ascii_lowercase()),
                anchor: Some(line_anchor(&file.source, 1, first_line)),
            };
            nodes.insert(module.id.clone(), module);
            for definition in &file.definitions {
                let line = file.text.lines().nth(definition.line - 1).unwrap_or("");
                let node = GraphNode {
                    id: definition.node_id.clone(),
                    kind: if definition.is_test {
                        GraphNodeKind::Test
                    } else {
                        GraphNodeKind::Symbol
                    },
                    name: definition.name.clone(),
                    symbol_kind: Some(definition.kind.clone()),
                    anchor: Some(line_anchor(&file.source, definition.line, line)),
                };
                nodes.insert(node.id.clone(), node);
                definitions_by_name
                    .entry(definition.name.clone())
                    .or_default()
                    .push((file.source.path.clone(), definition.clone()));
                edges.push(GraphEdge {
                    from: module_id(&file.source.path),
                    to: definition.node_id.clone(),
                    relationship: GraphRelationship::Contains,
                    confidence: GraphConfidence::Extracted,
                    evidence: line_anchor(&file.source, definition.line, line),
                    detail: format!("{} definition", definition.kind),
                });
            }
        }
        if nodes.len() > limits.max_nodes {
            return Err(invalid("graph node limit exceeded"));
        }
        let mut unknowns = BTreeSet::new();
        let mut coverage = Vec::new();
        for file in &parsed {
            let mut extracted = file.definitions.len();
            let mut inferred = 0usize;
            let mut unknown = 0usize;
            let mut unknown_examples = BTreeSet::new();
            for (line_number, raw) in &file.imports {
                let line = file.text.lines().nth(line_number - 1).unwrap_or("");
                let (to, confidence, detail) =
                    if let Some(target) = resolve_import(&file.source.path, raw, &source_paths) {
                        (
                            module_id(&target),
                            GraphConfidence::Extracted,
                            format!("resolved import {raw}"),
                        )
                    } else {
                        let id = unknown_id(&format!("import:{raw}"));
                        unknowns.insert(id.clone());
                        nodes.entry(id.clone()).or_insert(GraphNode {
                            id: id.clone(),
                            kind: GraphNodeKind::Unknown,
                            name: raw.clone(),
                            symbol_kind: Some("unresolved_import".to_string()),
                            anchor: None,
                        });
                        unknown += 1;
                        unknown_examples.insert(format!("import:{raw}"));
                        (
                            id,
                            GraphConfidence::Unknown,
                            format!("unresolved import {raw}"),
                        )
                    };
                if confidence == GraphConfidence::Extracted {
                    extracted += 1;
                }
                edges.push(GraphEdge {
                    from: module_id(&file.source.path),
                    to,
                    relationship: GraphRelationship::Imports,
                    confidence,
                    evidence: line_anchor(&file.source, *line_number, line),
                    detail,
                });
            }
            for (line_number, name) in &file.calls {
                if file
                    .definitions
                    .iter()
                    .any(|item| item.line == *line_number && item.name == *name)
                {
                    continue;
                }
                let caller = file
                    .definitions
                    .iter()
                    .filter(|item| item.line <= *line_number)
                    .max_by_key(|item| item.line)
                    .map(|item| item.node_id.clone())
                    .unwrap_or_else(|| module_id(&file.source.path));
                let matches = definitions_by_name.get(name).cloned().unwrap_or_default();
                let local = matches
                    .iter()
                    .filter(|(path, _)| path == &file.source.path)
                    .collect::<Vec<_>>();
                let target = if local.len() == 1 {
                    Some(local[0].1.node_id.clone())
                } else if matches.len() == 1 {
                    Some(matches[0].1.node_id.clone())
                } else {
                    None
                };
                let (to, confidence, detail) = if let Some(target) = target {
                    inferred += 1;
                    (
                        target,
                        GraphConfidence::Inferred,
                        format!("lexical call {name}"),
                    )
                } else {
                    let label = if matches.is_empty() {
                        format!("call:{name}")
                    } else {
                        format!("ambiguous_call:{name}")
                    };
                    let id = unknown_id(&label);
                    unknowns.insert(id.clone());
                    nodes.entry(id.clone()).or_insert(GraphNode {
                        id: id.clone(),
                        kind: GraphNodeKind::Unknown,
                        name: name.clone(),
                        symbol_kind: Some(
                            if matches.is_empty() {
                                "unresolved_call"
                            } else {
                                "ambiguous_call"
                            }
                            .to_string(),
                        ),
                        anchor: None,
                    });
                    unknown += 1;
                    unknown_examples.insert(label.clone());
                    (id, GraphConfidence::Unknown, label)
                };
                let relationship = if nodes
                    .get(&caller)
                    .is_some_and(|node| node.kind == GraphNodeKind::Test)
                {
                    GraphRelationship::Tests
                } else {
                    GraphRelationship::Calls
                };
                let line = file.text.lines().nth(line_number - 1).unwrap_or("");
                edges.push(GraphEdge {
                    from: caller,
                    to,
                    relationship,
                    confidence,
                    evidence: line_anchor(&file.source, *line_number, line),
                    detail,
                });
            }
            coverage.push(GraphCoverage {
                path: file.source.path.clone(),
                parser: "bounded_lexical_v1".to_string(),
                extracted_relationships: extracted,
                inferred_relationships: inferred,
                unknown_relationships: unknown,
                unknown_examples: unknown_examples.into_iter().take(8).collect(),
            });
        }
        if unknowns.len() > limits.max_unknown_targets {
            return Err(invalid("graph unknown-target limit exceeded"));
        }
        if nodes.len() > limits.max_nodes {
            return Err(invalid("graph node limit exceeded"));
        }
        edges.sort_by(|left, right| {
            (
                &left.from,
                &left.to,
                left.relationship,
                left.confidence,
                &left.evidence.path,
                left.evidence.start_line,
            )
                .cmp(&(
                    &right.from,
                    &right.to,
                    right.relationship,
                    right.confidence,
                    &right.evidence.path,
                    right.evidence.start_line,
                ))
        });
        edges.dedup();
        if edges.len() > limits.max_edges {
            return Err(invalid("graph edge limit exceeded"));
        }
        let graph = Self {
            schema: CODE_GRAPH_SCHEMA,
            generator: CODE_GRAPH_GENERATOR.to_string(),
            repository: GraphRepository {
                identity: repository_identity,
                root,
                revision,
                source_digest: source_digest(&sources),
            },
            limits,
            sources,
            nodes: nodes.into_values().collect(),
            edges,
            coverage,
        };
        graph.validate()?;
        Ok(graph)
    }

    pub fn read(path: &Path) -> io::Result<Self> {
        let bytes = fs::read(path)?;
        if bytes.len() > MAX_GRAPH_BYTES {
            return Err(invalid("graph snapshot exceeds size limit"));
        }
        let graph: Self =
            serde_json::from_slice(&bytes).map_err(|error| invalid(error.to_string()))?;
        graph.validate()?;
        Ok(graph)
    }

    pub fn write(&self, path: &Path) -> io::Result<()> {
        self.validate()?;
        let bytes = serde_json::to_vec_pretty(self).map_err(|error| invalid(error.to_string()))?;
        if bytes.len() > MAX_GRAPH_BYTES {
            return Err(invalid("graph snapshot exceeds size limit"));
        }
        atomic_write(path, &bytes)
    }

    pub fn validate(&self) -> io::Result<()> {
        if self.schema != CODE_GRAPH_SCHEMA || self.generator != CODE_GRAPH_GENERATOR {
            return Err(invalid("unsupported code graph version"));
        }
        if !valid_limits(self.limits)
            || self.repository.identity.trim().is_empty()
            || self.repository.identity.len() > 256
            || self.repository.revision.trim().is_empty()
            || self.repository.revision.len() > 256
            || !self.repository.root.is_absolute()
            || !valid_sha256(&self.repository.source_digest)
        {
            return Err(invalid("invalid graph metadata or limits"));
        }
        let total_source_bytes = self
            .sources
            .iter()
            .try_fold(0usize, |total, source| total.checked_add(source.bytes));
        if self.sources.len() > self.limits.max_files
            || total_source_bytes.is_none_or(|total| total > self.limits.max_source_bytes)
            || self.nodes.len() > self.limits.max_nodes
            || self.edges.len() > self.limits.max_edges
        {
            return Err(invalid("graph exceeds recorded limits"));
        }
        if source_digest(&self.sources) != self.repository.source_digest {
            return Err(invalid("graph source digest mismatch"));
        }
        let mut source_paths = BTreeSet::new();
        for source in &self.sources {
            if !clean_relative(&source.path)
                || !valid_sha256(&source.sha256)
                || language(&source.path) != Some(source.language)
                || !source_paths.insert(source.path.clone())
            {
                return Err(invalid("invalid or duplicate graph source"));
            }
        }
        if self
            .sources
            .windows(2)
            .any(|pair| pair[0].path >= pair[1].path)
        {
            return Err(invalid("graph sources are not canonical"));
        }
        let mut node_ids = BTreeSet::new();
        for node in &self.nodes {
            if node.id.is_empty() || !node_ids.insert(node.id.clone()) {
                return Err(invalid("invalid or duplicate graph node"));
            }
            if let Some(anchor) = &node.anchor {
                validate_anchor(anchor, &source_paths)?;
            } else if node.kind != GraphNodeKind::Unknown {
                return Err(invalid("source node is missing its anchor"));
            }
        }
        if self.nodes.windows(2).any(|pair| pair[0].id >= pair[1].id) {
            return Err(invalid("graph nodes are not canonical"));
        }
        if self
            .nodes
            .iter()
            .filter(|node| node.kind == GraphNodeKind::Unknown)
            .count()
            > self.limits.max_unknown_targets
        {
            return Err(invalid("graph exceeds recorded unknown-target limit"));
        }
        for edge in &self.edges {
            if !node_ids.contains(&edge.from) || !node_ids.contains(&edge.to) {
                return Err(invalid("graph edge references unknown node"));
            }
            validate_anchor(&edge.evidence, &source_paths)?;
        }
        if self.edges.windows(2).any(|pair| pair[0] >= pair[1]) {
            return Err(invalid("graph relationships are not canonical"));
        }
        let coverage_paths = self
            .coverage
            .iter()
            .map(|item| item.path.clone())
            .collect::<BTreeSet<_>>();
        if self.coverage.len() != self.sources.len() || coverage_paths != source_paths {
            return Err(invalid("graph coverage does not match sources"));
        }
        Ok(())
    }

    pub fn freshness(&self, repository: &Path) -> io::Result<GraphFreshness> {
        let root = repository.canonicalize()?;
        if root != self.repository.root {
            return Err(invalid("graph belongs to a different repository root"));
        }
        let mut current_paths = Vec::new();
        collect_paths(&root, &root, &mut current_paths)?;
        current_paths.sort();
        let recorded = self
            .sources
            .iter()
            .map(|source| source.path.clone())
            .collect::<BTreeSet<_>>();
        let added = current_paths
            .into_iter()
            .filter(|path| !recorded.contains(path))
            .collect::<Vec<_>>();
        let mut changed = Vec::new();
        let mut missing = Vec::new();
        for source in &self.sources {
            match safe_source_path(&root, &source.path).and_then(fs::read) {
                Ok(bytes) if sha256(&bytes) == source.sha256 => {}
                Ok(_) => changed.push(source.path.clone()),
                Err(error) if error.kind() == io::ErrorKind::NotFound => {
                    missing.push(source.path.clone())
                }
                Err(error) => return Err(error),
            }
        }
        if added.is_empty() && changed.is_empty() && missing.is_empty() {
            Ok(GraphFreshness::Fresh)
        } else {
            Ok(GraphFreshness::Stale {
                added,
                changed,
                missing,
            })
        }
    }

    pub fn select(&self, ids: &[String]) -> io::Result<GraphEvidenceSelection> {
        if ids.is_empty() {
            return Err(invalid("at least one graph node must be selected"));
        }
        let selected = ids.iter().cloned().collect::<BTreeSet<_>>();
        if selected.len() != ids.len() {
            return Err(invalid("duplicate graph selection"));
        }
        let nodes_by_id = self
            .nodes
            .iter()
            .map(|node| (&node.id, node))
            .collect::<BTreeMap<_, _>>();
        if selected.iter().any(|id| !nodes_by_id.contains_key(id)) {
            return Err(invalid("unknown graph selection"));
        }
        let relationships = self
            .edges
            .iter()
            .filter(|edge| selected.contains(&edge.from) || selected.contains(&edge.to))
            .cloned()
            .collect::<Vec<_>>();
        let related_ids = relationships
            .iter()
            .flat_map(|edge| [edge.from.clone(), edge.to.clone()])
            .chain(selected.iter().cloned())
            .collect::<BTreeSet<_>>();
        let paths = related_ids
            .iter()
            .filter_map(|id| {
                nodes_by_id
                    .get(id)
                    .and_then(|node| node.anchor.as_ref())
                    .map(|anchor| anchor.path.clone())
            })
            .collect::<BTreeSet<_>>();
        let selection = GraphEvidenceSelection {
            schema: 1,
            graph_schema: self.schema,
            graph_generator: self.generator.clone(),
            repository_identity: self.repository.identity.clone(),
            revision: self.repository.revision.clone(),
            source_digest: self.repository.source_digest.clone(),
            nodes: related_ids
                .into_iter()
                .filter_map(|id| nodes_by_id.get(&id).map(|node| (*node).clone()))
                .collect(),
            relationships,
            coverage: self
                .coverage
                .iter()
                .filter(|item| paths.contains(&item.path))
                .cloned()
                .collect(),
        };
        let bytes = serde_json::to_vec(&selection).map_err(|error| invalid(error.to_string()))?;
        if bytes.len() > self.limits.max_selection_bytes {
            return Err(invalid("graph evidence selection exceeds size limit"));
        }
        Ok(selection)
    }

    pub fn selection_prompt(&self, ids: &[String]) -> io::Result<String> {
        let selection = self.select(ids)?;
        Ok(format!(
            "Use this version-bound code-graph evidence. Verify inferred and unknown relationships against source before relying on them.\n```json\n{}\n```\n",
            serde_json::to_string_pretty(&selection).map_err(|error| invalid(error.to_string()))?
        ))
    }

    pub fn html(&self) -> io::Result<String> {
        self.validate()?;
        let mut json = serde_json::to_string(self).map_err(|error| invalid(error.to_string()))?;
        json = json
            .replace('<', "\\u003c")
            .replace('>', "\\u003e")
            .replace('&', "\\u0026");
        Ok(HTML_TEMPLATE.replace("__GRAPH_JSON__", &json))
    }

    pub fn write_html(&self, path: &Path) -> io::Result<()> {
        atomic_write(path, self.html()?.as_bytes())
    }
}

fn validate_anchor(anchor: &GraphAnchor, sources: &BTreeSet<PathBuf>) -> io::Result<()> {
    if !sources.contains(&anchor.path)
        || anchor.start_line == 0
        || anchor.end_line < anchor.start_line
        || !valid_sha256(&anchor.sha256)
    {
        return Err(invalid("invalid graph source anchor"));
    }
    Ok(())
}

fn atomic_write(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| invalid("output parent is missing"))?;
    fs::create_dir_all(parent)?;
    for attempt in 0..16 {
        let temporary = parent.join(format!(".omd-graph-{}-{attempt}.tmp", std::process::id()));
        match OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)
        {
            Ok(mut file) => {
                file.write_all(bytes)?;
                file.sync_all()?;
                drop(file);
                if let Err(error) = fs::rename(&temporary, path) {
                    let _ = fs::remove_file(&temporary);
                    return Err(error);
                }
                return Ok(());
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error),
        }
    }
    Err(invalid("could not reserve graph output"))
}

const HTML_TEMPLATE: &str = r#"<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Oh My Diff code graph</title><style>
:root{color-scheme:dark;background:#101318;color:#e8edf2;font:14px ui-monospace,SFMono-Regular,Menlo,monospace}*{box-sizing:border-box}body{margin:0}header{padding:16px 20px;border-bottom:1px solid #303944;display:flex;gap:18px;align-items:center;flex-wrap:wrap}h1{font-size:17px;margin:0;color:#8de3c2}input,select,button{font:inherit;color:inherit;background:#171c23;border:1px solid #3a4654;border-radius:5px;padding:7px 9px}button{cursor:pointer}.meta{color:#94a1ad}.layout{display:grid;grid-template-columns:minmax(260px,32%) 1fr;height:calc(100vh - 70px)}aside{overflow:auto;border-right:1px solid #303944;padding:10px}.node{padding:8px;border-radius:5px;cursor:pointer;border:1px solid transparent}.node:hover,.node.active{background:#1b242d;border-color:#3b8f77}.node small{display:block;color:#94a1ad;margin-top:3px}main{overflow:auto;padding:18px}.toolbar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:12px}svg{width:100%;height:360px;background:#0c0f13;border:1px solid #303944;border-radius:6px}.edge{stroke:#657381;stroke-width:1.4}.edge.inferred{stroke-dasharray:5 4}.edge.unknown{stroke:#d7a34a;stroke-dasharray:2 4}.bubble{fill:#1b242d;stroke:#65c6a5;stroke-width:1.5;cursor:pointer}.bubble.unknown{stroke:#d7a34a}.label{fill:#e8edf2;font-size:11px;pointer-events:none}.details{white-space:pre-wrap;line-height:1.5;background:#171c23;padding:12px;border-radius:6px;margin-top:12px}.source{color:#8de3c2}.warning{color:#e5b95c}@media(max-width:760px){.layout{grid-template-columns:1fr;height:auto}aside{max-height:42vh;border-right:0;border-bottom:1px solid #303944}main{min-height:58vh}}
</style></head><body><header><h1>Oh My Diff code/impact graph</h1><span id="version" class="meta"></span><span id="counts" class="meta"></span></header>
<div class="layout"><aside><div class="toolbar"><input id="search" aria-label="Search graph" placeholder="Search symbols, files, edges"><select id="kind" aria-label="Node kind"><option value="">all nodes</option><option>module</option><option>symbol</option><option>test</option><option>unknown</option></select></div><div id="nodes"></div></aside>
<main><div class="toolbar"><select id="confidence" aria-label="Relationship confidence"><option value="">all relationships</option><option>extracted</option><option>inferred</option><option>unknown</option></select><button id="select">Select current evidence</button><button id="copy">Copy selections</button><button id="clear">Clear</button></div><svg id="graph" viewBox="0 0 900 360" role="img" aria-label="Selected node neighborhood"></svg><div id="details" class="details">Choose a node. Solid edges are extracted, dashed edges inferred, and amber edges unknown.</div></main></div>
<script id="graph-data" type="application/json">__GRAPH_JSON__</script><script>
const g=JSON.parse(document.getElementById('graph-data').textContent),byId=new Map(g.nodes.map(n=>[n.id,n])),chosen=new Set();let current=g.nodes.find(n=>n.kind!=='unknown')||g.nodes[0];
const q=id=>document.getElementById(id),esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
q('version').textContent=`${g.repository.identity} · ${g.repository.revision} · ${g.generator}`;q('counts').textContent=`${g.sources.length} files · ${g.nodes.length} nodes · ${g.edges.length} edges`;
function href(a){return 'file://'+encodeURI(g.repository.root.replace(/\/$/,'')+'/'+a.path)+'#L'+a.start_line}function matches(n){const text=(n.name+' '+n.id+' '+(n.symbol_kind||'')).toLowerCase(),s=q('search').value.toLowerCase();return(!q('kind').value||n.kind===q('kind').value)&&(!s||text.includes(s))}
function list(){q('nodes').innerHTML=g.nodes.filter(matches).map(n=>`<div class="node ${current&&n.id===current.id?'active':''}" data-id="${esc(n.id)}"><b>${chosen.has(n.id)?'☑ ':'□ '}${esc(n.name)}</b><small>${n.kind}${n.anchor?' · '+esc(n.anchor.path)+':'+n.anchor.start_line:''}</small></div>`).join('');document.querySelectorAll('.node').forEach(e=>e.onclick=()=>{current=byId.get(e.dataset.id);render()})}
function visibleEdges(){return g.edges.filter(e=>(e.from===current.id||e.to===current.id)&&(!q('confidence').value||e.confidence===q('confidence').value))}
function renderGraph(edges){const ids=[current.id,...new Set(edges.flatMap(e=>[e.from,e.to]).filter(id=>id!==current.id))].slice(0,18),cx=450,cy=180,r=145,pos=new Map([[current.id,[cx,cy]]]);ids.slice(1).forEach((id,i)=>{const a=2*Math.PI*i/Math.max(1,ids.length-1);pos.set(id,[cx+Math.cos(a)*r,cy+Math.sin(a)*r])});let svg='';for(const e of edges){if(!pos.has(e.from)||!pos.has(e.to))continue;const a=pos.get(e.from),b=pos.get(e.to);svg+=`<line class="edge ${e.confidence}" x1="${a[0]}" y1="${a[1]}" x2="${b[0]}" y2="${b[1]}"><title>${esc(e.relationship+' · '+e.confidence+' · '+e.detail)}</title></line>`}for(const id of ids){const n=byId.get(id),p=pos.get(id),label=n.name.length>20?n.name.slice(0,18)+'…':n.name;svg+=`<g data-id="${esc(id)}"><circle class="bubble ${n.kind}" cx="${p[0]}" cy="${p[1]}" r="${id===current.id?38:28}"><title>${esc(n.id)}</title></circle><text class="label" x="${p[0]}" y="${p[1]+4}" text-anchor="middle">${esc(label)}</text></g>`}q('graph').innerHTML=svg;document.querySelectorAll('#graph g').forEach(e=>e.onclick=()=>{current=byId.get(e.dataset.id);render()})}
function render(){list();const edges=visibleEdges();renderGraph(edges);const a=current.anchor,coverage=a&&g.coverage.find(c=>c.path===a.path),source=a?`<a class="source" href="${esc(href(a))}">${esc(a.path)}:${a.start_line}</a>`:'<span class="warning">No resolved source target</span>';q('details').innerHTML=`<b>${esc(current.name)}</b> · ${current.kind}${current.symbol_kind?' · '+esc(current.symbol_kind):''}\n${source}\n\n${edges.map(e=>`${e.relationship} · ${e.confidence} · ${esc(byId.get(e.from).name)} → ${esc(byId.get(e.to).name)} · <a class="source" href="${esc(href(e.evidence))}">${esc(e.evidence.path)}:${e.evidence.start_line}</a>`).join('\n')||'No relationships under this filter.'}${coverage?`\n\nCoverage: ${coverage.extracted_relationships} extracted, ${coverage.inferred_relationships} inferred, ${coverage.unknown_relationships} unknown${coverage.unknown_examples.length?'\nUnknown examples: '+esc(coverage.unknown_examples.join(', ')):''}`:''}`}
function packet(){const ids=new Set(chosen),relationships=g.edges.filter(e=>ids.has(e.from)||ids.has(e.to)),related=new Set([...ids,...relationships.flatMap(e=>[e.from,e.to])]),paths=new Set([...related].map(id=>byId.get(id).anchor).filter(Boolean).map(a=>a.path));return{schema:1,graph_schema:g.schema,graph_generator:g.generator,repository_identity:g.repository.identity,revision:g.repository.revision,source_digest:g.repository.source_digest,nodes:[...related].map(id=>byId.get(id)),relationships,coverage:g.coverage.filter(c=>paths.has(c.path))}}
async function copyText(text){if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(text);return}const area=document.createElement('textarea');area.value=text;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const copied=document.execCommand('copy');area.remove();if(!copied)throw new Error('clipboard unavailable')}
q('search').oninput=list;q('kind').onchange=list;q('confidence').onchange=render;q('select').onclick=()=>{chosen.add(current.id);list()};q('clear').onclick=()=>{chosen.clear();list()};q('copy').onclick=async()=>{if(!chosen.size){chosen.add(current.id)}const text='Use this version-bound code-graph evidence. Verify inferred and unknown relationships against source before relying on them.\n```json\n'+JSON.stringify(packet(),null,2)+'\n```\n';if(new TextEncoder().encode(text).length>g.limits.max_selection_bytes){q('copy').textContent='Selection too large';setTimeout(()=>q('copy').textContent='Copy selections',1600);return}try{await copyText(text);q('copy').textContent='Copied'}catch(_){q('copy').textContent='Copy unavailable'}setTimeout(()=>q('copy').textContent='Copy selections',1200);list()};render();
</script></body></html>"#;
