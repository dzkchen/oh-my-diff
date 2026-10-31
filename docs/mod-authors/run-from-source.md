# Run the author tools from a source checkout

How to run `omd-mod-author` from a checkout of this repository instead of an OMD install, for example to test a
change to the SDK or to work on a machine without OMD.

## Before you begin

You need:

- A checkout of this repository.
- An `omd-mod` binary and the `omd` and `codex` binaries, all from the same
  [OMD release](https://github.com/dzkchen/oh-my-diff/releases) archive.
- Node 24.18 or a later 24.x and [pnpm](https://pnpm.io) 11.14 or later. [Support](../support.md) lists the
  supported versions.

## Point the author tools at the checkout

From the checkout's root folder, in the shell you work in:

```sh
pnpm --dir mods install
export OMD_MOD_BIN=/absolute/path/to/omd-mod
mkdir -p ~/.local/bin
printf '#!/bin/sh\nexec node /absolute/path/to/checkout/mods/author/cli.mjs "$@"\n' > ~/.local/bin/omd-mod-author
chmod +x ~/.local/bin/omd-mod-author
```

`~/.local/bin` must be on your `PATH`: a mod's `pnpm check`, `pnpm test` and `pnpm watch` scripts run
`omd-mod-author` as a program, so a shell function or alias won't work.

`OMD_MOD_BIN` tells `omd-mod-author` which `omd-mod` to run. Without it, `omd-mod-author` looks for `omd-mod` on your
`PATH`.

Check that it works:

```sh
omd-mod-author --help
```

It prints the usage line, starting with `usage: omd-mod-author create DIR [ID]`.

Node prints an `ExperimentalWarning` for `stripTypeScriptTypes` on each command. It's harmless.

## Next steps

- [Write your first mod](first-mod.md) with these tools. Where it runs the installed `codex`, run the `codex` from
  the same archive as your `omd-mod`.
- [Run and debug a mod](run-and-debug.md) in a scratch store.
