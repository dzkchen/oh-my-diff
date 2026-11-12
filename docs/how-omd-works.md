# How OMD works

Oh My Diff (OMD) adds TypeScript mods to Codex CLI, OpenAI's coding agent for the terminal. Mods can change its
commands, tools, model requests and terminal UI. OMD runs each mod in a separate sandboxed process.

## You still run `codex`

The installer puts a `codex` launcher in `~/.local/bin` that starts the OMD build instead of the one you installed.
Your settings, sign-in, sessions and history in `~/.codex` are the ones Codex uses, so you can go back to plain Codex
with nothing to migrate.

OMD's `codex` loads mods. For example, `omd_tool_lines` groups adjacent shell commands and shortens
other tool calls to one line you open for the full output, and `omd_statusline` adds a status line you can edit.
Both are on by default in OMD+.

If a mod breaks `codex`, run `omd-package activate direct`. `omd-package` manages your install profile, and `direct`
is a recovery state in which the build behaves as plain Codex with no mods.

## OMD is Codex with one patch

OMD is the Codex CLI built from upstream source with one patch applied. The patch adds a mod host, the part of
`codex` that loads mods and gives them building blocks such as tool interception and terminal panels. When no mod uses
a building block, the host allocates nothing for it and changes no Codex decision. The repository contains no copy of
Codex. It contains the patch (`runtime/patches/omd-CODEX_VERSION.patch`), a manifest of file hashes, and readable copies of
the crates (Rust packages) the patch adds.

The patch applies to one exact Codex release tag. The build checks each file against its recorded hashes before
and after patching, and refuses to overwrite a file that matches neither. It also refuses another Codex version.
Releases ship prebuilt and signed binaries, so your machine never applies the patch.

Most of the patch is new code rather than edits to upstream files. Most of that new code is in three crates: the mod
host, the mod runner, and the extension that connects the host to Codex. The
[runtime README](../runtime/README.md#crates) lists them.

Each OMD release supports one Codex version line, because the patch fits one tag. When Codex ships a new version, the
patch is rebuilt against it and a new OMD release follows. [Support](support.md) explains what that means for updating
Codex.

## The host has no features

Every feature in OMD+ is a TypeScript mod in `mods/first-party`, written against the same public API as any other mod.
The mod host provides APIs that several unrelated mods can use, such as tool interception, terminal panels and model
routes. Feature code belongs in mods. A repository check rejects feature names and first-party mod IDs in the patch
to help keep it small enough to rebuild for each Codex release.

The two install profiles are mod selections. OMD Core installs three mods (`omd_mods`, `omd_update`, `omd_logo`).
OMD+ installs the supported first-party selection in the [collection](collection.md) and turns some of them on.
Experimental mods and ports require a separate `omd install ID`.

## Mods run in their own processes

The host runs inside the `codex` process. Mod code runs outside it, in `omd-runner`, OMD's mod runner. Each mod
package gets its own runner process, and macOS sandboxes each runner so it can't write files or use the network. A mod
reaches anything outside its runner only through host calls, the requests it makes to the host to read a file, run a
program or draw on screen. The host checks each call against the permissions you granted. If a runner crashes, Codex
keeps running.
[Trust and permissions](trust-and-permissions.md#the-sandbox) describes the sandbox and the runner's limits.

## What mods cost in memory and startup time

Each active package needs a runner, which adds memory use. If one crashes or runs out of memory, Codex keeps running.
Before OMD 1.0.1, mods ran on Node, and each runner used about 43 MB. OMD 1.0.1
replaced Node with a runner that embeds the V8 JavaScript engine. It uses about 6–15 MB and starts about twice as fast
([changelog](../CHANGELOG.md)).

For a whole session:

- Codex alone and OMD+ were both ready to type in about 0.3 s.
- OMD+ as installed used about 100 MB, including the `omd-runner` processes that run its mods (7–10 MB each).
- Turning on `omd_preview`, `omd_profiles`, `omd_usage` or `omd_mini` added a runner of about 8–12 MB. Programs a
  mod starts, such as `omd_lsp_sync`'s language servers, use their own memory while they run.

These were measured on one Apple M5 Mac with a scripted model and release builds on Codex `0.165` and `0.166` in
October 2026. Memory is the macOS memory footprint (the figure Activity Monitor shows), 10 seconds after start. Your
numbers will differ.

## Mods, plugins, skills and hooks

Codex `0.167.2` already has plugins, skills and hooks. A mod is for the changes they can't make.

| Use | For |
| --- | --- |
| A skill | A procedure the model follows |
| A hook | A reaction to a lifecycle event, such as the model finishing its work on your message |
| A plugin | Tools or services Codex can call, optionally with an MCP server (a program that offers tools over the Model Context Protocol) |
| A mod | Changing how `codex` itself behaves or looks: commands, screens, requests, tool calls |

Codex `0.167.2` plugins bundle skills, prompts, MCP servers and hook files. Codex hooks are external commands or MCP
tools that return a decision: block a call, add context, or rewrite a tool's input.

A hook can't store state between calls, stream output, draw on screen, choose which model answers or run an agent.
`pre_tool_use` hooks run before a tool call, and when two of them rewrite the same call, the last one to finish wins.
A mod is loaded by the host, stores state, draws in the terminal, and combines with other mods in a defined order.

A plugin can also contain a mod. The [plugins page](../plugins/README.md) lists the plugin that OMD+ puts on disk
for you to add, the experimental ones, and their mod components.

## See also

- [Trust and permissions](trust-and-permissions.md)
- [Write your first mod](mod-authors/first-mod.md)
- [Contributing to the patched runtime](contributing/runtime.md)
