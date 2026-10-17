# Security

How to report a security problem in OMD.

## Report a vulnerability

Use [GitHub's private reporting form](https://github.com/dzkchen/oh-my-diff/security/advisories/new). Please don't
open a public issue.

Include:

- your OMD version (`omd update status`)
- steps to reproduce
- what an attacker could do

OMD is a one-person project, so replies are best effort. Fixes ship as a patch release, with a public advisory once you
can update.

## Supported versions

Only the latest release gets security fixes. Run `omd update` to get it.

## What's in scope

- The installer and updates.
- Sandbox, approval and permission checks in the patched Codex.
- How mods are loaded, trusted and limited, and the authority broker.
- The mods and plugins that ship with OMD.

Where else to report:

- Upstream Codex problems go to [OpenAI](https://github.com/openai/codex/security).
- Someone else's mod goes to its author. Do tell us about a malicious mod so it can be blocked.

## What isn't a vulnerability

A mod you allow to run outside the sandbox can do anything your user account can. That's by design, so only turn
on mods you trust.
