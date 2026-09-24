use super::*;
use ignore::gitignore::Gitignore;
use ignore::gitignore::GitignoreBuilder;

const IGNORE_FILES: &[&str] = &[".gitignore", ".ignore", ".fdignore"];
const ENTRY_LIMIT: usize = 1024;
const DEPTH_LIMIT: usize = 8;
const RESOURCE_BYTES: u64 = 16_384;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PiPrompt {
    pub name: String,
    pub description: String,
    pub argument_hint: Option<String>,
    pub body: String,
    pub path: PathBuf,
    pub scope: &'static str,
    pub sha256: String,
}

struct Traversal<'a> {
    root: &'a Path,
    patterns: Vec<String>,
    visited: usize,
    resources: Vec<Value>,
    diagnostics: Vec<Value>,
}

fn normalize(content: &str) -> String {
    content.replace("\r\n", "\n").replace('\r', "\n")
}

fn frontmatter(content: &str) -> Result<(serde_json::Map<String, Value>, String)> {
    let normalized = normalize(content);
    if !normalized.starts_with("---") {
        return Ok((serde_json::Map::new(), normalized));
    }
    let Some(end) = normalized
        .get(3..)
        .and_then(|rest| rest.find("\n---"))
        .map(|index| index + 3)
    else {
        return Ok((serde_json::Map::new(), normalized));
    };
    let yaml = normalized.get(4..end).unwrap_or_default();
    let body = normalized
        .get(end + 4..)
        .unwrap_or_default()
        .trim()
        .to_owned();
    if yaml.is_empty() {
        return Ok((serde_json::Map::new(), body));
    }
    let parsed: Value =
        serde_yaml::from_str(yaml).map_err(|e| failure(format!("pi_frontmatter: {e}")))?;
    Ok((parsed.as_object().cloned().unwrap_or_default(), body))
}

