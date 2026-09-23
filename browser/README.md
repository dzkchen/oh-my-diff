# Managed browser bundle

Oh My Diff pins one Apple Silicon browser stack in `browser.lock.json`: Node
24.21.0, pnpm 11.14.0, `@playwright/mcp` 0.0.81, its exact Playwright dependency,
and Chromium headless-shell revision 1244. The lock includes the official Node
archive URL and hash; `pnpm-lock.yaml` freezes the complete JavaScript graph.

The same managed Node runtime carries the optional application bridge host and
browser/Node plus Rust/Python/Java adapter sources from
[`../bridge`](../bridge). The bundled `omd-application-bridges` plugin starts
the managed host only for an enabled, hash-bound bridge policy; the Codex
launcher no longer injects that MCP server directly. See
[`../bridge/README.md`](../bridge/README.md).

The private installer provisions this bundle automatically. Source installs use
the checked-in package and lock, while prebuilt installs accept a hash-verified
archive produced from the same managed tree:

```sh
python3 scripts/browser_bundle.py provision /absolute/browser-bundle
python3 scripts/browser_bundle.py package \
  /absolute/browser-bundle /absolute/browser-bundle.tar.xz
python3 scripts/browser_bundle.py install-archive \
  /absolute/browser-bundle.tar.xz /absolute/prebuilt-browser \
  --sha256 ARCHIVE_SHA256
```

`provision` requires standalone pnpm 11.14.0. `--node-archive` supplies the
already-downloaded, hash-matching Node archive for an offline build. Provisioning
uses `pnpm install --prod --frozen-lockfile --ignore-scripts`, then installs only
the compatible Chromium headless shell into the bundle-owned browser directory.
It never changes a global package, browser, shell profile, or system browser
profile. Dependency and browser license files remain in the packaged tree.

`bundle.json` records the pins and a tree identity. `verify` checks that identity
plus the executable Node and MCP versions. Runtime artifacts are the only mutable
subtree and are excluded from the identity:

```sh
python3 scripts/browser_bundle.py verify /absolute/browser-bundle
```

When OMD mode is active, the managed Codex wrapper registers the exact launcher
with `default_tools_approval_mode="prompt"`. It uses an isolated in-memory
profile, the exact bundled executable, headless mode, Chromium's sandbox, a
60-second idle timeout, debug console capture, and a 20 MiB output limit. Output
defaults to the bundle's private `artifacts` directory; set
`OMD_BROWSER_ARTIFACTS_DIR` to an authorized directory when evidence must outlive
uninstall. Selecting retained upstream does not register the managed browser.

## Updates and removal

Updates build or unpack a replacement, verify it, atomically exchange it, and
restore the prior verified tree if post-swap verification fails:

```sh
python3 scripts/browser_bundle.py update /absolute/browser-bundle
python3 scripts/browser_bundle.py update /absolute/browser-bundle \
  --archive /absolute/new-browser.tar.xz --sha256 ARCHIVE_SHA256
python3 scripts/browser_bundle.py remove /absolute/browser-bundle
```

Removal fails closed if owned immutable files were changed. The private build
uninstaller removes the verified browser tree together with its managed prefix,
but does not touch shared Codex state or unrelated browsers.

## Security boundary

The launcher passes `--sandbox` and never passes `--no-sandbox`. Acceptance on
macOS observed Seatbelt clients for renderer and GPU children, but Chromium's
network utility reported `--service-sandbox-type=none`. Browser/MCP network and
remote effects are therefore not claimed to inherit the shell filesystem
sandbox. Codex's per-tool prompt is the authorization boundary, and origins,
downloads, credentials, and artifact destinations still require task-scoped
approval. This bundle does not provide arbitrary system-browser profiles,
logged-in sessions, extensions, or external services.
