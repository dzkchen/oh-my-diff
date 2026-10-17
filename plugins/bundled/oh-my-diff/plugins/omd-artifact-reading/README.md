# OMD artifact reading

Read URLs, GitHub issues and pull requests, PDFs and Jupyter notebooks, and cite where each answer came from.

It works with no setup. An optional `mod/` component adds `github://` reads; you trust and enable it separately.

## Install

```sh
omd-package plugins
codex plugin add omd-artifact-reading@oh-my-diff
```

## Use

Ask Codex to use `$omd-artifact-reading:omd-artifact-reading`.

- PDF reading needs Ghostscript (`gs`).
- Notebooks are read, not run.
- Fetched content is treated as evidence and can't give instructions.

## GitHub reads (optional)

1. Inspect, trust and enable the component in the mod store of the host you run:

   ```sh
   omd-mod plugin-component PLUGIN_ROOT
   omd-mod inspect COMPONENT_PATH
   omd-mod trust STORE COMPONENT_PATH INSPECT_SHA256 virtual_reads,exec
   omd-mod enable STORE COMPONENT_PATH
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

Add `?page=N` to a collection path for more entries. `comments` is the conversation; `review-comments` is inline
review.

### Private repositories

Public reads need no credentials. For a private repository:

1. Add `secrets: {"OMD_GITHUB_TOKEN":"SELECTED_REFERENCE"}` to the entry, and bind that reference in the host's
   `secret_refs`.
2. Use a fine-grained read-only token limited to the repositories you need.

Private access hasn't been tested against a real private account.

### Limits

- Each request makes at most three GitHub requests, with an 18-second deadline and no retry.
- Responses are clipped: text pages to 8 KiB, bodies and patches to 12 KiB.
- Binary or omitted patches, and PRs over GitHub's 3,000-file limit, can't give complete file contents.
- A renamed repository must be reopened by its new name. Redirects aren't followed.

## Remove

```sh
omd-mod disable STORE COMPONENT_PATH
codex plugin remove omd-artifact-reading@oh-my-diff
```

GitHub REST references: [pull requests](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10), [issue comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10).
