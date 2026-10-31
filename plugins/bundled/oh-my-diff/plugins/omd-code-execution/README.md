# omd-code-execution

Guides the model to run code cells in Codex code mode, a Codex feature where the model writes small programs that call
the session's tools. It covers JavaScript cells with session storage, and Python and Bun cells that keep their state
between calls. Cells call tools through Codex's own tool router, so its permissions and task controls apply. OMD+ puts
it on disk but doesn't install it, so you add it yourself. OMD Core doesn't include it.

The plugin is guidance only. It has no mod component. The Python and Bun drivers ship in its `kernels/` folder.

## Turn it on

1. Add the plugin. [Plugins](../../../../README.md) has the steps.
2. For JavaScript cells only, start Codex with code mode on:

   ```sh
   codex -c features.code_mode.enabled=true
   ```

3. For Python and Bun cells, add kernel entries to your Codex config (`${CODEX_HOME:-$HOME/.codex}/config.toml`).
   `driver` is the absolute path of the installed driver and `driver_sha256` is its SHA-256. Find the installed
   plugin folder and the digests with:

   ```sh
   ROOT=$(ls -d "${CODEX_HOME:-$HOME/.codex}"/plugins/cache/oh-my-diff/omd-code-execution/* | tail -1)
   shasum -a 256 "$ROOT/kernels/python.py" "$ROOT/kernels/bun.mjs"
   ```

   Then add this block, with your paths and digests:

   ```toml
   [features.code_mode]
   enabled = true

   [[features.code_mode.kernels]]
   name = "python"
   command = ["python3", "-u", "-c"]
   driver = "/absolute/path/to/omd-code-execution/kernels/python.py"
   driver_sha256 = "<sha256 of python.py>"

   [[features.code_mode.kernels]]
   name = "bun"
   command = ["bun", "-e"]
   driver = "/absolute/path/to/omd-code-execution/kernels/bun.mjs"
   driver_sha256 = "<sha256 of bun.mjs>"

   [features.code_mode_host]
   enabled = true
   disable_in_process_fallback = true
   ```

Codex refuses a kernel whose driver is missing or changed, so update the digests after a plugin update. Remove the
kernel entries to remove the kernel tool.

## Use it

Ask Codex to use `$omd-code-execution:omd-code-execution`, for example: "Read a bounded CSV through an agent tool in
Python, then chart it in Bun".

- JavaScript cells run in a fresh V8 isolate each call. `store("key", value)` saves serializable state and
  `load("key")` reads it in a later call.
- Python keeps module globals across cells. Bun keeps `globalThis` across cells.
- A Python or Bun worker (the kernel process that runs the cells) can call only the tools available in the cell that
  started it.
- Cell output is captured in the order it was written. Anything written after the cell ends is discarded.

## Needs and limits

- Python and Bun cells need `python3` and `bun` on your machine. The plugin doesn't install them or any libraries.
- If a worker is missing, the model reports it and continues with JavaScript cells or direct tools.
- A sandbox that denies the worker's loopback connection fails closed.
- Each cell has bounded source, output, duration and nested calls. Output past the limit is dropped and
  `kernel output limit exceeded` is added to the cell's error. Code-mode recursion is refused.
- Each cell gets a fresh token that expires when the cell ends, so background work from an older cell can't use a
  later cell's tool access.
- Session shutdown stops the worker processes.

## More

- [Remove a plugin](../../../../README.md#remove-a-plugin)
- [`omd_programmable_context`](../../../../../mods/first-party/omd_programmable_context/README.md) uses the Python
  kernel.
