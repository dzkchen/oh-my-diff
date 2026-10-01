# omd_frecency

Opt-in first-party mod (`0.1.0-preview.1`, API `0.2.0-experimental.5`) that
ranks `@` file mentions, and `omd_panes` file-tree find, by fuzzy match,
per-project frecency and Git status. The agent's search tools are unchanged.

**Matching.** Smart case: a query with an uppercase letter matches case
exactly, otherwise case is ignored. A file name that starts with the query
ranks first, then a name or path that contains it, then a subsequence. A query
of four or more characters also matches with one missing, extra or swapped
character per four characters (`parsre` finds `parser.ts`).

**Ranking.** Each match adds a frecency boost (more uses, more recently) and a
Git boost: staged or modified files +20, untracked files +10. Ties keep
Codex's order. The candidates are Codex's own fuzzy results plus the project's
frecent and changed files, so a typo still finds the files you use.

**Learning.** When you submit a prompt, the `input` hook queues file paths in
it (`@src/a.ts:12`, `"docs/my notes.md"`, at most 16) in mod state, because the
host gives that hook no host operations. When the turn starts, queued paths
that Git tracks or would track count as a use. Ignored and missing files are
not learned. Recency counts submitted uses, not wall
time. The 512 strongest entries are kept in repository-scoped mod storage. A
renamed or deleted file is dropped from the results and from storage the first
time it would be shown.

**Owner.** The mod owns the exclusive `completion` replacement for `@`
mentions. The host sends each mod command's argument completion to that
command's own mod, so `omd_notes` keeps `/note` completion alongside it.
Disabling the mod restores Codex's ranking. `omd_panes` reorders tree find
results through the `omd.frecency` service when this mod is enabled.

Each ranking runs `git status` (3 s limit) and reads the store; a missing Git
repository only removes the Git boost.

Capabilities: `composer` (`@` ranking), `input` and `lifecycle` (learning), `store`, `exec`
(`git status`, `git ls-files`), `fs.read` (existence checks) and `services`.

Ported from [`@ff-labs/pi-fff`](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff)
0.11.0 (Dmitriy Kovalenko, MIT; see `THIRD_PARTY_NOTICES.md`): frecency,
Git-aware boosts, smart case and typo-tolerant matching for `@` completion.
This package reimplements that behavior over the OMD mod API and copies no
code; FFF's native index, `find`/`grep` tool replacements and query history are
not ported.
