# Privacy

`omd_privacy` is installed inactive in OMD+ and can be installed explicitly in OMD Core. `omd-package mod enable omd_privacy` turns it on. It replaces secrets, and PII rules you select, in every provider-bound request with stable opaque placeholders such as `[REDACTED:github_token:q7xk2m9fhd4w]`. It also asks before a shell command reads a sensitive path.

## What it covers

The mod is a required policy on the host's final-request stage (`final_request_policy_v1`). It runs on the exact body each request sends, after every other request edit:

- lead, sub-agent and mod worker requests (`model.complete`, `model.fork`);
- the session's internal title, review, memory and guardian requests;
- every retry, compaction and route switch.

It scans this provider-bound text, grouped into the scopes you enable (`scopes`):

| Scope | Text |
| --- | --- |
| `prompt` | Your submitted prompts (`user.text` and untagged user messages) |
| `context` | Instructions, AGENTS.md, environment context, skill and hook context, developer and system text, tool specs, output schemas and policy text |
| `tools` | Tool-call arguments, freeform tool input and tool output, including errors |
| `replies` | Earlier assistant replies and readable reasoning that are sent back |

Text it can edit is redacted in place. When a page has more findings than the host's 256 edits allow, neighbouring redactions are merged into fewer edits of up to 4 KiB that produce the same text. Tool-call arguments stay valid JSON; when a redaction would break the JSON, the request is refused. Some text can only be denied, not edited: reasoning, tool specs, output schemas and host policy text. A finding there refuses the request and names the rule, the text kind and the placeholder, never the value.

Because the selection is trusted with `request_policy`, it fails closed while enabled. The host refuses every request (`request_policy_unavailable` or `final_request_refused`) when the mod is not loaded, has faulted, fails, times out, returns an invalid result or waits more than 5 s for a busy runtime. While the policy is on, the host also refuses realtime calls, image generation, web search and memory summarization (`request_policy_unsupported_transport`), because those cannot pass through the stage. To send again, disable the mod in `/mods` or `/omd`.

## Placeholders

Each placeholder is `[REDACTED:<rule>:<id>]`:

- `<id>` is 12 base32 characters of an HMAC-SHA256 over the thread, the rule and the value, keyed by a random 256-bit salt kept in the mod's state.
- The same value gets the same placeholder throughout a thread and across its retries, so references and prompt caching stay stable.
- Other threads, and internal requests that have no thread, get different placeholders for the same value.
- Placeholders cannot be reversed without the salt, and the provider never sees the salt.
- Each new id is checked against the fingerprints of the ids already issued (up to 1,000). A collision lengthens the id by 4 characters until it is unique.
- Placeholders are never turned back into values. When the model passes one to a tool, the tool receives the placeholder text.

The mod state holds only:

- the salt;
- each id's 64-bit SHA-256 fingerprint;
- per-rule counts;
- the number of refusals;
- the last decision.

It never holds a value. A fingerprint does not protect a low-entropy value, such as an IPv4 address, from someone who can read the local mod state. Anyone with that access can also read the transcript, which keeps the original text.

## Detectors

Secret rules are all on by default (`secrets`):

| Rule | Format |
| --- | --- |
| `private_key` | PEM and PGP `-----BEGIN … PRIVATE KEY-----` blocks through the matching END line; a block with no END line is redacted to the end of the text |
| `aws_access_key` | `AKIA`, `ASIA`, `ABIA` or `ACCA` followed by 16 uppercase letters or digits |
| `github_token` | `ghp_`, `gho_`, `ghu_`, `ghs_` and `ghr_` tokens; `github_pat_` tokens |
| `gitlab_token` | `glpat-` tokens |
| `slack_token` | `xox[abposr]-` tokens; `hooks.slack.com/services` webhook URLs |
| `stripe_key` | `sk_live_`, `sk_test_`, `rk_live_` and `rk_test_` keys |
| `ai_api_key` | `sk-`, `sk-ant-`, `sk-proj-`, `sk-svcacct-` and `sk-admin-` keys with letters and digits |
| `google_api_key` | `AIza` keys |
| `npm_token` | `npm_` tokens |
| `jwt` | Three-part `eyJ….eyJ….…` tokens |
| `bearer_token` | The credential after `Bearer` (16+ token characters with letters and digits that include an uppercase letter, are hex, or have a 16+ character run) or the base64 credential after `Basic` |
| `url_credentials` | The password in `scheme://user:password@host` |
| `assigned_secret` | The value assigned to a key that ends in password, passwd, secret, token, api key, access key, private key, secret key or credential(s), with `=`, `:`, `:=` or `=>` |

