# openclaw-attest

[Attest Protocol](https://github.com/attest-protocol) plugin for [OpenClaw](https://github.com/openclaw/openclaw). Generates cryptographically signed, hash-linked action receipts for every tool call the agent makes, creating a tamper-evident audit trail.

## What it does

Every time the OpenClaw agent executes a tool (reads a file, runs a command, navigates a browser, sends a message), this plugin:

1. **Classifies the action** using the Attest Protocol taxonomy
2. **Creates a W3C Verifiable Credential** receipt with Ed25519 signature
3. **Hash-links it** into a per-session chain (tamper-evident)
4. **Stores it** in a local SQLite database

The agent also gets two introspection tools to query and verify its own audit trail.

## Install

Copy or symlink this directory into your OpenClaw workspace plugins:

```bash
# From your OpenClaw workspace
cp -r path/to/openclaw-attest ~/.openclaw/plugins/openclaw-attest

# Or symlink for development
ln -s /path/to/openclaw-attest ~/.openclaw/plugins/openclaw-attest
```

Then enable the plugin in your OpenClaw config.

## Configuration

All settings are optional — the plugin works out of the box with sensible defaults.

| Setting | Default | Description |
|---------|---------|-------------|
| `enabled` | `true` | Generate receipts for tool calls |
| `dbPath` | `~/.openclaw/attest/receipts.db` | SQLite receipt database path |
| `keyPath` | `~/.openclaw/attest/keys.json` | Ed25519 signing key pair path |
| `taxonomyPath` | _(bundled)_ | Custom tool-to-action-type mapping |

## Agent tools

### `attest_query_receipts`

Search the audit trail by action type, risk level, or outcome status. Returns receipt summaries and aggregate statistics.

### `attest_verify_chain`

Cryptographically verify the integrity of a session's receipt chain. Checks Ed25519 signatures, hash links, and sequence numbering.

## Taxonomy

The plugin maps OpenClaw tool names to Attest Protocol action types:

| OpenClaw tool | Action type | Risk |
|---------------|-------------|------|
| `read_file` | `filesystem.file.read` | low |
| `write_file` | `filesystem.file.create` | low |
| `edit_file` | `filesystem.file.modify` | medium |
| `delete_file` | `filesystem.file.delete` | high |
| `run_command` | `system.command.execute` | high |
| `browser_navigate` | `system.browser.navigate` | low |
| `send_message` | `system.application.control` | medium |

See `taxonomy.json` for the full mapping. Override with a custom file via the `taxonomyPath` config option.

## How receipts work

Each receipt is a [W3C Verifiable Credential](https://www.w3.org/TR/vc-data-model-2.0/) containing:

- **Issuer**: The OpenClaw agent (`did:openclaw:<agentId>`)
- **Principal**: The session (`did:session:<sessionKey>`)
- **Action**: Classified type, risk level, target tool, hashed parameters
- **Outcome**: Success/failure status
- **Chain**: Sequence number + hash of previous receipt
- **Proof**: Ed25519Signature2020

Receipts are hash-linked into a chain per session. Verify integrity with `attest_verify_chain` or programmatically with `verifyStoredChain()` from `@attest-protocol/attest-ts`.

## Development

```bash
npm install
npx tsc     # type-check
```

## Dependencies

- [`@attest-protocol/attest-ts`](https://www.npmjs.com/package/@attest-protocol/attest-ts) — zero-dependency receipt SDK
- [`@sinclair/typebox`](https://www.npmjs.com/package/@sinclair/typebox) — tool parameter schemas (OpenClaw convention)

## License

MIT
