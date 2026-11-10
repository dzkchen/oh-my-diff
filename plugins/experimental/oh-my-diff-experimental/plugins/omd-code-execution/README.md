# omd-code-execution

Guides the model to run code cells in Codex code mode, a Codex feature where the model writes small programs that call
the session's tools. It covers JavaScript cells with session storage, and Python and Bun cells that keep their state
between calls. Cells call tools through Codex's own tool router, so its permissions and task controls apply. It's experimental: no install profile stages it. [Experimental plugins](../../../../README.md#experimental-plugins)
has the steps to add it.

The plugin is guidance only. It has no mod component. The Python and Bun drivers ship in its `kernels/` folder, and
`scripts/install_kernels.py` installs them for Codex.

## Turn it on

1. Add the plugin. [Plugins](../../../../README.md) has the steps.
2. For JavaScript cells only, start Codex with code mode on:

   ```sh
   codex -c features.code_mode.enabled=true
   ```

3. For Python and Bun cells, run the setup script. It copies `python.py` and `bun.mjs` to
   `${CODEX_HOME:-$HOME/.codex}/omd/kernels/` under names that carry their digest, and with `--write` it adds or
   updates the `python` and `bun` kernel entries in your Codex config (`${CODEX_HOME:-$HOME/.codex}/config.toml`),
   plus `[features.code_mode]` and `[features.code_mode_host]` when they are missing. It leaves the rest of the file
   as it was and keeps the previous one as `config.toml.bak`. If the new file doesn't read back correctly, it
   restores the old one.

   ```sh
   ROOT=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/oh-my-diff-experimental/omd-code-execution/* | tail -1)
   python3 "$ROOT/scripts/install_kernels.py" --write
   ```

   Without `--write` the script changes no config and prints the entries instead.

Run the script with `--write` again after each plugin or OMD update. It says `config is current` for a kernel whose
entry still matches. When a driver changed it adds a new copy beside the old one and points the entry at it, so the
old copy stays on disk. Codex still refuses a kernel whose driver is missing or changed. Remove the kernel entries to
remove the kernel tool.

## Use it

Ask Codex to use `$omd-code-execution:omd-code-execution`, for example: "Read a bounded CSV through an agent tool in
Python, then chart it in Bun".

- JavaScript cells run in a fresh V8 isolate each call. `store("key", value)` saves serializable state and
  `load("key")` reads it in a later call.
- Python keeps module globals across cells. Bun keeps `globalThis` across cells.
- A Python or Bun worker (the kernel process that runs the cells) can call only the tools available in the cell that
  started it.
- Cell output is captured in the order it was written. Anything written after the cell ends is discarded, including
  output from a cell's threads, timers or child processes that runs during a later cell.

## Needs and limits

- Python and Bun cells need `python3` and `bun` on your machine. The plugin doesn't install them or any libraries.
- If a worker is missing, the model reports it and continues with JavaScript cells or direct tools.
- A sandbox that denies the worker's loopback connection fails closed.
- Each cell has bounded source, output, duration and nested calls. Output past the limit is dropped and
  `kernel output limit exceeded` is added to the cell's error. Code-mode recursion is refused.
- Each cell gets a fresh token that expires when the cell ends, so background work from an older cell can't use a
  later cell's tool access.
- Session shutdown stops the worker processes.
- Update the kernel drivers and OMD together. Since 0.3.0 each cell's result marker carries that cell's token, so a
  driver and host from different releases can't finish a cell.

## More

- [Remove a plugin](../../../../README.md#remove-a-plugin)
- [`omd_programmable_context`](../../../../../mods/first-party/omd_programmable_context/README.md) uses the Python
  kernel.
