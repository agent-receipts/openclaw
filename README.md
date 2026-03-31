<div align="center">

# openclaw-attest

### Attest Protocol plugin for OpenClaw

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![CI](https://github.com/attest-protocol/openclaw-attest/actions/workflows/ci.yml/badge.svg)](https://github.com/attest-protocol/openclaw-attest/actions/workflows/ci.yml)

---

Cryptographically signed, hash-linked audit trail for every tool call an OpenClaw agent makes.

Built on [`@attest-protocol/attest-ts`](https://github.com/attest-protocol/attest-ts) and [`@sinclair/typebox`](https://github.com/sinclairzx81/typebox).

[Spec](https://github.com/attest-protocol/spec) &bull; [TypeScript SDK](https://github.com/attest-protocol/attest-ts) &bull; [Python SDK](https://github.com/attest-protocol/attest-py)

</div>

---

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

Copy or symlink into your OpenClaw workspace plugins:

```bash
# Copy
cp -r /path/to/openclaw-attest ~/.openclaw/plugins/openclaw-attest

# Or symlink for development
ln -s /path/to/openclaw-attest ~/.openclaw/plugins/openclaw-attest
```

Then enable the plugin in your OpenClaw config.

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
