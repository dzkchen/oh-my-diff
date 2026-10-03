# omd_task_tools

Opt-in; needs `omd_workflow`. It exposes `check_python`, `check_typescript` and
`check_rust` only while the workflow task's remaining work names that kind of
check, and hides them otherwise. Each runs the configured command (defaults:
`python3 -m pytest -q`, `pnpm check`, `cargo test --locked`) and returns the result as a refusal value when the
check isn't selected.

Settings: `python_command`, `typescript_command`, `rust_command` (argument
arrays; empty uses the default). Capabilities: `tools`, `context`, `exec`,
`lifecycle`, `services`, `agents`, `store`.
