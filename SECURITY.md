# Security Policy

## Reporting a vulnerability

Email **shayegh@me.com** with the details. Please do not open a public issue
for an unpatched vulnerability.

Include what you need to make the report actionable: affected version, what an
attacker can do, and a reproduction if you have one. You will get an
acknowledgement, and we will tell you whether we consider it in scope under the
threat model below.

## Supported versions

Fixes land on the latest published release of `@storybloq/lenses`. There are no
long-term support branches.

## Threat model

`@storybloq/lenses` runs as a **local, stdio-only MCP server**. It is launched
as a subprocess by an AI client on a developer's own machine and speaks
JSON-RPC over stdin and stdout. It opens no listening socket, binds no port,
and accepts no network connections. Its inputs are the code diffs and review
prompts the calling agent hands it.

This matters when reading an automated dependency scan. The package depends on
`@modelcontextprotocol/sdk`, which declares an HTTP transport stack (`express`,
`hono`, `cors`, `ajv`) so that consumers who want a remote transport have one.
We import `StdioServerTransport` only, so that code is never loaded. Advisories
whose attack requires an HTTP request reaching a listening server are therefore
not reachable through our usage.

Not reachable is not the same as not real. We still track and clear these
advisories, because a dependency that is unreachable today can become reachable
after a refactor, and because a clean audit is easier to reason about than a
list of remembered exceptions. If you believe one of them IS reachable through
a path we have missed, that is exactly the kind of report we want.

In scope:

- Reading or writing files outside the directory under review
- Executing arbitrary code from diff content, lens output, or MCP tool input
- Leaking source under review, credentials, or tokens to a third party
- Merger or verdict logic that can be steered by attacker-controlled diff
  content into suppressing a genuine blocking finding

Out of scope:

- Advisories in the SDK's HTTP transport stack, absent a demonstrated path from
  our stdio entry point
- Anything requiring an attacker who already has local code execution as the
  user, since that attacker already has everything the tool has
- Vulnerabilities in the AI client hosting the MCP server

## Disclosure

Tell us before you tell everyone else, and give us a reasonable window to ship
a fix. We will credit you in the release notes unless you would rather we did
not.
