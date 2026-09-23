use crate::LspLanguage;
use crate::LspLimits;
use crate::lsp_hash;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::env;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;

#[derive(Clone, Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct IntermediateCheck {
    pub language: LspLanguage,
    pub program: PathBuf,
    pub arguments: Vec<String>,
    pub working_directory: PathBuf,
    pub scope: Vec<String>,
    pub input_sha256: String,
}

#[derive(Clone, Debug, Serialize)]
#[serde(deny_unknown_fields)]
pub struct UnsupportedCheck {
    pub language: LspLanguage,
    pub reason: String,
    pub fallback: String,
}

pub fn select_intermediate_checks(
    repository: &Path,
    changed_paths: &[String],
    limits: &LspLimits,
) -> io::Result<(Vec<IntermediateCheck>, Vec<UnsupportedCheck>)> {
    limits.validate()?;
    if changed_paths.is_empty() || changed_paths.len() > limits.max_edit_files {
        return Err(io::Error::other(
            "changed path batch is empty or exceeds limit",
        ));
    }
    let mut languages = BTreeMap::<LspLanguage, Vec<String>>::new();
    for relative in changed_paths {
        let path = resolve_source(repository, relative)?;
        let language = LspLanguage::from_path(&path)
            .ok_or_else(|| io::Error::other(format!("unsupported source path {relative}")))?;
        languages
            .entry(language)
            .or_default()
            .push(relative.clone());
    }
    let mut checks = Vec::new();
    let mut unsupported = Vec::new();
    for (language, mut scope) in languages {
        scope.sort();
        scope.dedup();
        match select_one(repository, language, scope, limits)? {
            Ok(check) => checks.push(check),
            Err(reason) => unsupported.push(UnsupportedCheck {
                language,
                reason,
                fallback: "Use a repository-configured executable check through the ordinary command tool and bind its result to the current input SHA256; unavailable evidence is not success.".into(),
            }),
        }
    }
    Ok((checks, unsupported))
}

fn select_one(
    repository: &Path,
    language: LspLanguage,
    scope: Vec<String>,
    limits: &LspLimits,
) -> io::Result<Result<IntermediateCheck, String>> {
    let selected = match language {
        LspLanguage::Rust => resolve_executable("cargo").and_then(|program| {
            nearest_ancestor(repository, &scope, "Cargo.toml").map(|working_directory| {
                (
                    program,
                    vec!["check".into(), "--quiet".into()],
                    working_directory,
                )
            })
        }),
        LspLanguage::TypeScript | LspLanguage::JavaScript => {
            resolve_executable("pnpm").and_then(|program| {
                nearest_ancestor(repository, &scope, "tsconfig.json").map(|config| {
                    let relative = config
                        .join("tsconfig.json")
                        .strip_prefix(repository)
                        .expect("config is in repository")
                        .to_string_lossy()
                        .replace('\\', "/");
                    (
                        program,
                        vec![
                            "exec".into(),
                            "tsc".into(),
                            "--noEmit".into(),
                            "--pretty".into(),
                            "false".into(),
                            "-p".into(),
                            relative,
                        ],
                        repository.to_path_buf(),
                    )
                })
            })
        }
        LspLanguage::Python => ["pyright", "mypy", "ruff"]
            .into_iter()
            .find_map(|name| resolve_executable(name).map(|program| (name, program)))
            .map(|(name, program)| {
                let arguments = if name == "ruff" {
                    std::iter::once("check".to_string())
                        .chain(scope.iter().cloned())
                        .collect()
                } else {
                    scope.clone()
                };
                (program, arguments, repository.to_path_buf())
            }),
        LspLanguage::Java => {
            let gradle = repository.join("gradlew");
            let maven = repository.join("mvnw");
            if gradle.is_file() {
                Some((gradle, vec!["compileJava".into()], repository.to_path_buf()))
            } else if maven.is_file() {
                Some((
                    maven,
                    vec!["-q".into(), "-DskipTests".into(), "compile".into()],
                    repository.to_path_buf(),
                ))
            } else {
                resolve_executable("gradle")
                    .map(|program| {
                        (
                            program,
                            vec!["compileJava".into()],
                            repository.to_path_buf(),
                        )
                    })
                    .or_else(|| {
                        resolve_executable("mvn").map(|program| {
                            (
                                program,
                                vec!["-q".into(), "-DskipTests".into(), "compile".into()],
                                repository.to_path_buf(),
                            )
                        })
                    })
            }
        }
    };
    let Some((program, arguments, working_directory)) = selected else {
        return Ok(Err(match language {
            LspLanguage::Rust => "cargo or a repository Cargo.toml is unavailable".into(),
            LspLanguage::TypeScript | LspLanguage::JavaScript => {
                "pnpm or a repository tsconfig.json is unavailable".into()
            }
            LspLanguage::Python => "pyright, mypy, and ruff are not installed".into(),
            LspLanguage::Java => "Gradle or Maven is not installed or configured".into(),
        }));
    };
    let input_sha256 = check_input_hash(repository, language, limits)?;
    Ok(Ok(IntermediateCheck {
        language,
        program,
        arguments,
        working_directory,
        scope,
        input_sha256,
    }))
}

