# omd_privacy

Pattern-based text redaction. It replaces text that matches its secret rules, and personal data you choose, with
placeholders such as `[REDACTED:github_token:q7xk2m9fhd4w]` in the text of requests sent to the model. It can
also ask before a shell command reads a sensitive file when you set `paths` to `ask`. It's off by default in OMD+. OMD
Core doesn't include it.

It does not cover:

- Web search, which sends your recent messages and its queries unscanned.
- Your screen, transcript, resume data and logs, which keep the original secrets.
- Images, audio and files, unless `unscanned` is `deny`.
- Provider-side tools, other mods' network calls and processes you already allowed.
- Secrets its rules don't match, such as ones with no known prefix, split or encoded values and unquoted word-only
  passwords.

[Needs and limits](#needs-and-limits) has the details.

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

Value exemptions are unavailable. A secret keeps the same placeholder in every request, so the cached prompt prefix
doesn't change. The ID is an HMAC of the value under a random salt kept in the mod's state, so the provider can't
guess a value from it.

It also refuses a model call to `apply_patch`, a shell command or `write_stdin` whose arguments contain a placeholder:
the model can't see the value, so the call would write `[REDACTED:…]` into your files. The refusal names `omd_privacy`
and the file.

## Settings

Change settings in `/mods`.

| Setting | Default | What it does |
| --- | --- | --- |
| `secrets` | all 13 secret rules | Secret rules to apply (list below) |
| `pii` | `[]` | Personal data rules: `email`, `phone`, `ipv4`, `ipv6`, `card`, `us_ssn` |
| `scopes` | `prompt`, `context`, `tools`, `replies` | Text to scan: your prompts, instructions and context, tool calls and output, earlier replies |
| `paths` | `off` | When a shell command names a sensitive path: `ask`, `deny` or `off`. Secrets in its output are redacted either way |
| `sensitive_paths` | 21 patterns (list below) | Path patterns that count as sensitive |
| `exempt` | `path:.env.example`, `path:.env.sample`, `path:.env.template`, `path:*.pub` | Domains and paths exempted from checks: `domain:NAME` or `path:PATTERN` |
| `unscanned` | `allow` | `deny` refuses requests that carry images, audio or files, which are never scanned |

The `secrets` rules: `private_key`, `aws_access_key`, `github_token`, `gitlab_token`, `slack_token`, `stripe_key`,
`ai_api_key`, `google_api_key`, `npm_token`, `jwt`, `bearer_token`, `url_credentials`, `assigned_secret`.

The default `sensitive_paths`: `.env`, `.env.*`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_dsa*`,
`id_ecdsa*`, `id_ed25519*`, `.ssh/`, `.gnupg/`, `.aws/credentials`, `.docker/config.json`, `.kube/config`,
`.config/gh/hosts.yml`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass`, `.git-credentials`.

## Needs and limits

- It protects only what is sent to the provider. Your screen, transcript, resume data and logs keep the originals.
- Placeholders are never turned back. A tool the model passes one to is refused when it is `apply_patch`, a shell
  command or `write_stdin`, and gets the placeholder text otherwise.
- It skips clearly local or sample values: documentation samples (the jwt.io example token and Stripe's
  public `sk_test_4eC39…` docs key), URL credentials for `localhost`, `127.*`, `0.0.0.0` or an exempt domain, and
  assigned values whose name has a `test`, `fake`, `mock`, `dummy`, `sample`, `demo`, `csrf` or `xsrf` word (such as
  `TEST_PASSWORD`) or that start with one of those words. UUIDs and other real-looking values are still redacted.
- It finds only what its rules match. It can miss secrets with no known prefix, split or encoded values and unquoted
  word-only passwords. Passwords passed as command flags, such as `curl -u user:pass` or `mysql -pPASS`, and quoted
  passphrases with spaces aren't matched. Values that are file paths, such as `GOOGLE_APPLICATION_CREDENTIALS=/path/key.json`,
  are kept so the model can use the path. It can also redact harmless text, such as `1.2.3.4` with `ipv4` on.
- Images, audio and files aren't scanned unless `unscanned` is `deny`. Provider-side tools, other mods' network calls
  and processes you already allowed are out of reach.
- The path check reads command text only. It misses paths built at run time. Globs and brace lists that could name a
  sensitive path ask first. The catch-all patterns `*` and `.*` are the exception, so neither `ls -la .*` nor `cat .*`
  asks. In inline interpreter code (`python -c`, `node -e`) and in heredoc bodies fed to an interpreter, `cat >` or
  `tee` only quoted strings count, so `open('.env')` asks and `config.key` doesn't. A heredoc piped or fed to a shell
  or `ssh`, and code or an unquoted heredoc holding a `$(…)` or backtick substitution, is checked like any command. Input to a running session that is too large to check is treated as naming
  a sensitive path.
- Web search isn't scanned. It sends your recent messages and its queries as they are.
- While the mod is on, Realtime calls are refused (`request_policy_unsupported_transport`).
- If the mod fails or times out, every other request is refused, but web search still goes out unscanned. To send
  again, turn the mod off in `/mods`.
- Saved state contains aggregate counts, status and the salt, never values, fingerprints or placeholder mappings.

## More

- [Included mods](../../../docs/collection.md)
- Credit: behavior based on
  [secret-redactor](https://github.com/ray-amjad/awesome-claude-code-function-hooks/tree/12b5fea27a4bd1b88cd9c9b6abc1efc0756c6625/plugins/secret-redactor)
  by ray-amjad (MIT) and
  [Honmoon](https://github.com/pleaseai/honmoon/tree/e722aca593fa8bd2262f8f6451d27e47cc1cd054/packages/claude-plugin)
  by pleaseai (Apache-2.0); reimplemented, no code copied.
