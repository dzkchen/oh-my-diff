# Contracts and receipts

Use it when a mod registers a workflow contract, submits receipts, checks the completion or integration gate, or
narrows operations for the rest of a session. The agents that produce receipts are in [Agents](agents.md).

A contract is a versioned document that gates task completion and workspace integration on receipts. Mods register
documents; users select one.

## Registering a contract

`api.contract(document)` registers a versioned schema-2 contract document:

```ts
{schema: 2, id, version, description, assurance, gates: {complete?, integrate?}, restrict?}
```

A requirement names a receipt kind, a producer (`any`, `lead`, `host`, `integration` or `separate_agent`), bindings
(`candidate`, `acceptance`) and whether blocking findings are allowed.

## Selecting a contract

- Users select a contract with `omd-contract select STORE REPOSITORY ID@VERSION`.
- `omd-contract require` records a project floor in `.omd/contract-selection.json`.
- Selections pin the document digest. A mod that changes a registered document makes the selection unavailable
  instead of silently weakening it.
- A weaker selection needs the confirmation printed by `omd-contract plan`.
- With no selection nothing is gated.
- An unavailable selection fails closed.

### Selecting a workflow contract

Users select a workflow contract with `omd-package contract select ID@VERSION` (or `omd-contract select STORE
REPOSITORY ID@VERSION`) in the repository, or from the terminal through a mod's `contract.select {contract}`
(`contracts`, user actions only).

The host shows a native confirmation that names any assurance the choice lowers, writes the same user selection and
returns `{selected, applies: 'next_session'}` or `{status: 'declined'}`. It applies from the next session.

## `receipts.submit`

`receipts.submit` records a receipt with a host-attested producer.

- `agent` must be a completed, read-only agent handle owned by the caller in the same session, spawned on a
  [snapshot](workspace-files.md#snapshots-workspacesnapshot) of the receipt's candidate.
- `evidence` must be that agent's result reference.
- A claimed `acceptance_sha256` must equal the evidence the agent was given.
- An isolated-worktree agent cannot attest its own candidate.
- Only a successful `workspace.integrate` can record an `integration` producer; an execution receipt cannot
  impersonate one.

## Completion, integration and restriction

`task.complete {candidate_sha256, acceptance_sha256?}` checks the current workspace against the `complete` gate and
returns `completed` or `refused` with the missing requirements.

[`workspace.integrate`](agents.md#workspaceintegrate) checks the `integrate` gate against the agent's candidate
(`candidate_sha256` from `agents.result`) and records an integration receipt tied to the resulting parent candidate and
the supplied acceptance digest.

- It refuses before touching the parent when the contract cannot hold another receipt.
- If the receipt cannot be recorded after the files are applied, the result is still `integrated` and carries
  `receipt_error`.

Pass `acceptance_sha256` to `task.complete` or `workspace.integrate` when the selected contract binds receipts to
acceptance criteria.

`contract.restrict` only narrows operations for the rest of the session.

## Blocking findings and the finding ledger

For an active contract, blocking finding fingerprints remain open across later receipts and candidate changes.
`contract.status.finding_ledger` reports each finding and its resolution.

A passing `receipts.submit` from a completed, host-attested agent may include `resolves: [fingerprint, ...]` for at
most 32 distinct open findings. The resolution must use:

- a changed candidate;
- the original acceptance digest;
- a different agent from the reporting agent.

The resolving agent must be spawned read-only from a frozen snapshot with `resolution_context: {acceptance_sha256,
findings}` and the matching acceptance evidence. The host:

- delivers the open finding details;
- binds that context to the agent;
- checks a matching top-level `resolution_assertion` in the agent's actual JSON result before accepting `resolves`.

The assertion contains `outcome: "pass"`, `candidate_sha256`, `acceptance_sha256`, and the exact fingerprint set.
This attests the independent result and its declared review context; interpretation of the finding and fix remains
the agent's judgment.

- Submitting a clean later receipt does not erase an earlier blocker.
- The ledger survives explicit resume and is replay-checked on restore.
- `task.complete` refuses while any blocker remains, returning `reason: "unresolved_blocking_findings"` and
  `outstanding_findings`.
- A session without a selected contract remains ungated.

## Scoped restrictions

`contract.restrict {operations?, scoped?, reason}` can also narrow matching arguments. Each scoped rule is
`{operation, when: {"/json/pointer": scalar}}`; all predicates must match.

For example, restricting `agents.spawn` when `"/workspace"` equals `"isolated_worktree"` leaves read-only agents
available.

- There are at most 64 rules with 1–8 scalar predicates each.
- Restrictions are monotone, and saved rules are validated again on restart.

## Contract withdrawal and persistence

The host rechecks the selected document at each turn start and after a mod fails. If no active mod still registers
the same document digest, the contract becomes unavailable (`contract_withdrawn`). Completion, integration and
receipts fail closed until the same document is registered again.

Contract receipts and restrictions survive restart in protected session state. The selected document and owner must
still match; invalid state fails closed.
