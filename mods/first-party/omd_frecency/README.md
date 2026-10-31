# omd_frecency

Ranks `@` file mentions by how well they match, how often you use them, their Git status and recent commits. It's off
by default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_frecency
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

Type `@` and a few letters in the prompt. There is no command to run. For example, `@parser` puts `parser.ts` above
`parser_utils.ts`.

How files rank:

- A file named exactly what you typed ranks highest, with or without its extension. Files whose names start with your
  letters come next, then names or paths that contain them, then looser matches. How often you use a file and its Git
  status can lift a close match above a better one.
- A query with a capital letter matches case exactly. Otherwise case is ignored.
- A small typo still finds the file once the query has four or more characters: `parsre` finds `parser.ts`.
- Files you mention often, and recently, rank higher. A file path in a submitted prompt counts as a use.
- Staged and modified files rank higher, then untracked ones. It runs `git status` at most every 30 seconds.
- Changed files you saved recently rank higher. The lift is largest for a save in the last 2 minutes, and it
  drops in steps at 15 minutes, an hour, a day and a week.
- Files from recent commits rank a little higher: the last 10 commits on your branch since it left `main` (or
  `master`, or `origin/HEAD`), or the last 10 on the default branch. Merges and commits touching over 50 files are
  skipped.

## Settings

It has no settings.

## Needs and limits

- Usage is kept per project for the strongest files, up to 512 paths or 32 KB of paths, whichever limit comes first
  (about 400 typical paths). Ignored and missing files are not learned.
- Outside a Git repository you lose only the Git boosts.
- With a very large Git status, only the first changed files (about 6 KB of paths, staged and modified first) keep
  their lift, and only the first 64 (about 2 KB of paths) get the recent-save lift.
- Recent commits are read again only when HEAD moves, so a fetch that moves `origin/main` shows up after your next
  commit or checkout.
- It changes only `@` ranking and the answers of its `omd.frecency` service for other mods. The agent's own search tools
  are unchanged.
- Turn it off and Codex's own ranking returns.

## For mod authors

Other mods can call the `omd.frecency` 1.0.0 service with
[`api.services.call`](../../reference/sdk-helpers.md#other-api-members). Its one method, `rank {query?}`, returns
`{paths}`: up to 50 existing files ranked the same way, best first. A query longer than 256 characters is cut. An
empty query ranks by use and Git alone. The provider reads its store and runs `git`, so call it from a lifecycle or
channel callback, not from a slash command or key (see
[callback contexts](../../reference/host-model.md#callback-contexts)).

```ts
const { paths } = api.services.call<{ paths: string[] }>('omd.frecency', 'rank', { query: 'parser' });
```

The caller needs the `services` capability and an import in `mod.json`. [`omd_files`](../omd_files/README.md)
marks it optional:

```json
"services": {"imports": [{"name": "omd.frecency", "version": "1.0.0", "optional": true}]}
```

## More

- [Included mods](../../../docs/collection.md)
- [`omd_files`](../omd_files/README.md) uses it for the `z` jump list
- [`@` mention completion](../../reference/commands-and-composer.md#-mention-completion) in the mod API reference
- Credit: based on [@ff-labs/pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) by Dmitriy
  Kovalenko (MIT); reimplemented, no code copied.
