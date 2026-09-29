# OMD intermediate checks

`omd_checks` is an inactive API 0.2 preview package. Its `select` tool takes 1–128 changed, repository-relative source paths and returns check commands for Rust, TypeScript, JavaScript, Python and Java. It does not execute commands, enable task-scoped tools or claim a successful check. The host still owns execution approval and accounting.

Each selected check includes the workspace candidate SHA-256 and a SHA-256 over sorted paths and file hashes for that language's source and configuration inputs. The tool takes a host snapshot before selection and requires the same candidate after selection. A missing file, changed candidate, incomplete listing or missing hash fails closed. An unavailable compiler or project marker yields an explicit unsupported result with a fallback instead of an implied pass.

The current preview caps repository listing at 2,048 entries and relevant check inputs at 1,024 files or 8 MiB per language. It requires exact source paths to be visible in the host's ordinary non-ignored workspace listing. Large or ignored repositories need further parity work. Selection is local and offline; cold/reuse cost, live execution, and native `checks.rs` deletion are still open.

`omd_task_tools` also executes task-scoped tools, exposes them from checkpoint text, and accepts command overrides. This selector does not replace those behaviors; that package needs a separate API 0.2 migration before retirement.
