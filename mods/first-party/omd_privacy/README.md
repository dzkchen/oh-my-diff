# omd_privacy

Replaces secrets, and personal data you choose, with stable placeholders such as
`[REDACTED:github_token:q7xk2m9fhd4w]` in everything sent to the model, and asks before a shell command reads a
sensitive file. It's off by default in OMD+. OMD Core doesn't include it.

## Turn it on

Turn it on in `/mods`, or run:

```sh
omd mods enable omd_privacy
```

[Manage mods](../../../docs/manage-mods.md) covers the other ways to turn a mod on or off.

## Use it

| Command | What it does |
| --- | --- |
| `/privacy` or `/privacy status` | Show active rules, scopes, path mode, exemptions, redaction counts and refusals |
| `/privacy allow ID` | Stop redacting the value behind placeholder `ID` (the part after the second colon) |
| `/privacy allow VALUE` | Stop redacting that value, exactly as typed after `allow` (inner spaces and tabs count) |

`/privacy allow VALUE` saves only the value's fingerprint to `exempt`.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `secrets` | all 13 secret rules | Secret rules to apply (list below) |
| `pii` | `[]` | Personal data rules: `email`, `phone`, `ipv4`, `ipv6`, `card`, `us_ssn` |
| `scopes` | `prompt`, `context`, `tools`, `replies` | Text to scan: your prompts, instructions and context, tool calls and output, earlier replies |
| `paths` | `ask` | When a shell command names a sensitive path: `ask`, `deny` or `off` |
| `sensitive_paths` | 21 patterns (list below) | Path patterns that count as sensitive |
| `exempt` | `path:.env.example`, `path:.env.sample`, `path:.env.template`, `path:*.pub` | Values and paths that are never redacted: `sha256:HEX` (a value's fingerprint, as `/privacy allow` saves it), `domain:NAME` or `path:PATTERN` |
| `unscanned` | `allow` | `deny` refuses requests that carry images, audio or files, which are never scanned |

The `secrets` rules: `private_key`, `aws_access_key`, `github_token`, `gitlab_token`, `slack_token`, `stripe_key`,
`ai_api_key`, `google_api_key`, `npm_token`, `jwt`, `bearer_token`, `url_credentials`, `assigned_secret`.

The default `sensitive_paths`: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_dsa*`,
`id_ecdsa*`, `id_ed25519*`, `.ssh/`, `.gnupg/`, `.aws/credentials`, `.docker/config.json`, `.kube/config`,
`.config/gh/hosts.yml`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials`.

## Needs and limits

- It protects only what is sent to the provider. Your screen, transcript, resume data and logs keep the originals.
- Placeholders are never turned back. A tool the model passes one to gets the placeholder text.
- It finds only what its rules match. It can miss secrets with no known prefix, split or encoded values and unquoted
  word-only passwords. It can also redact harmless text, such as `1.2.3.4` with `ipv4` on.
- Images, audio and files aren't scanned unless `unscanned` is `deny`. Provider-side tools, other mods' network calls
  and processes you already allowed are out of reach.
- The path check reads command text only. It misses paths built at run time. Globs and brace lists that could name a
  sensitive path ask first. The catch-all patterns `*` and `.*` are the exception, so neither `ls -la .*` nor `cat .*`
  asks.
- Web search isn't scanned. It sends your recent messages and its queries as they are.
- While the mod is on, Realtime calls are refused (`request_policy_unsupported_transport`).
- If the mod fails or times out, every other request is refused, but web search still goes out unscanned. To send
  again, turn the mod off in `/mods`.
- Saved state contains a salt and short fingerprints, never values. A fingerprint doesn't hide a guessable value, such
  as an IP address.

## More

- [Included mods](../../../docs/collection.md)
- Credit: behavior based on
  [secret-redactor](https://github.com/ray-amjad/awesome-claude-code-function-hooks/tree/12b5fea27a4bd1b88cd9c9b6abc1efc0756c6625/plugins/secret-redactor)
  by ray-amjad (MIT) and
  [Honmoon](https://github.com/pleaseai/honmoon/tree/e722aca593fa8bd2262f8f6451d27e47cc1cd054/packages/claude-plugin)
  by pleaseai (Apache-2.0); reimplemented, no code copied.
