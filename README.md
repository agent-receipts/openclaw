<div align="center">

# openclaw-agent-receipts

### Agent Receipts plugin for OpenClaw

[![npm](https://img.shields.io/npm/v/@agnt-rcpt/openclaw)](https://www.npmjs.com/package/@agnt-rcpt/openclaw)
[![License](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-ESM-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![CI](https://github.com/agent-receipts/openclaw/actions/workflows/ci.yml/badge.svg)](https://github.com/agent-receipts/openclaw/actions/workflows/ci.yml)

---

Cryptographically signed, hash-linked audit trail for every tool call an OpenClaw agent makes.

Built on [`@agnt-rcpt/sdk-ts`](https://github.com/agent-receipts/ar/tree/main/sdk/ts) and [`@sinclair/typebox`](https://github.com/sinclairzx81/typebox).

[Spec](https://github.com/agent-receipts/ar/tree/main/spec) &bull; [TypeScript SDK](https://github.com/agent-receipts/ar/tree/main/sdk/ts) &bull; [Python SDK](https://github.com/agent-receipts/ar/tree/main/sdk/py)

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

Every receipt is a signed [W3C Verifiable Credential](https://www.w3.org/TR/vc-data-model-2.0/) — parameters are hashed by default, and each receipt is hash-linked to the previous one, forming a tamper-evident chain.

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

Today, receipts are stored locally in SQLite — fully under your control. The [Agent Receipts protocol](https://github.com/agent-receipts/ar/tree/main/spec) is designed for receipts to travel further when you choose: publishing to a shared ledger, forwarding to a compliance system, or exchanging with other agents as proof of prior actions. The receipts are portable W3C Verifiable Credentials, but where they go is always your decision.

## How it works

Every time the OpenClaw agent executes a tool, this plugin:

1. **Classifies the action** using the [Agent Receipts taxonomy](https://github.com/agent-receipts/ar/tree/main/spec/taxonomy)
2. **Forwards an unsigned frame** to the local [agent-receipts daemon](https://github.com/agent-receipts/ar/blob/main/daemon/README.md) over AF_UNIX
3. The daemon **signs, hash-links, and stores** the receipt in its SQLite database

The agent also gets two introspection tools to query and verify its own audit trail.

```
OpenClaw Gateway
  │
  ├─ before_tool_call ──► classify → forward "pending" frame to daemon
  │
  ├─ [tool executes]
  │
  └─ after_tool_call ──► forward "allowed" frame to daemon
                              │
                         daemon: sign → chain → store
```

> **The daemon is required.** Frames are forwarded fire-and-forget — if the socket is unreachable, a startup warning is logged and delivery drops silently until the daemon is reachable. No receipts are recorded while the daemon is absent. See [Daemon setup](#daemon-setup) below.

## Install

```bash
openclaw plugins install @agnt-rcpt/openclaw
```

Then enable the plugin in your OpenClaw config. See [`docs/INSTALL.md`](docs/INSTALL.md) for tool visibility setup and configuration options.

## CLI — Receipt Explorer

Query and verify receipts outside of agent sessions, useful for auditing and debugging.

| Subcommand | Description |
|:-----------|:------------|
| `receipts` | List and query receipts (returns a collection) |
| `verify`   | Verify chain integrity (signatures + hash links) |
| `export`   | Export receipts as JSON-LD W3C Verifiable Credentials |

```bash
# List all receipts
npx @agnt-rcpt/openclaw receipts

# Filter by risk level
npx @agnt-rcpt/openclaw receipts --risk high

# Filter by action type and output as JSON
npx @agnt-rcpt/openclaw receipts --action system.command.execute --json

# `receipts` always returns a collection — use `export --id` to fetch a single receipt by ID
npx @agnt-rcpt/openclaw export --id urn:receipt:abc-123

# Filter receipts --json output with jq (fields: id, action, risk, target, status, sequence, chain_id, timestamp)
npx @agnt-rcpt/openclaw receipts --json \
  | jq '.receipts[] | select(.risk == "high" and .action == "system.command.execute")'

# Verify all chains
npx @agnt-rcpt/openclaw verify

# Verify a specific chain
npx @agnt-rcpt/openclaw verify --chain chain_openclaw_main_sid-42

# Export a chain as JSON-LD (full W3C Verifiable Credentials)
npx @agnt-rcpt/openclaw export --chain chain_openclaw_main_sid-42

# Export as a W3C Verifiable Presentation envelope
npx @agnt-rcpt/openclaw export --chain chain_openclaw_main_sid-42 --format presentation
```

> **Note:** Parameter disclosure is now controlled by the daemon's `--parameter-disclosure` flag, not by plugin config. To inspect `parameters_disclosure` values on receipts that were recorded with disclosure enabled, export the full receipt with `export --id` or `export --chain`.

Run `npx @agnt-rcpt/openclaw --help` for all options including `--status`, `--limit`, and `--db`.

## Agent tools

### `ar_query_receipts`

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

### `ar_verify_chain`

Cryptographically verify the integrity of the daemon's receipt chain. Checks Ed25519 signatures, hash links, and sequence numbering.

```
> Verify the audit trail

Chain "chain_openclaw_main_sid-42" is valid: 12 receipts, all signatures and hash links verified.
```

## What's in a receipt?

Each receipt is a W3C Verifiable Credential signed with Ed25519, recording:

| Field | What it captures |
|:---|:---|
| **Issuer** | The agent-receipts daemon's identity (set by the daemon at signing time) |
| **Principal** | Which session authorized it (`did:session:<sessionKey>`) |
| **Action** | What happened — classified type, risk level, target tool |
| **Outcome** | Success/failure status and error details |
| **Chain** | Sequence number + SHA-256 hash link to previous receipt |
| **Privacy** | Parameters are hashed by default; opt in via `parameterDisclosure` to include selected fields in plaintext |
| **Proof** | Ed25519Signature2020 with verification method |

## Taxonomy

The plugin maps OpenClaw tool names to Agent Receipts action types:

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

All settings are optional — the plugin works out of the box with sensible defaults, assuming the daemon is installed at its default paths.

| Setting | Default | Description |
|:---|:---|:---|
| `enabled` | `true` | Forward tool calls to the daemon |
| `daemonDbPath` | _(platform default)_ | Path to the daemon's SQLite receipt database (overrides `AGENTRECEIPTS_DB`) |
| `daemonPublicKeyPath` | _(platform default)_ | Path to the daemon's Ed25519 public key PEM file, used by `ar_verify_chain`. Defaults to `${AGENTRECEIPTS_KEY}.pub` when `AGENTRECEIPTS_KEY` is set, otherwise `~/.local/share/agent-receipts/signing.key.pub`. |
| `taxonomyPath` | _(bundled)_ | Custom tool-to-action-type mapping |

Default paths follow the daemon's own resolution: `AGENTRECEIPTS_DB` env var → `$XDG_DATA_HOME/agent-receipts/receipts.db` → `~/.local/share/agent-receipts/receipts.db`.

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-agent-receipts": {
        "config": {
          "enabled": true,
          // "taxonomyPath": "/path/to/custom-taxonomy.json",  // optional
          // "daemonDbPath": "/custom/path/receipts.db",       // optional; defaults to daemon's path
          // "daemonPublicKeyPath": "/custom/signing.key.pub"  // optional; defaults to daemon's path
        }
      }
    }
  }
}
```

> **Parameter disclosure** is now controlled by the daemon's `--parameter-disclosure` flag, not by this plugin. The `parameterDisclosure` plugin config is accepted for backwards compatibility but is ignored — setting it emits a startup warning.

## Daemon setup

The [agent-receipts daemon](https://obsigna.dev/getting-started/daemon-setup/) must be installed and running locally. Frames are forwarded fire-and-forget — if the socket is unreachable at startup, a warning is logged. Per-frame delivery failures drop silently; no receipts are recorded while the daemon is absent.

**macOS (Homebrew — recommended):**

```sh
brew install agent-receipts/tap/agent-receipts-daemon
brew services start agent-receipts-daemon
```

**Linux (one-command install):**

```sh
curl -fsSL https://github.com/agent-receipts/ar/releases/latest/download/install.sh | sh
sudo loginctl enable-linger $USER   # one-time root step; log out and back in after
```

**Linux — openclaw gateway running as a system service** (`User=openclaw` in the unit file):

`XDG_RUNTIME_DIR` is not set automatically for system services, so the plugin may resolve the wrong socket path. Add it via a drop-in override:

```sh
sudo systemctl edit openclaw
```

```ini
[Service]
Environment=XDG_RUNTIME_DIR=/run/user/1001   # replace 1001 with: id -u openclaw
```

Restart the gateway after saving.

Full daemon documentation is at [obsigna.dev/getting-started/daemon-setup/](https://obsigna.dev/getting-started/daemon-setup/).

## Upgrading from ≤ 0.8.0 (Flavor A → Flavor B)

Starting with the next release, the plugin **requires** the daemon. It no longer holds keys, chain state, or a local SQLite store. If you were on Flavor A (in-process receipts):

**1. Install and start the daemon** (if you haven't already) — see [Daemon setup](#daemon-setup) above.

**2. Old receipts are not migrated.** Receipts recorded by Flavor A live at `~/.openclaw/agent-receipts/receipts.db`. No automatic import tooling exists — ADR-0010 specifies a clean break: the daemon starts a fresh chain at sequence 1. Keep the old database offline if you need to verify historical chains.

**3. Issuer DID changes.** Historical Flavor A chains were issued under `did:openclaw:<agentId>`. New chains are issued by the daemon using its own identity. Verifiers of historical chains will see a different issuer from that point forward — this is expected and documented.

**4. Config keys.** The `dbPath`, `keyPath`, and `daemonForwarding` config fields are now deprecated and ignored. If your daemon uses non-default paths, set `daemonDbPath` and `daemonPublicKeyPath` instead.

## Project structure

```
src/
  index.ts           # Plugin entry — wires hooks, tools, service
  cli.ts             # Receipt Explorer CLI (npx @agnt-rcpt/openclaw)
  hooks.ts           # before_tool_call / after_tool_call → classify + forward to daemon
  classify.ts        # Tool name → action type + risk level classification
  daemon-store.ts    # Read-only access to the daemon's SQLite receipt database
  tools.ts           # ar_query_receipts + ar_verify_chain
  config.ts          # Config resolution + daemon path defaults
taxonomy.json        # Default OpenClaw tool → action type mappings
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
| **Runtime deps** | `@agnt-rcpt/sdk-ts` + `@sinclair/typebox` |

## Ecosystem

| Repository | Description |
|:---|:---|
| [agentreceipts.ai](https://agentreceipts.ai) | Protocol site — specification and reference |
| [obsigna.dev](https://obsigna.dev) | Tooling docs — SDKs, MCP proxy, hook, dashboard, and the OpenClaw plugin |
| [agent-receipts/spec](https://github.com/agent-receipts/ar/tree/main/spec) | Protocol specification, JSON Schemas, canonical taxonomy |
| [agent-receipts/sdk-ts](https://github.com/agent-receipts/ar/tree/main/sdk/ts) | TypeScript SDK |
| [agent-receipts/sdk-py](https://github.com/agent-receipts/ar/tree/main/sdk/py) | Python SDK ([PyPI](https://pypi.org/project/agent-receipts/)) |
| **agent-receipts/openclaw** (this plugin) | OpenClaw integration |
| [agent-receipts/ar/mcp-proxy](https://github.com/agent-receipts/ar/tree/main/mcp-proxy) | MCP proxy + CLI |

## License

Apache License 2.0 — see [LICENSE](LICENSE).
