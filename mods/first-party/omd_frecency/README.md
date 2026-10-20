# omd_frecency

Ranks `@` file mentions by how well they match, how often you use them and their Git status.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_frecency
```

## Use it

Type `@` and a few letters in the prompt. There is no command to run and nothing to configure.

| What you see | Why |
| --- | --- |
| Files whose name starts with your letters come first. | Then names or paths that contain them, then looser matches. |
| A query with a capital letter matches case exactly. | Otherwise case is ignored. |
| A small typo still finds the file. | `parsre` finds `parser.ts` once the query has four or more characters. |
| Files you mention often, and recently, rank higher. | A file path in a submitted prompt counts as a use. |
| Staged and modified files rank higher, then untracked ones. | It runs `git status` at most every 30 seconds. |

## Needs and limits

- Usage is kept per project, for the 512 strongest files. Ignored and missing files are not learned.
- Outside a Git repository you lose only the Git boost.
- It changes `@` ranking only. The agent's own search tools are unchanged.
- Turn it off and Codex's own ranking returns.

Credit: based on [@ff-labs/pi-fff](https://github.com/dmtrKovalenko/fff/tree/main/packages/pi-fff) by Dmitriy Kovalenko (MIT); reimplemented, no code copied.
