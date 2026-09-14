use super::*;

#[test]
fn platform_defaults_require_both_authorities_and_never_erase_denies() {
    let root = tempfile::tempdir().unwrap();
    let cwd = root.path().canonicalize().unwrap();
    let entry = |access| {
        Entry::new(
            FileSystemPath::Special {
                value: FileSystemSpecialPath::Minimal,
            },
            access,
        )
    };
    let profile = |entries| {
        PermissionProfile::from_runtime_permissions(
            &FileSystemSandboxPolicy::restricted(entries),
            NetworkSandboxPolicy::Restricted,
        )
    };
    let minimal = profile(vec![entry(Access::Read)]);
    let denied = profile(vec![entry(Access::Read), entry(Access::Deny)]);
    assert!(intersect(&denied, &minimal, &cwd).is_err());
    let none = profile(vec![]);
    assert!(
        !intersect(&none, &minimal, &cwd)
            .unwrap()
            .file_system_sandbox_policy()
            .include_platform_defaults()
    );
    let secret = AbsolutePathBuf::from_absolute_path_checked(cwd.join("secret")).unwrap();
    let parent = profile(vec![
        entry(Access::Read),
        Entry::new(
            FileSystemPath::Path {
                path: PathUri::from_abs_path(&secret),
            },
            Access::Deny,
        ),
    ]);
    let result = intersect(&parent, &minimal, &cwd)
        .unwrap()
        .file_system_sandbox_policy();
    assert!(result.include_platform_defaults());
    assert_eq!(
        result.resolve_access_for_local_path_with_cwd(secret.as_path(), &cwd),
        Access::Deny
    );
}
