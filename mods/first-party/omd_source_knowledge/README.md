# omd_source_knowledge

Lets the agent keep notes about a repository for later tasks, each checked against the file it points at before it's
reused. It's off by default in OMD+. OMD Core doesn't include it.

A fact points at exact lines of a file and is checked against the file each time it's reused. The agent can also keep
a copy of a small structured result from the current thread, such as a test report, as evidence, and propose lessons
from that evidence. A lesson is used only after you approve it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_source_knowledge
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

The agent calls its tools. You don't need to.

| Tool | What it does |
| --- | --- |
| `retain_source` | Keeps a fact: a label plus a file path and line range (up to 200 lines) |
| `retain_evidence` | Keeps a copy of one piece of this thread's evidence: JSON of at most 8 KB, refused if larger |
| `propose_lesson` | Proposes a lesson that cites kept evidence; it stays unused until you approve it |
| `session` | `reuse` rechecks every fact against the files and returns the valid ones with the approved lessons; `cold` returns nothing |
| `inspect` | Lists everything kept, including facts that are no longer valid and why |

When it reuses a fact, it rereads a changed file and returns the current text of the fact's lines. A fact is marked
invalid and left out when:

- its file is gone, is no longer a small text file or is now shorter than the fact's lines
- those lines are now blank, start or end with whitespace, or look like a credential

Lessons whose evidence was removed are left out too.

Every call names the repository. Calls that add, approve or remove notes also name the revision they expect, a number
that goes up each time the notes change. If the notes changed in between, the call is refused with
`knowledge_revision_stale` and nothing is written. Reuse and `inspect` can also raise the revision when they record a
changed fact.

### Approve and remove

Three commands each take one line of JSON with no spaces outside quoted text. Ask the agent to run `inspect` for the
repository name and current revision.

```text
/omd_source_knowledge:approve_lesson {"repository_identity":"my-app","expected_revision":7,"lesson_id":"flaky-retry","action":{"actor":"me","reason":"seen twice"}}
/omd_source_knowledge:forget {"repository_identity":"my-app","expected_revision":8,"kind":"evidence","id":"ci-run-1","action":{"actor":"me","reason":"outdated"}}
/omd_source_knowledge:discard {"repository_identity":"my-app","expected_revision":9,"action":{"actor":"me","reason":"start over"}}
```

- `approve_lesson` approves a proposed lesson whose evidence is still kept.
- `forget` removes one `fact`, `evidence` record or `lesson`. Lessons that cite forgotten evidence go back to
  proposed, so approve them again if the evidence comes back.
- `discard` removes everything kept for the repository.

## Settings

It has no settings.

## Needs and limits

- Up to 16 facts, 8 evidence records and 8 lessons per repository, 32 KB in all.
- Paths are relative to the repository. Paths with `..`, `.git` or a symlink are refused, and files must be readable
  under the session's permissions. A fact's text can't start or end with whitespace, so a range can't start on an
  indented line or end with trailing spaces.
- Text that looks like a credential is refused and never stored: private keys, `Authorization` headers, `api_key`,
  `password=` and tokens starting `sk-`, `ghp_` or `xoxb-`, for example.
- Files over 48 KB aren't read, and one reuse rereads at most 48 KB of changed files. Facts past that are left out
  this time and rechecked next time.
- Evidence must still be readable in the current thread when it's kept. Later tasks reuse the stored copy.
- The agent passes the repository and task names, and OMD doesn't verify them. The actor and reason of an
  approval are stored as typed, and the mod can't confirm who ran the command. Only the current notes are kept, with
  no history of approvals or removals.

## More

- [Included mods](../../../docs/collection.md)
