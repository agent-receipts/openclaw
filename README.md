<div align="center">

# openclaw-attest

### Attest Protocol plugin for OpenClaw

[![npm](https://img.shields.io/npm/v/@attest-protocol/openclaw-attest)](https://www.npmjs.com/package/@attest-protocol/openclaw-attest)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![CI](https://github.com/attest-protocol/openclaw-attest/actions/workflows/ci.yml/badge.svg)](https://github.com/attest-protocol/openclaw-attest/actions/workflows/ci.yml)

---

Cryptographically signed, hash-linked audit trail for every tool call an OpenClaw agent makes.

Built on [`@attest-protocol/attest-ts`](https://github.com/attest-protocol/attest-ts) and [`@sinclair/typebox`](https://github.com/sinclairzx81/typebox).

[Spec](https://github.com/attest-protocol/spec) &bull; [TypeScript SDK](https://github.com/attest-protocol/attest-ts) &bull; [Python SDK](https://github.com/attest-protocol/attest-py)

</div>

---

## What it looks like

After a session where the agent reads files, runs a command, browses a page, and writes output, querying the audit trail returns:

```json
{
  "total_receipts": 5,
  "total_chains": 1,
  "by_risk": { "low": 4, "high": 1 },
  "by_status": { "success": 4, "failure": 1 },
  "by_action": {
    "filesystem.file.read": 2,
    "filesystem.file.create": 1,
    "system.command.execute": 1,
    "system.browser.navigate": 1
  },
  "results": [
    { "id": "rec-…01", "timestamp": "2026-04-01T02:10:01Z", "action": "filesystem.file.read",    "risk": "low",  "target": "read_file",        "status": "success", "sequence": 1 },
    { "id": "rec-…02", "timestamp": "2026-04-01T02:10:02Z", "action": "filesystem.file.read",    "risk": "low",  "target": "read_file",        "status": "failure", "sequence": 2 },
    { "id": "rec-…03", "timestamp": "2026-04-01T02:10:03Z", "action": "system.command.execute",  "risk": "high", "target": "run_command",      "status": "success", "sequence": 3 },
    { "id": "rec-…04", "timestamp": "2026-04-01T02:10:04Z", "action": "system.browser.navigate", "risk": "low",  "target": "browser_navigate", "status": "success", "sequence": 4 },
    { "id": "rec-…05", "timestamp": "2026-04-01T02:10:05Z", "action": "filesystem.file.create",  "risk": "low",  "target": "write_file",       "status": "success", "sequence": 5 }
  ]
}
```

Verifying the chain confirms nothing was tampered with:

```
Chain "chain_openclaw_main_sid-42" is valid: 5 receipts, all signatures and hash links verified.
```

Every receipt is a signed [W3C Verifiable Credential](https://www.w3.org/TR/vc-data-model-2.0/) — parameters are hashed (never stored in plaintext), and each receipt is hash-linked to the previous one, forming a tamper-evident chain.

---

## Why receipts?

AI agents that read files, run commands, and browse the web are powerful — but that power needs accountability. When an agent operates autonomously, you need to know exactly what it did, prove that the record hasn't been tampered with, and keep sensitive details private.

**Use cases:**

- **Post-incident review** — your agent ran overnight and something broke. The receipt chain shows exactly which commands it ran, in what order, and whether each succeeded or failed — with cryptographic proof that the log hasn't been altered after the fact.
- **Compliance and audit** — regulated environments require evidence of what systems did and why. Receipts are W3C Verifiable Credentials with Ed25519 signatures, giving auditors a tamper-evident trail they can independently verify.
- **Safer autonomous agents** — the agent can query its own audit trail mid-session. Before taking a high-risk action, it can check what it has already done and whether previous steps succeeded, enabling self-correcting workflows.
- **Multi-agent trust** — when agents collaborate, receipts serve as proof of prior actions. Agent B can verify that Agent A actually completed step 1 before proceeding to step 2, without trusting a shared log.
- **Cost and usage tracking** — every tool call is classified by type and risk level, giving you a structured breakdown of what your agent spent its time on across sessions.

### Beyond local storage

Today, receipts are stored locally in SQLite — fully under your control. The [Attest Protocol](https://github.com/attest-protocol/spec) is designed for receipts to travel further when you choose: publishing to a shared ledger, forwarding to a compliance system, or exchanging with other agents as proof of prior actions. The receipts are portable W3C Verifiable Credentials, but where they go is always your decision.

## How it works

Every time the OpenClaw agent executes a tool, this plugin:

1. **Classifies the action** using the [Attest Protocol taxonomy](https://github.com/attest-protocol/spec/tree/main/spec/taxonomy)
2. **Creates a signed receipt** — a [W3C Verifiable Credential](https://www.w3.org/TR/vc-data-model-2.0/) with Ed25519 proof
3. **Hash-links it** into a per-session chain (tamper-evident)
4. **Stores it** in a local SQLite database

The agent also gets two introspection tools to query and verify its own audit trail.

```
OpenClaw Gateway
  │
  ├─ before_tool_call ──► capture params + timing
  │
  ├─ [tool executes]
  │
  └─ after_tool_call ──► classify → sign → chain → store
```

## Install

```bash
openclaw plugins install @attest-protocol/openclaw-attest
```

Then enable the plugin in your OpenClaw config. See [`docs/INSTALL.md`](docs/INSTALL.md) for tool visibility setup and configuration options.

## CLI — Receipt Explorer

Query and verify receipts outside of agent sessions, useful for auditing and debugging.

```bash
# Query all receipts
npx @attest-protocol/openclaw-attest receipts

# Filter by risk level
npx @attest-protocol/openclaw-attest receipts --risk high

# Filter by action type and output as JSON
npx @attest-protocol/openclaw-attest receipts --action system.command.execute --json

# Verify all chains
npx @attest-protocol/openclaw-attest verify

# Verify a specific chain
npx @attest-protocol/openclaw-attest verify --chain chain_openclaw_main_sid-42

# Export a chain as JSON-LD (full W3C Verifiable Credentials)
npx @attest-protocol/openclaw-attest export --chain chain_openclaw_main_sid-42

# Export as a W3C Verifiable Presentation envelope
npx @attest-protocol/openclaw-attest export --chain chain_openclaw_main_sid-42 --format presentation

# Export a single receipt by ID
npx @attest-protocol/openclaw-attest export --id urn:receipt:abc-123
```

Run `npx @attest-protocol/openclaw-attest --help` for all options including `--status`, `--limit`, and `--db`.

## Agent tools

### `attest_query_receipts`

Search the audit trail by action type, risk level, or outcome status. Returns receipt summaries and aggregate statistics.

```
> Query all high-risk actions from this session

{
  "total_receipts": 12,
  "results": [
    { "action": "filesystem.file.delete", "risk": "high", "target": "delete_file", "status": "success", "sequence": 7 },
    { "action": "system.command.execute", "risk": "high", "target": "run_command", "status": "success", "sequence": 3 }
  ]
}
```

### `attest_verify_chain`

Cryptographically verify the integrity of the receipt chain. Checks Ed25519 signatures, hash links, and sequence numbering.

```
> Verify the audit trail for this session

Chain "chain_openclaw_main_sid-42" is valid: 12 receipts, all signatures and hash links verified.
```

## What's in a receipt?

Each receipt is a W3C Verifiable Credential signed with Ed25519, recording:

| Field | What it captures |
|:---|:---|
| **Issuer** | Which agent performed the action (`did:openclaw:<agentId>`) |
| **Principal** | Which session authorized it (`did:session:<sessionKey>`) |
| **Action** | What happened — classified type, risk level, target tool |
| **Outcome** | Success/failure status and error details |
| **Chain** | Sequence number + SHA-256 hash link to previous receipt |
| **Privacy** | Parameters are hashed, never stored in plaintext |
| **Proof** | Ed25519Signature2020 with verification method |

## Taxonomy

The plugin maps OpenClaw tool names to Attest Protocol action types:

| OpenClaw tool | Action type | Risk |
|:---|:---|:---|
| `read_file` | `filesystem.file.read` | low |
| `write_file` | `filesystem.file.create` | low |
| `edit_file` | `filesystem.file.modify` | medium |
| `delete_file` | `filesystem.file.delete` | high |
| `run_command` | `system.command.execute` | high |
| `browser_navigate` | `system.browser.navigate` | low |
| `browser_click` | `system.browser.form_submit` | medium |
| `send_message` | `system.application.control` | medium |

See [`taxonomy.json`](taxonomy.json) for the full 20-tool mapping. Override with a custom file via the `taxonomyPath` config option.

## Configuration

All settings are optional — the plugin works out of the box with sensible defaults.

| Setting | Default | Description |
|:---|:---|:---|
| `enabled` | `true` | Generate receipts for tool calls |
| `dbPath` | `~/.openclaw/attest/receipts.db` | SQLite receipt database path |
| `keyPath` | `~/.openclaw/attest/keys.json` | Ed25519 signing key pair path |
| `taxonomyPath` | _(bundled)_ | Custom tool-to-action-type mapping |

Ed25519 signing keys are generated automatically on first run and persisted to `keyPath`.

## Project structure

```
src/
  index.ts          # Plugin entry — wires hooks, tools, service
  cli.ts            # Receipt Explorer CLI (npx @attest-protocol/openclaw-attest)
  hooks.ts          # before_tool_call / after_tool_call → receipt creation
  classify.ts       # Tool name → action type + risk level classification
  chain.ts          # Per-session hash-linked chain state
  tools.ts          # attest_query_receipts + attest_verify_chain
  config.ts         # Config resolution + Ed25519 key management
taxonomy.json       # Default OpenClaw tool → action type mappings
```

## Development

```sh
pnpm install
pnpm test              # run the test suite
pnpm run typecheck     # TypeScript strict mode
pnpm test:coverage     # with V8 coverage
```

| | |
|:---|:---|
| **Language** | TypeScript ESM, strict mode |
| **Testing** | Vitest (colocated `*.test.ts` files) |
| **Runtime deps** | `@attest-protocol/attest-ts` + `@sinclair/typebox` |

## Ecosystem

| Repository | Description |
|:---|:---|
| [attest-protocol/spec](https://github.com/attest-protocol/spec) | Protocol specification, JSON Schemas, canonical taxonomy |
| [attest-protocol/attest-ts](https://github.com/attest-protocol/attest-ts) | TypeScript SDK |
| [attest-protocol/attest-py](https://github.com/attest-protocol/attest-py) | Python SDK ([PyPI](https://pypi.org/project/attest-protocol/)) |
| **attest-protocol/openclaw-attest** (this plugin) | OpenClaw integration |
| [ojongerius/attest](https://github.com/ojongerius/attest) | MCP proxy + CLI (reference implementation) |

## License

MIT
