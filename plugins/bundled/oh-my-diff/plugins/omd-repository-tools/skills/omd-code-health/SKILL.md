---
name: omd-code-health
description: Run and interpret Oh My Diff's focused baseline-bound repository health guard. Use for introduced dependency boundaries, exact domain duplication, weakened tests, or verification-minimum checks; do not use as a general code-quality score or automatic repair tool.
---

# OMD code health

Use the `omd_repository` plugin tools. They are local, prompt-approved, repository-contained, and source-read-only except for the named baseline and report artifacts.

## Establish a baseline

Create or replace a baseline only when the maintainer has explicitly approved the exact constraints artifact. Confirm that it identifies the intended repository, version, approver, rationale, dependency rules, duplication scopes, verification minimums, repair scope, and finding limit. Call `health_baseline` with repository-relative constraint and baseline paths plus the exact revision label.

Do not treat an old baseline, a constraint filename, or this skill as approval. A changed constraint hash requires a newly approved baseline.

## Check a candidate

Call `health_check` with the same constraints and baseline plus a repository-relative report path and current revision. Its status `introduced_findings` is a completed check whose native process used exit code 2, not a tool failure.

Report these categories separately:

- introduced findings: new non-uncertain violations;
- debt: findings already present in the approved baseline;
- uncertain: unresolved lexical possibilities that must not be promoted to violations.

Use `health_report` to page through each non-empty category, passing the exact `report.sha256` receipt returned by `health_check`, and cite its source evidence. Preserve the reported artifact and constraint hashes, baseline/current source digests, revisions, certainty, and repair-scope field.

## Repair boundary

The guard never edits source. `authorized_scope` means the paths are inside the maintainer-declared repair boundary; it is not user authorization to change them. Repair only when the current task separately authorizes edits, use ordinary host-controlled edit tools, and rerun the check afterward. Never modify debt or uncertain findings merely to make the report green.

If the tool refuses stale, changed, malformed, mismatched, symlinked, or out-of-repository input, preserve that refusal. Do not regenerate a baseline, weaken constraints, relabel uncertainty, or broaden repair scope to bypass it.
