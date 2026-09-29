use ignore::gitignore::{Gitignore, GitignoreBuilder};
use std::path::Path;

pub struct WatchFilter(Gitignore);

impl WatchFilter {
    pub fn new(root: &Path) -> Self {
        let mut builder = GitignoreBuilder::new(root);
        for file in [root.join(".gitignore"), root.join(".git/info/exclude")] {
            if file.is_file() {
                let _ = builder.add(file);
            }
        }
        Self(builder.build().unwrap_or_else(|_| Gitignore::empty()))
    }

    pub fn ignored(&self, root: &Path, relative: &str) -> bool {
        let path = root.join(relative);
        self.0
            .matched_path_or_any_parents(&path, path.is_dir())
            .is_ignore()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gitignore_and_exclude_rules_filter_nested_paths() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().canonicalize().unwrap();
        std::fs::create_dir_all(root.join(".git/info")).unwrap();
        std::fs::create_dir_all(root.join("target/debug")).unwrap();
        std::fs::write(root.join(".gitignore"), "target/\n*.log\n").unwrap();
        std::fs::write(root.join(".git/info/exclude"), "scratch.txt\n").unwrap();
        let filter = WatchFilter::new(&root);
        assert!(filter.ignored(&root, "target/debug/out"));
        assert!(filter.ignored(&root, "src/run.log"));
        assert!(filter.ignored(&root, "scratch.txt"));
        assert!(!filter.ignored(&root, "src/main.rs"));
    }
}
