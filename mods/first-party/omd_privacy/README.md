# omd_privacy

Replaces secrets, and personal data you choose, in everything sent to the model with stable placeholders such as `[REDACTED:github_token:q7xk2m9fhd4w]`, and asks before a shell command reads a sensitive file.

## Turn it on

It comes with OMD+ but starts off. Turn it on in `/mods`, or run:

```sh
omd-package mod enable omd_privacy
```

## Use it

| Command | What it does |
| --- | --- |
| `/privacy` or `/privacy status` | Show the active rules, scopes, path mode, exemptions, redaction counts and refusals. |
| `/privacy allow ID` | Stop redacting the value behind placeholder `ID` (the part after the second colon). |
| `/privacy allow VALUE` | Stop redacting that value. Only its fingerprint is saved to `exempt`. |

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `secrets` | all 13 secret rules | Secret rules to apply: `private_key`, `aws_access_key`, `github_token`, `gitlab_token`, `slack_token`, `stripe_key`, `ai_api_key`, `google_api_key`, `npm_token`, `jwt`, `bearer_token`, `url_credentials`, `assigned_secret`. |
| `pii` | `[]` | Personal data rules to apply: `email`, `phone`, `ipv4`, `ipv6`, `card`, `us_ssn`. |
| `scopes` | `prompt`, `context`, `tools`, `replies` | Which text to scan: your prompts, instructions and context, tool calls and output, earlier replies. |
| `paths` | `ask` | When a shell command names a sensitive path: `ask` for approval, `deny`, or `off`. |
| `sensitive_paths` | `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `.ssh/`, `.aws/credentials`, `.npmrc` and similar | Path patterns that count as sensitive. |
| `exempt` | `path:.env.example`, `path:.env.sample`, `path:.env.template`, `path:*.pub` | Reviewed exemptions: `sha256:HEX`, `domain:NAME` or `path:PATTERN`. |
| `unscanned` | `allow` | `deny` refuses a request that carries images, audio or files, which are never scanned. |

## Needs and limits

- A placeholder is the same for the same value throughout a thread. It is never turned back: a tool the model passes one to receives the placeholder text.
- It protects only what is sent to the provider. Your screen, transcript, resume data and logs keep the originals.
- It finds only what its rules match. It can miss secrets with no known prefix, split or encoded values, and unquoted word-only passwords. It can also redact harmless text, such as `1.2.3.4` with `ipv4` on.
- Images, audio and files are not scanned unless `unscanned` is `deny`. Provider-side tools, other mods' own network calls and processes you already allowed are outside it.
- The path check reads command text only. It misses paths built at run time and reads by other tools.
- While it is on, a request is refused if the mod fails or times out. Realtime calls, image generation, web search and memory summarization are refused too. Turn the mod off in `/mods` to send again.
- The mod's saved state holds a salt and short fingerprints, never values. A fingerprint does not hide a guessable value, such as an IP address, from someone who can read it.

Credit: behavior based on [secret-redactor](https://github.com/ray-amjad/awesome-claude-code-function-hooks/tree/12b5fea27a4bd1b88cd9c9b6abc1efc0756c6625/plugins/secret-redactor) by ray-amjad (MIT) and [Honmoon](https://github.com/pleaseai/honmoon/tree/e722aca593fa8bd2262f8f6451d27e47cc1cd054/packages/claude-plugin) by pleaseai (Apache-2.0); reimplemented, no code copied.
