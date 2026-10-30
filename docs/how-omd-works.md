# How OMD works

What Oh My Diff adds to Codex, how mods run beside it, and when to use a mod instead of a plugin, skill or hook. For
anyone who wants to understand the design before installing OMD or writing a mod.

## OMD is Codex with one patch

OMD is the Codex CLI built from upstream source with one patch applied. The patch adds a mod host. When no mod uses
one of the host's building blocks, the host allocates nothing for it and changes no Codex decision. The repository
contains no copy of Codex: it contains the patch (`runtime/patches/omd-0.165.0.patch`), a manifest of file hashes, and
readable copies of the crates the patch adds.

The patch applies to one exact Codex release tag. Applying it checks every file's hash before and after, and refuses a
file that matches neither, so a patch built for one Codex version can't land on another. Releases ship prebuilt and
signed binaries; your machine never applies the patch.

Most of the patch is new code rather than edits to upstream files, and most of the new code is in three crates:

- `codex-omd` (`runtime/omd`) is the mod host. It loads mods, checks their permissions and runs their callbacks.
- `codex-omd-runner` (`runtime/omd/runner`) is the `omd-runner` program that runs mod code.
- `codex-omd-extension` (`runtime/native`) connects the host to Codex threads, turns, tools and the terminal UI.

Each OMD release supports one Codex version line, because the patch fits one tag. When Codex ships a new version, the
patch is rebuilt against it and a new OMD release follows. [Support](support.md) explains what that means for updating
Codex.

## You still run `codex`

The installer puts a `codex` launcher in `~/.local/bin` that starts the OMD build instead of the one you installed.
Your settings, sign-in, sessions and history in `~/.codex` are the ones Codex uses, so you can go back to plain Codex
with nothing to migrate.

The build has two modes. With the mod host on, it loads your mods. In direct mode it behaves as upstream Codex with no
mods, which is how `omd-package activate direct` recovers from a broken mod.

## The host has no features

Every feature in OMD+ is a TypeScript mod in `mods/first-party`, written against the same public API as any other mod.
The native code provides general building blocks that several unrelated mods can use, such as tool interception,
terminal panels and model routes, and never one feature. A repository check fails if native code names a feature or a
first-party mod. The rule is meant to keep the patch small enough to rebuild for each Codex release.

The two profiles are mod selections. OMD Core installs three mods (`omd_mods`, `omd_update`, `omd_logo`). OMD+
installs the rest of the [included mods](collection.md) and turns some of them on.

## Mods run in their own processes

The host runs inside the `codex` process. Mod code runs outside it, in `omd-runner` processes that embed the V8
JavaScript engine:

- Each mod package gets its own runner processes, never shared with another package.
- Each runner runs under a macOS sandbox profile that denies by default. The runner may start only itself, can't write
  files and has no network.
- V8 runs with a 64 MiB heap, string evaluation (`eval`) and WebAssembly code generation turned off, and the host
  kills a runner that uses more than 512 MiB.
- Each callback runs in a fresh context, so one call can't leave state behind for the next.

A mod reaches anything outside its runner through host calls, such as reading a workspace file, running a program or
drawing a panel. The host checks every call against the permissions you granted and records it. A callback may make up
to 512 host calls, with 1 MiB of arguments and results in total. A mod whose callbacks fail five times in a row is
turned off ([fault limit](../mods/reference/host-model.md#fault-limit)). If a runner crashes, Codex keeps running.

[Trust and permissions](trust-and-permissions.md) explains how permissions are granted. The
[limits reference](../mods/reference/limits.md) has every limit.

## Mods, plugins, skills and hooks

Codex `0.165.0` already has plugins, skills and hooks. A mod is for the changes they can't make.

| Use | For |
| --- | --- |
| A skill | A procedure the model follows |
| A hook | A reaction to a lifecycle event, such as a finished turn |
| A plugin | Tools or services Codex can call, optionally with an MCP server |
| A mod | Changing how `codex` itself behaves or looks: commands, screens, requests, tool calls |

Codex `0.165.0` plugins bundle skills, prompts, MCP servers and hook files. Its hooks are external commands or MCP tools
that return a decision: block a call, add context, or rewrite a tool's input.

A hook can't hold state, stream, draw on screen, route a model or run an agent. When two `pre_tool_use` hooks rewrite
the same call, the last one to finish wins. A mod is loaded by the host, keeps state, draws in the terminal, and
combines with other mods in a defined order.

A plugin can bundle skills and a mod together. OMD+ stages four Codex plugins; see [plugins](../plugins/README.md).

## See also

- [Trust and permissions](trust-and-permissions.md)
- [Write your first mod](mod-authors/first-mod.md)
- [Contributing to the patched runtime](contributing/runtime.md)