`assigned_secret` takes values of 6–256 characters. Quoted values may hold any character except their quote and a line break, including quotes escaped in JSON strings (`\"`); a quoted value with a space also needs a digit or symbol. Unquoted values need a digit or a symbol, and these values are skipped:

- references (`$VAR`, `${VAR}`, `process.env…`, `os.environ…`);
- member expressions and function calls;
- type names and other placeholder words (`string`, `required`, `changeme`, `example`, `your-…`).

PII rules are off by default; select them in `pii`:

| Rule | Format and exemptions |
| --- | --- |
| `email` | Any address, except under the reserved `example.com`, `example.net`, `example.org` domains and their subdomains, and the `.example`, `.test`, `.invalid` and `.localhost` names. These are exact domain suffixes: `admin@example.com.evil.io` is redacted, and so is `john@gmail.com`, whatever the local part. |
| `phone` | `+` international numbers with 7–15 digits; North American `(415) 867-5309` forms. The fictional `555-01xx` range is exempt. |
| `ipv4` | Public addresses. Private, loopback, link-local, carrier-grade NAT, documentation, benchmarking, multicast and reserved ranges are exempt. |
| `ipv6` | Full and compressed addresses (`2606:4700::1111`, `::ffff:8.8.8.8`), checked by a real parser. Loopback, unspecified, link-local, unique-local, multicast and `2001:db8::/32` are exempt; IPv4-mapped addresses follow the IPv4 rule. |
| `card` | 13–19 digits starting with 3–6 that pass the Luhn check. Well-known test numbers are exempt. |
| `us_ssn` | `NNN-NN-NNNN`, excluding the 000, 666 and 9xx areas and zero groups |

Lookalikes are left alone:

- AWS's documented example key, and any value containing `EXAMPLE`, `placeholder`, `changeme`, `dummy` or `xxxx`;
- tokens with fewer than 8 distinct characters;
- times such as `12:30:45`;
- MAC addresses;
- code such as `std::vector` or `ab::cd`.

A placeholder is never redacted again; the rest of a finding around one, such as the other lines of a key, still is.

### False positives and negatives

False positives: version-like strings that parse as public IPv4 addresses (`1.2.3.4`) with `ipv4` selected; kebab-case text after `sk-` that contains a digit; any 6+ character value assigned to a key ending in `token` or `password`, such as `deploy_token: "build-cache-42"`.

False negatives:

- secrets with no known prefix that are not assigned to a secret-like key;
- prefixed tokens glued to a preceding letter or digit (`xghp_…`);
- unquoted word-only credentials (`password=letmein`; the quoted form is caught) and quoted word-only phrases with spaces;
- values split by formatting, such as concatenation, `\u` escapes, base64 wrapping or line breaks in the middle of a token;
- secrets inside images, audio and files;
- values over the length bounds above.

## Split text

A segment longer than one 96 KiB page arrives in pieces of up to 80 KiB, each with up to 1 KiB of read-only context before and after. The mod scans each piece with its context and then edits only the piece:

- **Bounded tokens:** every rule except `private_key` and `jwt` matches at most 1 KiB, so a token across a boundary is seen whole from both sides. The piece where it starts gets the placeholder, and the next piece removes the rest.
- **Keys and long tokens:** a private key or a JWT longer than the context is handled from its visible end. The piece holding the start redacts through its end, and the next piece redacts from its start through the END line or the end of the token.

Stream deltas are not part of the guarantee. Completed replies return as whole segments in the next request, where they are scanned like any other text.

## Sensitive paths

