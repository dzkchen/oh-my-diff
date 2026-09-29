# GitHub virtual reading

The optional API `0.2.0-experimental.4` component extends this existing artifact plugin. Its TypeScript registers `github://`; the plugin's Python helper owns URI grammar, GitHub REST requests, pagination, revisions and source projection. The runtime only dispatches the ordinary `read` tool and enforces an exact helper grant. Local files remain separate resources. Nothing implements GitHub behavior in Rust.

Supported paths:

- `github://OWNER/REPO/issues/NUMBER` and `/comments`
- `github://OWNER/REPO/pulls/NUMBER`, `/comments`, `/review-comments`, and `/files`
- `github://OWNER/REPO/commits/FULL_LOWERCASE_40_CHARACTER_SHA` and `/files`

Collection paths accept `?page=N`; each remote page contains ten entries. `comments` means the conversation, while `review-comments` means inline PR review comments. An issue path pointing to a PR is rejected as ambiguous. Commit names and short SHAs are rejected. Renamed repositories require reopening their new canonical identity; redirects are never followed.

Install the guidance plugin normally, then inspect its separately trusted component with `omd-mod plugin-component PLUGIN_ROOT`, inspect/trust/enable the returned component with capabilities `virtual_reads,exec`, and select the same external mod store as the host. Installation does not enable it. The external store's `host.json` needs an explicit entry in `services`:

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

Use actual canonical paths, digests and the platform's certificate directory. Public reads use no credentials. For explicitly authorized private repositories, add `secrets: {"OMD_GITHUB_TOKEN":"SELECTED_REFERENCE"}` and bind that reference through the host's external `secret_refs` map. Use a fine-grained read-only token limited to the intended repositories and required Issues/Pull requests/Contents permissions. The helper never searches ambient `gh`, Git or browser credentials. Private access has not been tested against a real private account.

Call the ordinary tool with `{"uri":"github://octocat/Hello-World/pulls/1"}`. Results retain canonical URL, resource identity, PR head SHA or pinned commit, SHA-256 revision, anchors and untrusted provenance. Concatenate `text` pages using the returned `cursor` and `expected_revision`; their JSON document includes `next_uri` for the next remote page. Reopening a byte cursor refetches and hashes the same resource, rejecting drift. Each remote page is its own snapshot; compare PR head SHAs across file pages. A deleted or inaccessible resource fails without falling back to another account.

Each request makes at most three fixed-origin GETs, with an 18-second network deadline and no automatic retry. GitHub 403/429 responses stop and disclose available retry/reset values. Raw responses are limited to 2 MiB; projected snapshots to 256 KiB; text pages to 8 KiB. Bodies and patches are clipped to 12 KiB with their original digest and truncation flag. Binary/omitted patches and GitHub's 3,000-file PR limit cannot establish complete file contents. Untrusted filenames are labels, never local paths to open or write. Follow source links only when the user's task calls for them.

Historical API 0.1 acceptance used public `octocat/Hello-World` resources, pinned Codex 0.157.0, Python 3.14 and Node 24.18.0 on Apple Silicon macOS. Native ordinary-read dispatch and grant denial passed then; current API 0.2 offline fixtures cover the generic sidecar call and refusal, while live GitHub parity remains unqualified. No paid model or private credentials were used. REST contract: [pull requests](https://docs.github.com/en/rest/pulls/pulls?apiVersion=2026-03-10), [issue comments](https://docs.github.com/en/rest/issues/comments?apiVersion=2026-03-10). API version `2026-03-10` is explicit.
