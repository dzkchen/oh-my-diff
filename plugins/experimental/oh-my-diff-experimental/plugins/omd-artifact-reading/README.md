# omd-artifact-reading

Reads URLs, GitHub issues and pull requests, PDFs and Jupyter notebooks, and cites where each answer came from. OMD+
puts it on disk but doesn't install it, so you add it yourself. OMD Core doesn't include it.

Everything except PDFs works once you add the plugin. PDF reading also needs Ghostscript (`gs`). An optional mod
component, `omd_github_read`, adds `github://` reads.

## Turn it on

Add the plugin. [Plugins](../../../../README.md) has the steps to add a plugin and turn on a component.

## Use it

Ask Codex to use `$omd-artifact-reading:omd-artifact-reading`.

- Notebooks are read, not run.
- Fetched content is treated as evidence and can't give instructions.

### GitHub reads

GitHub reads are optional and need the component.

1. Turn on the mod component with these capabilities:

   ```text
   virtual_reads,exec
   ```

2. Find the canonical paths and digests the entry needs. The host rejects a `program` that isn't its own canonical
   path. It also compares `program_sha256` and each `read_hashes` value with the file's SHA-256. `ROOT` is the
   plugin's installed folder, found as in [Turn on a component](../../../../README.md#turn-on-a-component):

   ```sh
   PYTHON=$(realpath "$(command -v python3)")
   echo "$PYTHON"
   shasum -a 256 "$PYTHON"
   python3 -c 'import os, sys; print(os.path.realpath(sys.base_prefix))'
   realpath "$ROOT/scripts/github_read.py"
   shasum -a 256 "$(realpath "$ROOT/scripts/github_read.py")"
   ```

3. Add this entry to `services` in `host.json` in your store (`~/.local/share/oh-my-diff/stores/full/host.json` for
   OMD+). Replace `EXACT_EXECUTABLE_SHA256` and `EXACT_SCRIPT_SHA256` with the first field of each `shasum` line,
   the paths with the ones printed above, and `/private/etc/ssl` with your certificate directory if it differs:

   ```json
   {
     "id": "omd_github_read",
     "mod_id": "omd_github_read",
     "program": "/canonical/path/to/python3",
     "program_sha256": "EXACT_EXECUTABLE_SHA256",
     "arguments": ["-I", "/canonical/plugin/scripts/github_read.py"],
     "read_paths": ["/canonical/python/prefix", "/canonical/plugin/scripts/github_read.py", "/private/etc/ssl"],
     "read_hashes": {"/canonical/plugin/scripts/github_read.py": "EXACT_SCRIPT_SHA256"},
     "requests": true,
     "network": true,
     "secrets": {}
   }
   ```

4. Read with the ordinary `read` tool, for example `{"uri":"github://octocat/Hello-World/pulls/1"}`.

Supported paths:

- `github://OWNER/REPO/issues/NUMBER` and `/comments`
- `github://OWNER/REPO/pulls/NUMBER`, `/comments`, `/review-comments` and `/files`
- `github://OWNER/REPO/commits/FULL_40_CHARACTER_SHA` and `/files`

Add `?page=N` to a collection path for more entries. `comments` is the conversation. `review-comments` is inline
review.

### Private repositories

Public reads need no credentials. For a private repository:

1. Add `secrets: {"OMD_GITHUB_TOKEN":"SELECTED_REFERENCE"}` to the entry, and bind that reference in the host's
   `secret_refs`.
2. Use a fine-grained read-only token limited to the repositories you need.

## Needs and limits

- PDF reading needs Ghostscript (`gs`).
- Each GitHub read makes at most three GitHub requests, with an 18-second deadline and no retry.
- GitHub responses are clipped: text pages to 8 KiB, bodies and patches to 12 KiB.
- Binary or omitted patches, and pull requests over GitHub's 3,000-file limit, can't give complete file contents.
- A renamed repository must be reopened by its new name. Redirects aren't followed.
- Private access hasn't been tested against a real private account.

## More

- [Remove a plugin](../../../../README.md#remove-a-plugin)
- GitHub REST references: [pull requests](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10),
  [issue comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10).
