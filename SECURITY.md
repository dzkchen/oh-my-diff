# Security

## Report a vulnerability

Report it privately with [GitHub's private reporting form](https://github.com/dzkchen/oh-my-diff/security/advisories/new).
Please don't open a public issue.

Include:

- your OMD version (`omd update status`),
- steps to reproduce,
- what an attacker could do.

The maintainer aims to reply within a week. Fixes ship as a patch release, followed by a public advisory once you
can update.

## Supported versions

Only the latest release gets security fixes. Run `omd update` to get it.

## What's in scope

- The installer and updates.
- Sandbox, approval and permission checks in the patched Codex.
- How mods are loaded, trusted and limited, and the authority broker.
- The mods and plugins that ship with OMD.

Report problems in upstream Codex to [OpenAI](https://github.com/openai/codex/security). Problems in someone
else's mod go to its author, but do tell us about a malicious mod so it can be blocked.

## What isn't a vulnerability

A mod you allow to run outside the sandbox can do anything your user account can. That's by design: only turn on
mods you trust.
