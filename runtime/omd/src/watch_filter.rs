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