fn string_field(fields: &serde_json::Map<String, Value>, key: &str) -> Option<String> {
    fields
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn prompt_description(fields: &serde_json::Map<String, Value>, body: &str) -> String {
    string_field(fields, "description").unwrap_or_else(|| {
        body.split('\n')
            .find(|line| !line.trim().is_empty())
            .map(|line| {
                let mut description: String = line.chars().take(60).collect();
                if line.chars().count() > 60 {
                    description.push_str("...");
                }
                description
            })
            .unwrap_or_default()
    })
}

fn prefix_pattern(line: &str, prefix: &str) -> Option<String> {
    let trimmed = line.trim();
    if trimmed.is_empty() || (trimmed.starts_with('#') && !trimmed.starts_with("\\#")) {
        return None;
    }
    let mut pattern = line;
    let mut negated = false;
    if let Some(rest) = pattern.strip_prefix('!') {
        negated = true;
        pattern = rest;
    } else if pattern.starts_with("\\!") {
        pattern = &pattern[1..];
    }
    let pattern = pattern.strip_prefix('/').unwrap_or(pattern);
    let prefixed = format!("{prefix}{pattern}");
    Some(if negated {
        format!("!{prefixed}")
    } else {
        prefixed
    })
}

fn relative(root: &Path, path: &Path) -> String {
    path.strip_prefix(root)
        .unwrap_or(path)
        .components()
        .map(|c| c.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

fn symlink(path: &Path) -> Result<bool> {
    Ok(std::fs::symlink_metadata(path)?.file_type().is_symlink())
}

fn sorted_entries(directory: &Path) -> Result<Vec<PathBuf>> {
    let mut entries = std::fs::read_dir(directory)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<Result<Vec<_>>>()?;
    entries.sort();
    Ok(entries)
}

impl Traversal<'_> {
    fn matcher(&self) -> Result<Gitignore> {
        let mut builder = GitignoreBuilder::new(self.root);
        for pattern in &self.patterns {
            builder
                .add_line(None, pattern)
                .map_err(|e| failure(format!("pi_ignore_pattern: {e}")))?;
        }
        builder
            .build()
            .map_err(|e| failure(format!("pi_ignore_pattern: {e}")))
    }

    fn add_rules(&mut self, directory: &Path) -> Result<()> {
        let relative = relative(self.root, directory);
        let prefix = if relative.is_empty() {
            String::new()
        } else {
            format!("{relative}/")
        };
        for name in IGNORE_FILES {
            let path = directory.join(name);
            if !path.exists() {
                continue;
            }
            if symlink(&path)? {
                self.diagnostics
                    .push(json!({"path":path,"error":"pi_symlink_unsupported"}));
                continue;
            }
            let content = String::from_utf8(store::read(&path, 65_536)?).map_err(failure)?;
            self.patterns.extend(
                content
                    .split('\n')
                    .map(|line| line.strip_suffix('\r').unwrap_or(line))
                    .filter_map(|line| prefix_pattern(line, &prefix)),
            );
        }
        Ok(())
    }

    fn skill(&mut self, path: &Path, scope: &str) {
        let result = store::read(path, RESOURCE_BYTES).and_then(|bytes| {
            let content = String::from_utf8(bytes.clone()).map_err(failure)?;
            let (fields, _) = frontmatter(&content)?;
            Ok((bytes, content, fields))
        });
        let (bytes, content, fields) = match result {
            Ok(value) => value,
            Err(error) => {
                self.diagnostics
                    .push(json!({"path":path,"error":error.to_string()}));
                return;
            }
        };
        let Some(description) = string_field(&fields, "description")
            .filter(|description| !description.trim().is_empty())
        else {
            self.diagnostics
                .push(json!({"path":path,"error":"pi_skill_description_required"}));
            return;
        };
        let parent = path
            .parent()
            .and_then(Path::file_name)
            .map(|name| name.to_string_lossy().into_owned())
            .unwrap_or_default();
        let name = string_field(&fields, "name").unwrap_or(parent);
        self.resources.push(
            json!({"kind":"skills","name":name,"scope":scope,"path":path,
            "description":description,"sha256":digest(&bytes),"content":content}),
        );
    }

    fn skills(
        &mut self,
        directory: &Path,
        scope: &str,
        root_files: bool,
        depth: usize,
    ) -> Result<()> {
        if depth > DEPTH_LIMIT {
            self.diagnostics
                .push(json!({"path":directory,"error":"pi_depth_limit"}));
            return Ok(());
        }
        self.add_rules(directory)?;
        let matcher = self.matcher()?;
        let ignored = |path: &Path, directory: bool| {
            matcher
                .matched_path_or_any_parents(path, directory)
                .is_ignore()
        };
        let entries = sorted_entries(directory)?;
        self.visited += entries.len();
        if self.visited > ENTRY_LIMIT {
            return Err(failure("pi_discovery_limit"));
        }
        let skill = directory.join("SKILL.md");
        if entries.contains(&skill) {
            if symlink(&skill)? {
                self.diagnostics
                    .push(json!({"path":skill,"error":"pi_symlink_unsupported"}));
            } else if skill.is_file() && !ignored(&skill, false) {
                self.skill(&skill, scope);
                return Ok(());
            }
        }
        for entry in entries {
            let Some(name) = entry.file_name().map(|n| n.to_string_lossy().into_owned()) else {
                continue;
            };
            if name.starts_with('.') || name == "node_modules" {
                continue;
            }
            if symlink(&entry)? {
                self.diagnostics
                    .push(json!({"path":entry,"error":"pi_symlink_unsupported"}));
                continue;
            }
            let is_directory = entry.is_dir();
            if ignored(&entry, is_directory) {
                continue;
            }
            if is_directory {
                self.skills(&entry, scope, false, depth + 1)?;
            } else if root_files && entry.is_file() && name.ends_with(".md") {
                self.skill(&entry, scope);
            }
        }
        Ok(())
    }
}

fn roots(user_agent: &Path, project: &Path) -> [(&'static str, PathBuf); 2] {
    [
        ("user", user_agent.to_path_buf()),
        ("project", project.join(".pi")),
    ]
}

fn canonical_directory(directory: &Path, diagnostics: &mut Vec<Value>) -> Result<bool> {
    if !directory.exists() {
        return Ok(false);
    }
    if directory.canonicalize()? != directory {
        diagnostics.push(json!({"path":directory,"error":"pi_symlink_unsupported"}));
        return Ok(false);
    }
    Ok(true)
}

pub fn parse_command_args(arguments: &str) -> Vec<String> {
    let mut parsed = Vec::new();
    let mut current = String::new();
    let mut quote = None;
    for character in arguments.chars() {
        match quote {
            Some(open) if character == open => quote = None,
            Some(_) => current.push(character),
            None if character == '"' || character == '\'' => quote = Some(character),
            None if character == ' ' || character == '\t' => {
                if !current.is_empty() {
                    parsed.push(std::mem::take(&mut current));
                }
            }
            None => current.push(character),
        }
    }
    if !current.is_empty() {
        parsed.push(current);
    }
    parsed
}

fn digits(text: &str) -> usize {
    text.bytes().take_while(u8::is_ascii_digit).count()
}

fn index(text: &str) -> Option<usize> {
    text.parse::<usize>().ok()
}

pub fn substitute_args(content: &str, arguments: &[String]) -> String {
    let mut positional = String::with_capacity(content.len());
    let mut rest = content;
    while let Some(position) = rest.find('$') {
        positional.push_str(&rest[..position]);
        let after = &rest[position + 1..];
        let length = digits(after);
        if length == 0 {
            positional.push('$');
            rest = after;
            continue;
        }
        let value = index(&after[..length])
            .and_then(|n| n.checked_sub(1))
            .and_then(|n| arguments.get(n))
            .map(String::as_str)
            .unwrap_or_default();
        positional.push_str(value);
        rest = &after[length..];
    }
    positional.push_str(rest);
    let mut sliced = String::with_capacity(positional.len());
    let mut rest = positional.as_str();
    while let Some(position) = rest.find("${@:") {
        sliced.push_str(&rest[..position]);
        let after = &rest[position + 4..];
        let start_length = digits(after);
        let mut consumed = start_length;
        let mut count = None;
        if start_length > 0 && after[consumed..].starts_with(':') {
            let length = digits(&after[consumed + 1..]);
            if length > 0 {
                count = Some(&after[consumed + 1..consumed + 1 + length]);
                consumed += 1 + length;
            }
        }
        if start_length == 0 || !after[consumed..].starts_with('}') {
            sliced.push_str("${@:");
            rest = after;
            continue;
        }
        let start = index(&after[..start_length])
            .map(|n| n.saturating_sub(1))
            .unwrap_or(usize::MAX);
        let selected: Vec<&str> = arguments
            .iter()
            .skip(start)
            .take(count.and_then(index).unwrap_or(usize::MAX))
            .map(String::as_str)
            .collect();
        sliced.push_str(&selected.join(" "));
        rest = &after[consumed + 1..];
    }
    sliced.push_str(rest);
    let all = arguments.join(" ");
    js_replace_all(&js_replace_all(&sliced, "$ARGUMENTS", &all), "$@", &all)
}

fn js_replace_all(haystack: &str, needle: &str, replacement: &str) -> String {
    let mut output = String::with_capacity(haystack.len());
    let mut cursor = 0;
    while let Some(offset) = haystack[cursor..].find(needle) {
        let start = cursor + offset;
        let end = start + needle.len();
        output.push_str(&haystack[cursor..start]);
        let mut characters = replacement.chars().peekable();
        while let Some(character) = characters.next() {
            if character != '$' {
                output.push(character);
                continue;
            }
            match characters.peek() {
                Some('$') => output.push('$'),
                Some('&') => output.push_str(needle),
                Some('`') => output.push_str(&haystack[..start]),
                Some('\'') => output.push_str(&haystack[end..]),
                _ => {
                    output.push('$');
                    continue;
                }
            }
            characters.next();
        }
        cursor = end;
    }
    output.push_str(&haystack[cursor..]);
    output
}

impl ModStore {
    pub fn discover_pi(user_agent: &Path, project: &Path) -> Result<Value> {
        let mut resources = BTreeMap::new();
        let mut diagnostics = Vec::new();
        for (scope, root) in roots(user_agent, project) {
            let directory = root.join("skills");
            if canonical_directory(&directory, &mut diagnostics)? {
                let mut traversal = Traversal {
                    root: &directory,
                    patterns: Vec::new(),
                    visited: 0,
                    resources: Vec::new(),
                    diagnostics: Vec::new(),
                };
                traversal.skills(&directory, scope, true, 0)?;
                diagnostics.extend(traversal.diagnostics);
                let mut seen = BTreeSet::new();
                for resource in traversal.resources {
                    let name = resource["name"].as_str().unwrap_or_default().to_owned();
                    if !seen.insert(name.clone()) {
                        diagnostics.push(
                            json!({"path":resource["path"],"error":"pi_duplicate_skill_name"}),
                        );
                        continue;
                    }
                    resources.insert(format!("skills/{name}"), resource);
                }
            }
        }
        for prompt in Self::pi_prompts_with(user_agent, project, &mut diagnostics)? {
            resources.insert(
                format!("prompts/{}", prompt.name),
                json!({"kind":"prompts","name":prompt.name,"scope":prompt.scope,"path":prompt.path,
                    "description":prompt.description,"argument_hint":prompt.argument_hint,
                    "sha256":prompt.sha256,"content":prompt.body}),
            );
        }
        let value = json!({"adapter":"pi-0.74-resources-v2","resources":resources.into_values().collect::<Vec<_>>(),"diagnostics":diagnostics});
        if serde_json::to_vec(&value)?.len() > 131_072 {
            return Err(failure("pi_resource_aggregate_limit"));
        }
        Ok(value)
    }

    pub fn pi_prompts(user_agent: &Path, project: &Path) -> Result<(Vec<PiPrompt>, Vec<Value>)> {
        let mut diagnostics = Vec::new();
        let prompts = Self::pi_prompts_with(user_agent, project, &mut diagnostics)?;
        Ok((prompts, diagnostics))
    }

    fn pi_prompts_with(
        user_agent: &Path,
        project: &Path,
        diagnostics: &mut Vec<Value>,
    ) -> Result<Vec<PiPrompt>> {
        let mut prompts: BTreeMap<String, PiPrompt> = BTreeMap::new();
        for (scope, root) in roots(user_agent, project) {
            let directory = root.join("prompts");
            if !canonical_directory(&directory, diagnostics)? {
                continue;
            }
            let entries = sorted_entries(&directory)?;
            if entries.len() > 128 {
                return Err(failure("pi_discovery_limit"));
            }
            for entry in entries {
                if symlink(&entry)? {
                    diagnostics.push(json!({"path":entry,"error":"pi_symlink_unsupported"}));
                    continue;
                }
                if !entry.is_file() || entry.extension().is_none_or(|e| e != "md") {
                    continue;
                }
                let Some(name) = entry
                    .file_stem()
                    .and_then(|n| n.to_str())
                    .map(str::to_owned)
                else {
                    continue;
                };
                let parsed = store::read(&entry, RESOURCE_BYTES).and_then(|bytes| {
                    let content = String::from_utf8(bytes.clone()).map_err(failure)?;
                    let (fields, body) = frontmatter(&content)?;
                    Ok((bytes, fields, body))
                });
                match parsed {
                    Ok((bytes, fields, body)) => {
                        prompts.insert(
                            name.clone(),
                            PiPrompt {
                                description: prompt_description(&fields, &body),
                                argument_hint: string_field(&fields, "argument-hint"),
                                name,
                                body,
                                path: entry,
                                scope,
                                sha256: digest(&bytes),
                            },
                        );
                    }
                    Err(error) => diagnostics.push(json!({"path":entry,"error":error.to_string()})),
                }
            }
        }
        Ok(prompts.into_values().collect())
    }

    pub fn expand_pi_prompt(
        user_agent: &Path,
        project: &Path,
        name: &str,
        arguments: &str,
    ) -> Result<Value> {
        let (prompts, _) = Self::pi_prompts(user_agent, project)?;
        let prompt = prompts
            .into_iter()
            .find(|prompt| prompt.name == name)
            .ok_or_else(|| failure("pi_prompt_not_found"))?;
        let text = substitute_args(&prompt.body, &parse_command_args(arguments));
        if text.len() > 61_440 {
            return Err(failure("pi_prompt_expansion_limit"));
        }
        Ok(json!({"name":prompt.name,"path":prompt.path,"sha256":prompt.sha256,"text":text}))
    }
}
