use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex, PoisonError};

pub(super) struct Tree {
    pub files: BTreeMap<PathBuf, Vec<u8>>,
    pub links: BTreeMap<PathBuf, PathBuf>,
    stamps: BTreeMap<PathBuf, codex_omd::FileStamp>,
    root: PathBuf,
    stable: bool,
}

pub(super) fn capture(root: &Path) -> Result<Tree, String> {
    let canonical = root.canonicalize().map_err(|error| error.to_string())?;
    if canonical != root || !root.is_dir() {
        return Err("service_code_root_invalid".into());
    }
    let mut tree = Tree {
        files: BTreeMap::new(),
        links: BTreeMap::new(),
        stamps: BTreeMap::new(),
        root: canonical,
        stable: true,
    };
    let mut pending = vec![root.to_path_buf()];
    let mut total = 0;
    let mut entries = 0;
    while let Some(directory) = pending.pop() {
        for entry in fs::read_dir(directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            let kind = entry.file_type().map_err(|error| error.to_string())?;
            entries += 1;
            if entries > 8192 {
                return Err("service_source_limit".into());
            }
            if kind.is_symlink() {
                let target = fs::read_link(&path).map_err(|error| error.to_string())?;
                if target.is_absolute()
                    || !path
                        .canonicalize()
                        .map_err(|error| error.to_string())?
                        .starts_with(root)
                {
                    return Err("service_dependency_escape".into());
                }
                tree.links.insert(path, target);
            } else if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file() {
                let mut bytes = Vec::new();
                let file = fs::OpenOptions::new()
                    .read(true)
                    .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
                    .open(&path)
                    .map_err(|error| error.to_string())?;
                let metadata = file.metadata().map_err(|error| error.to_string())?;
                if !metadata.is_file() {
                    return Err("service_dependency_type_invalid".into());
                }
                (&file)
                    .take(64 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)
                    .map_err(|error| error.to_string())?;
                total += bytes.len();
                if bytes.len() > 64 * 1024 * 1024 || total > 128 * 1024 * 1024 {
                    return Err("service_source_limit".into());
                }
                let stamp = codex_omd::file_stamp(&metadata);
                tree.stable &= file
                    .metadata()
                    .is_ok_and(|after| codex_omd::file_stamp(&after) == stamp);
                tree.stamps.insert(path.clone(), stamp);
                tree.files.insert(path, bytes);
            } else {
                return Err("service_dependency_type_invalid".into());
            }
        }
    }
    Ok(tree)
}

type TreeStamp = (
    BTreeMap<PathBuf, codex_omd::FileStamp>,
    BTreeMap<PathBuf, PathBuf>,
);

/// The tree's digest, rehashed only when its file list, link targets or any file stamp changes.
pub(super) fn digest(tree: &Tree) -> String {
    static DIGESTS: LazyLock<Mutex<BTreeMap<PathBuf, (TreeStamp, String)>>> =
        LazyLock::new(Default::default);
    if !tree.stable {
        return hash_tree(tree);
    }
    let fingerprint = (tree.stamps.clone(), tree.links.clone());
    if let Some((known, digest)) = DIGESTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .get(&tree.root)
        && *known == fingerprint
    {
        return digest.clone();
    }
    let digest = hash_tree(tree);
    DIGESTS
        .lock()
        .unwrap_or_else(PoisonError::into_inner)
        .insert(tree.root.clone(), (fingerprint, digest.clone()));
    digest
}

fn hash_tree(tree: &Tree) -> String {
    let mut rows = BTreeMap::new();
    for (path, bytes) in &tree.files {
        rows.insert(
            path.strip_prefix(&tree.root)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            ("file", super::execution::hash(bytes)),
        );
    }
    for (path, target) in &tree.links {
        rows.insert(
            path.strip_prefix(&tree.root)
                .unwrap()
                .to_string_lossy()
                .into_owned(),
            ("link", target.to_string_lossy().into_owned()),
        );
    }
    let rows = rows
        .into_iter()
        .map(|(path, (kind, value))| (path, kind, value))
        .collect::<Vec<_>>();
    super::execution::hash(&serde_json::to_vec(&rows).unwrap())
}

pub(super) fn path(root: &Path, source: &Path) -> Result<PathBuf, String> {
    if source
        .components()
        .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("service_source_path_invalid".into());
    }
    Ok(root.join(
        source
            .strip_prefix("/")
            .map_err(|_| "service_source_path_invalid")?,
    ))
}

pub(super) fn materialize(
    root: &Path,
    files: &BTreeMap<PathBuf, Vec<u8>>,
    links: &BTreeMap<PathBuf, PathBuf>,
) -> Result<tempfile::TempDir, String> {
    use std::io::Write;
    let snapshot = tempfile::Builder::new()
        .prefix("service-code-")
        .tempdir_in(root)
        .map_err(|error| error.to_string())?;
    for (source, bytes) in files {
        let target = path(snapshot.path(), source)?;
        fs::create_dir_all(target.parent().unwrap()).map_err(|error| error.to_string())?;
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o500)
            .open(target)
            .map_err(|error| error.to_string())?;
        file.write_all(bytes).map_err(|error| error.to_string())?;
    }
    for (source, relative) in links {
        let target = path(snapshot.path(), source)?;
        fs::create_dir_all(target.parent().unwrap()).map_err(|error| error.to_string())?;
        std::os::unix::fs::symlink(relative, target).map_err(|error| error.to_string())?;
    }
    fs::set_permissions(snapshot.path(), fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    Ok(snapshot)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn captured_dependencies_are_verified_and_materialized_without_reopening() {
        let root = tempfile::tempdir().unwrap();
        let code = root.path().join("code");
        fs::create_dir(&code).unwrap();
        let code = code.canonicalize().unwrap();
        fs::write(code.join("helper.mjs"), "admitted helper").unwrap();
        fs::write(code.join("dependency.mjs"), "admitted dependency").unwrap();
        fs::write(code.join("executable"), "#!/bin/sh\nexit 0\n").unwrap();
        std::os::unix::fs::symlink("dependency.mjs", code.join("link.mjs")).unwrap();
        let captured = capture(&code).unwrap();
        let expected = digest(&captured);
        fs::write(code.join("helper.mjs"), "changed helper").unwrap();
        fs::write(code.join("dependency.mjs"), "changed dependency").unwrap();
        assert_ne!(digest(&capture(&code).unwrap()), expected);
        let snapshot = materialize(root.path(), &captured.files, &captured.links).unwrap();
        assert!(
            std::process::Command::new(path(snapshot.path(), &code.join("executable")).unwrap())
                .status()
                .unwrap()
                .success()
        );
        assert_eq!(
            fs::read(path(snapshot.path(), &code.join("helper.mjs")).unwrap()).unwrap(),
            b"admitted helper"
        );
        assert_eq!(
            fs::read(path(snapshot.path(), &code.join("link.mjs")).unwrap()).unwrap(),
            b"admitted dependency"
        );
        std::os::unix::fs::symlink("../escape", code.join("escape")).unwrap();
        assert!(capture(&code).is_err());
    }
}
