# ChatGPT Computer Plugin

This repository is a thin MCP transport adapter for CPTR. **Official ChatGPT plans and calls the tools.** CPTR supplies authenticated workspace authorization, durable operation lifecycle persistence, approval enforcement, bounded results, and execution policy. The default tool path uses CPTR `/api/control/v2` and does not invoke CPTR's agent loop, select a CPTR model, call `/v1/models`, call `/v1/chat/completions`, or require an OpenAI API key.

## Setup

```bash
npm install
cp .env.example .env
npm run typecheck
npm test
npm run build
npm run dev
```

Set `CPTR_BASE_URL` to the CPTR origin and `CPTR_API_TOKEN` to a dedicated scoped CPTR bearer token. The plugin is a transport adapter, not an authorization authority; CPTR verifies the token and workspace access for every call. The MCP endpoint is `http://${HOST}:${PORT}/mcp` and health is `/health`.

| Required capability | CPTR scope |
|---|---|
| Bounded workspace inspection | `direct:inspect` |
| Versioned file write and exact edit | `direct:mutate` |
| Named action, code block, or SSH-action request | `direct:execute` |
| Approval or rejection of a waiting direct operation | `direct:approve` |

Default CPTR keys intentionally exclude all `direct:*` scopes. Provision the narrowest dedicated connector key necessary for the integration.

## Default MCP tools

The default MCP surface exposes workspace discovery, bounded file inspection, versioned file writes and edits, a named workspace action request, a durable code-block request, a durable SSH profile-action request, operation state/events, cancellation, direct-operation approval, and Git diff inspection.

Every side effect returns a durable `operation_id`. File mutations require the revision returned from a preceding read. Code blocks and SSH actions create `WAITING_APPROVAL`; a caller must separately approve the exact operation before it can queue. Operation events are bounded and use opaque `next_cursor` values, which callers must pass back unchanged.

> **No default tool accepts `model_id`, an arbitrary local command, or a free-form remote SSH command.** The plugin does not advertise the retired v1 raw-command interface.

## Sandboxed code blocks and SSH profile actions

`cptr_run_code_block` accepts only Python, JavaScript, TypeScript, or Bash source and runs only after approval through CPTR's isolated code runner. CPTR never substitutes host shell execution if the configured runner is unavailable.

`cptr_run_ssh_operation` accepts `ssh_profile` and `ssh_action`. The profile and its allowed remote action mapping are operator-managed in CPTR; the MCP caller cannot provide hostnames, key paths, known-hosts files, credentials, or raw remote shell text. SSH operations are always approval-gated.

## Explicit legacy fallback

The old CPTR task and autonomous workflows remain available as an explicit compatibility fallback, but are **not advertised by default**. Set the plugin environment variable below only when an operator intentionally wants these separately named tools:

```bash
CPTR_LEGACY_FALLBACK_ENABLED=true
```

This enables `cptr_legacy_*` tools, where `model_id` is retained only because those tools call the pre-existing CPTR agent or autonomous-monitor APIs. It does not restore legacy v1 direct write, edit, or raw host-shell command endpoints.

## Security boundary

The connector token is read from environment configuration and is never returned in tool results or normalized errors. CPTR confines direct operations to authorized workspaces, rejects absolute/traversal and sensitive paths, requires revision checks for mutation, enforces durable idempotency and workspace leases, bounds output, and records stable error codes. Tool annotations are advisory; CPTR authorization and policy are authoritative.

A deployment should expose the connector only behind its appropriate authentication and network boundary. A live official ChatGPT connector session remains the final deployment acceptance test for platform-side tool permissions, credential scope provisioning, approval UX, and the host's sandbox availability.