fn nearest_ancestor(repository: &Path, scope: &[String], marker: &str) -> Option<PathBuf> {
    let first = repository.join(scope.first()?);
    let mut directory = first.parent()?;
    loop {
        if directory.join(marker).is_file() {
            return Some(directory.to_path_buf());
        }
        if directory == repository {
            break;
        }
        directory = directory.parent()?;
        if !directory.starts_with(repository) {
            break;
        }
    }
    None
}

fn check_input_hash(
    repository: &Path,
    language: LspLanguage,
    limits: &LspLimits,
) -> io::Result<String> {
    let config_names = match language {
        LspLanguage::Rust => ["Cargo.toml", "Cargo.lock"].as_slice(),
        LspLanguage::TypeScript | LspLanguage::JavaScript => {
            ["package.json", "pnpm-lock.yaml", "tsconfig.json"].as_slice()
        }
        LspLanguage::Python => ["pyproject.toml", "setup.cfg", "mypy.ini"].as_slice(),
        LspLanguage::Java => [
            "build.gradle",
            "build.gradle.kts",
            "settings.gradle",
            "settings.gradle.kts",
            "pom.xml",
        ]
        .as_slice(),
    }
    .iter()
    .copied()
    .collect::<BTreeSet<_>>();
    let mut stack = vec![repository.to_path_buf()];
    let mut entries = BTreeMap::<String, String>::new();
    let mut bytes = 0_usize;
    while let Some(directory) = stack.pop() {
        for entry in fs::read_dir(directory)? {
            let entry = entry?;
            let path = entry.path();
            let name = entry.file_name();
            if entry.file_type()?.is_symlink() {
                continue;
            }
            if path.is_dir() {
                if !matches!(
                    name.to_str(),
                    Some(
                        ".git"
                            | ".omd"
                            | "target"
                            | "node_modules"
                            | ".venv"
                            | "venv"
                            | "build"
                            | "dist"
                    )
                ) {
                    stack.push(path);
                }
                continue;
            }
            let include = LspLanguage::from_path(&path) == Some(language)
                || name
                    .to_str()
                    .is_some_and(|name| config_names.contains(name));
            if !include {
                continue;
            }
            let content = fs::read(&path)?;
            bytes = bytes.saturating_add(content.len());
            if entries.len() >= limits.max_workspace_files || bytes > limits.max_workspace_bytes {
                return Err(io::Error::other("intermediate check inputs exceed bounds"));
            }
            let relative = path
                .strip_prefix(repository)
                .expect("walked repository path")
                .to_string_lossy()
                .replace('\\', "/");
            entries.insert(relative, lsp_hash(&content));
        }
    }
    Ok(lsp_hash(&serde_json::to_vec(&entries)?))
}

fn resolve_source(repository: &Path, relative: &str) -> io::Result<PathBuf> {
    let relative = Path::new(relative);
    if relative.is_absolute()
        || relative
            .components()
            .any(|component| !matches!(component, std::path::Component::Normal(_)))
    {
        return Err(io::Error::other(
            "check path must be normalized and repository-relative",
        ));
    }
    let path = repository.join(relative).canonicalize()?;
    if !path.starts_with(repository) || !path.is_file() {
        return Err(io::Error::other("check path escapes repository"));
    }
    Ok(path)
}

fn resolve_executable(name: &str) -> Option<PathBuf> {
    env::split_paths(&env::var_os("PATH")?).find_map(|directory| {
        let path = directory.join(name);
        path.is_file().then_some(path)
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn check_fingerprint_changes_only_with_relevant_inputs() {
        let temporary = tempfile::tempdir().unwrap();
        let repository = temporary.path().canonicalize().unwrap();
        fs::write(repository.join("main.rs"), "fn main() {}\n").unwrap();
        fs::write(repository.join("notes.txt"), "one\n").unwrap();
        let limits = LspLimits::default();
        let (checks, unsupported) =
            select_intermediate_checks(&repository, &["main.rs".into()], &limits).unwrap();
        assert!(checks.is_empty());
        assert_eq!(unsupported.len(), 1);
        assert!(unsupported[0].reason.contains("Cargo.toml"));
        let first = check_input_hash(&repository, LspLanguage::Rust, &limits).unwrap();
        fs::write(repository.join("notes.txt"), "two\n").unwrap();
        fs::write(repository.join("package.json"), "{}\n").unwrap();
        let second = check_input_hash(&repository, LspLanguage::Rust, &limits).unwrap();
        assert_eq!(first, second);
        fs::write(repository.join("Cargo.toml"), "[workspace]\n").unwrap();
        let configured = check_input_hash(&repository, LspLanguage::Rust, &limits).unwrap();
        assert_ne!(second, configured);
        fs::write(repository.join("main.rs"), "fn main() { panic!() }\n").unwrap();
        let third = check_input_hash(&repository, LspLanguage::Rust, &limits).unwrap();
        assert_ne!(configured, third);
    }
}
