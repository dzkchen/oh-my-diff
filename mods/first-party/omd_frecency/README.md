# omd_frecency

Ranks `@` file mentions by how well they match, how often you use them, their Git status and recent commits.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd mods enable omd_frecency
```

## Use it

Type `@` and a few letters in the prompt. There is no command to run and nothing to configure.

| What you see | Why |
| --- | --- |
| A file named exactly your letters ranks highest, then files whose name starts with them. | `parser` or `parser.ts` puts `parser.ts` above `parser_utils.ts`. Then names or paths that contain your letters, then looser matches. Use and Git can lift a close match above a better one. |
| A query with a capital letter matches case exactly. | Otherwise case is ignored. |
| A small typo still finds the file. | `parsre` finds `parser.ts` once the query has four or more characters. |
| Files you mention often, and recently, rank higher. | A file path in a submitted prompt counts as a use. |
| Staged and modified files rank higher, then untracked ones. | It runs `git status` at most every 30 seconds. |
| Changed files you saved recently rank higher. | The lift shrinks as the file ages: within 2 minutes, 15 minutes, an hour, a day, a week. |
| Files from recent commits rank a little higher. | The last 10 commits on your branch since it left `main` (or `master`, or `origin/HEAD`), or the last 10 on the default branch. Merges and commits touching over 50 files are skipped. Read again only when HEAD moves. |

## For other mods

`omd.frecency` 1.0.0 has one method, `rank {query?}`, which returns `{paths}`: up to 50 existing files ranked the same way, best first. An empty query ranks by use and Git alone. The provider reads its store and runs `git`, so call it from a lifecycle or channel callback, not from a slash command or key.

## Needs and limits

- Usage is kept per project for the strongest files, up to 512 or 32 KB of paths (about 400 typical paths). Ignored and missing files are not learned.
- Outside a Git repository you lose only the Git boosts.
- With a very large Git status, only the first changed files (about 6 KB of paths, staged and modified first) keep their lift, and only the first 64 (about 2 KB of paths) get the recent-save lift.
- Recent commits are read again only when HEAD moves, so a fetch that moves `origin/main` shows up after your next commit or checkout.
- It changes `@` ranking and answers `omd.frecency` only. The agent's own search tools are unchanged.
- Turn it off and Codex's own ranking returns.

Credit: based on [@ff-labs/pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) by Dmitriy Kovalenko (MIT); reimplemented, no code copied.
