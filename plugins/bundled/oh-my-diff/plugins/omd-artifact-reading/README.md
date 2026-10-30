# omd-artifact-reading

Reads URLs, GitHub issues and pull requests, PDFs and Jupyter notebooks, and cites where each answer came from.

It works with no setup once you add the plugin. An optional mod component, `omd_github_read`, adds `github://`
reads.

## Turn it on

Add the plugin. [Plugins](../../../../README.md) has the steps to add a plugin and enable a component.

## Use it

Ask Codex to use `$omd-artifact-reading:omd-artifact-reading`.

- Notebooks are read, not run.
- Fetched content is treated as evidence and can't give instructions.

### GitHub reads

GitHub reads are optional and need the component.

1. Enable the component with these capabilities:

   ```text
   virtual_reads,exec
   ```

2. Add this entry to `services` in the store's `host.json`. Use real canonical paths, digests and your platform's
   certificate directory:

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

3. Read with the ordinary `read` tool, for example `{"uri":"github://octocat/Hello-World/pulls/1"}`.

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
