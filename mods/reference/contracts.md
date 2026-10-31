# Contracts and receipts

A contract is a versioned document that gates task completion and workspace integration on receipts. Mods register
documents; users select one.

Use it when a mod registers a workflow contract, submits receipts, checks the completion or integration gate, or
narrows operations for the rest of a session. The agents that produce receipts are in [Agents](agents.md).

Entries are frozen in Mod API `1.0.0` unless marked experimental (see the
[registry table](stability-and-migration.md#experimental-entries-in-the-registry)). Runs on Apple Silicon macOS.

## Registering a contract

`api.contract(document)` registers a versioned schema-2 contract document:

```text
{schema: 2, id, version, description, assurance, gates: {complete?, integrate?}, restrict?}
```

Each gate, `complete` and `integrate`, lists requirements. A requirement names a receipt kind, a producer (`any`,
`lead`, `host`, `integration` or `separate_agent`), bindings (`candidate`, `acceptance`) and whether blocking findings
are allowed.

- `assurance` is a label of 1 to 64 characters of `a-z`, `0-9`, `_`, `-` and `.`. Confirmations show it when a
  selection lowers assurance.
- `restrict` lists up to 16 host operations that the contract refuses for the session
  (`contract_restricted_operation: OPERATION`).
- One contract is weaker than another when its gates don't cover every requirement of the other, or its `restrict`
  leaves out one of the other's operations.

## Selecting a contract

Users select a contract in one of three ways:

- `omd-package contract select ID@VERSION` in the repository;
- `omd-contract select STORE REPOSITORY ID@VERSION`;
- from the terminal, through a mod that calls `contract.select {contract}` from a user action (capability
  `contracts`).

```text
contract.select {contract} → {selected, applies: 'next_session'} | {status: 'declined'}
```

`contract.select` shows a native confirmation that names the `assurance` labels when the choice is weaker than the
current contract, then writes the same user selection that the commands above write. It applies from the next session.

- `omd-contract require` records a project floor in `.omd/contract-selection.json`, the weakest contract the
  repository accepts. A weaker selection doesn't apply; the floor does.
- Selections pin the document digest. A mod that changes a registered document makes the selection unavailable
  instead of silently weakening it.
- A weaker selection needs the confirmation printed by `omd-contract plan`.
- With no selection nothing is gated.
- An unavailable selection fails closed.

## `receipts.submit`

`receipts.submit` records a receipt with a host-attested producer.

```text
receipts.submit {kind, candidate_sha256, acceptance_sha256?, outcome: 'pass' | 'fail', evidence, agent?, execution?,
                 findings?, resolves?} → Receipt
```

- `agent` must be an agent handle that:
  - is completed and read-only;
  - belongs to the caller in the same session;
  - was spawned on a [snapshot](workspace-files.md#snapshots-workspacesnapshot) of the receipt's candidate.
- `evidence` must be that agent's result reference.
- A claimed `acceptance_sha256` must equal the evidence the agent was given.
- An isolated-worktree agent cannot attest its own candidate.
- Only a successful `workspace.integrate` can record an `integration` producer; an execution receipt cannot
  impersonate one.

## Completion and integration gates

`task.complete {candidate_sha256, acceptance_sha256?}` checks the current workspace against the `complete` gate and
returns `completed` or `refused` with the missing requirements.

[`workspace.integrate`](agents.md#workspaceintegrate) checks the `integrate` gate against the agent's candidate
(`candidate_sha256` from `agents.result`) and records an integration receipt tied to the resulting parent candidate and
the supplied acceptance digest.

- It refuses before touching the parent when the contract can't accept another receipt.
- If the receipt can't be recorded after the files are applied, the result is still `integrated` and contains
  `receipt_error`.

Pass `acceptance_sha256` to `task.complete` or `workspace.integrate` when the selected contract binds receipts to
acceptance criteria.

## Blocking findings and the finding ledger

A receipt can report `findings`, each identified by a `fingerprint` and with a severity of `advice`, `warning` or
`blocking`. For an active contract, blocking finding fingerprints remain open across later receipts and candidate
changes. `contract.status.finding_ledger` reports each finding and its resolution.

A passing `receipts.submit` from a completed, host-attested agent may include `resolves: [fingerprint, ...]` for at
most 32 distinct open findings. A resolving receipt must meet all of these:

- The candidate changed since the finding.
- The acceptance digest is the original one.
- The agent:
  - was spawned read-only from a frozen snapshot;
  - is different from the reporting agent;
  - was given `resolution_context: {acceptance_sha256, findings}` and the matching acceptance evidence.
- The agent's JSON result has a top-level `resolution_assertion` with `outcome: "pass"`, `candidate_sha256`,
  `acceptance_sha256` and the exact fingerprint set.

The host delivers the open finding details to the resolving agent, binds the context to it, and checks the
assertion before accepting `resolves`. The host attests only that an independent agent produced the result with that
review context. Whether the fix addresses the finding is the agent's judgment.

- Submitting a clean later receipt does not erase an earlier blocker.
- The ledger survives explicit resume and is replay-checked on restore.
- `task.complete` refuses while any blocker remains, returning `reason: "unresolved_blocking_findings"` and
  `outstanding_findings`.
- A session without a selected contract remains ungated.

## Scoped restrictions

`contract.restrict {operations?, scoped?, reason}` only narrows operations for the rest of the session. It can also
narrow matching arguments. Each scoped rule is
`{operation, when: {"/json/pointer": scalar}}`; all predicates must match.

For example, restricting `agents.spawn` when `"/workspace"` equals `"isolated_worktree"` leaves read-only agents
available.

- There are at most 64 rules with 1–8 scalar predicates each.
- Restrictions only narrow: a later restriction never widens an earlier one.
- Saved rules are validated again on restart.

## Contract withdrawal and persistence

The host rechecks the selected document at each turn start and after a mod fails. If no active mod still registers
the same document digest, the contract becomes unavailable (`contract_withdrawn`). Completion, integration and
receipts fail closed until the same document is registered again.

Contract receipts and restrictions survive restart in protected session state. The selected document and owner must
still match; invalid state fails closed.