The `approval` middleware sees every shell command, including auto-approved ones, input written to an interactive session and escalated `execve` calls. Input too large for the host to include in the approval is treated as a match. With the default `paths: ask`, a command that names a path matching `sensitive_paths` brings up the native approval prompt and names the matched pattern, so you review a read before its output can reach the model. `deny` refuses such commands and `off` disables the check. The detectors still apply to whatever output does reach the model.

Patterns:

- `*` matches within one path component;
- a pattern with a slash matches the end of a path;
- a trailing slash (`.ssh/`) matches the directory and anything below it.

The default patterns cover `.env` and `.env.*`, key and certificate files (`*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa*`, `id_ed25519*` and the other SSH key names), `.ssh/`, `.gnupg/`, `.aws/credentials`, `.docker/config.json`, `.kube/config`, `.netrc`, `.npmrc`, `.pypirc`, `.pgpass` and `.git-credentials`.

The check only reads command text. It does not catch paths built at runtime, reads by other tools or MCP servers, or files the model already knows.

## Exemptions and recovery

`exempt` holds reviewed entries:

- `sha256:<16–64 hex>`: a value fingerprint;
- `domain:<name>`: an email domain and its subdomains;
- `path:<pattern>`: a path pattern.

The defaults exempt `.env.example`, `.env.sample`, `.env.template` and `*.pub`.

To recover from a false alert, run `/privacy allow <placeholder-id>`, or `/privacy allow <value>`. Either writes the value's fingerprint to `exempt`, so no raw value is stored. Changing a setting invalidates the host's cached verdicts, so the next request sends the exempted value unredacted everywhere.

## Settings and commands

| Setting | Default |
| --- | --- |
| `secrets` | all secret rules |
| `pii` | `[]` |
| `scopes` | `prompt`, `context`, `tools`, `replies` |
| `paths` | `ask` (`ask`, `deny`, `off`) |
| `sensitive_paths` | the patterns above |
| `exempt` | the four path exemptions above |
| `unscanned` | `allow` (`allow`, `deny`) |

Images, audio and files are not scanned and fall outside the guarantee. With `unscanned: deny`, a request that carries them is refused; the host lists them before encrypted items, so none hide past its 256-item list. Encrypted reasoning and compaction always pass.

`/privacy` shows:

- the active rules, scopes, path mode and exemptions;
- the display policy;
- per-rule redaction counts, refusals and the last decision;
- the number of placeholders issued.

## Limits

- **Model-bound only:** redaction applies only to what is sent to the provider. The terminal display, the transcript, rollouts, resume data, logs and execution or accounting records all keep the originals. The host records only digests of replaced text.
- **Coverage:** the guarantee covers the supported text above. These are outside it:
  - images, OCR, audio and files;
  - encrypted reasoning;
  - provider-side tools;
  - other mods' own HTTP and sidecars;
  - processes the session already authorized to read or send data.
- **Detection:** the policy enforces only what its detectors find. It does not detect every secret.
- **Cost when inactive:** while the mod is disabled, no interceptor is registered and the host skips the final-request stage entirely. When enabled, a full 96 KiB page with every rule on scans in about 0.1 s offline.

## Credits

Behavior references, independently reimplemented over the OMD mod API with no code copied:

- [secret-redactor](https://github.com/ray-amjad/awesome-claude-code-function-hooks/tree/12b5fea27a4bd1b88cd9c9b6abc1efc0756c6625/plugins/secret-redactor) by ray-amjad (MIT, reviewed at `12b5fea`): local secret and path rules, scoped redaction with counts, allowlists and stable placeholders.
- [Honmoon](https://github.com/pleaseai/honmoon/tree/e722aca593fa8bd2262f8f6451d27e47cc1cd054/packages/claude-plugin) by pleaseai (Apache-2.0, reviewed at `e722aca`): optional PII, explicit scopes, session-salted placeholders and secret-free logs.

This mod replaces the references' collision-prone 32-bit placeholder hashes with salted HMAC ids that are checked for collisions. It parses compressed IPv6 addresses, which the references missed. Email exemptions use exact reserved domains instead of common local parts. Text it cannot scan is refused or reported, never treated as clean.
