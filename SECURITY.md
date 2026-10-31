# Security

How to report a security problem in OMD, which versions get fixes and what's in scope.

## Report a vulnerability

Use [GitHub's private reporting form](https://github.com/dzkchen/oh-my-diff/security/advisories/new). Don't open a
public issue.

Include:

- your OMD version (`omd update status`)
- steps to reproduce
- what an attacker could do

Fixes ship as a patch release, with a public advisory once you can update.

## Response times and supported versions

OMD is a one-person project, so replies to reports are best effort, with no promised response time.
[Support](docs/support.md#fixes-and-security-support) says which releases get security fixes.

## What's in scope

- The installer and updates.
- Sandbox, approval and permission checks in the patched Codex.
- How mods are loaded, trusted and limited, and the authority broker.
- The mods and plugins that ship with OMD.

Where else to report:

- Upstream Codex problems go to [OpenAI](https://github.com/openai/codex/security).
- Someone else's mod goes to its author. Report a malicious mod here too, so it can be blocked.

## What isn't a vulnerability

A mod you allow outside the sandbox can do what your user account can, by design. What mods can do and how grants
work is in [Trust and permissions](docs/trust-and-permissions.md).
