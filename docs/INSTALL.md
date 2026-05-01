# Installing openclaw-agent-receipts

## Quick start

```bash
# Install the plugin
openclaw plugins install @agnt-rcpt/openclaw

# Or link a local clone for development
openclaw plugins install /path/to/openclaw-agent-receipts --link
```

## Tool visibility

OpenClaw's tool policy pipeline filters which tools the agent can use.
The default `"coding"` profile does not include plugin tools, so after
installing you must allowlist the two agent-receipts tools in your `openclaw.json`:

```jsonc
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["ar_query_receipts", "ar_verify_chain"]
  }
}
```

Without this, the plugin will still load (hooks fire, receipts are
generated), but the agent will not see the query/verify tools.

Alternatively, switch to the `"full"` profile to allow all registered tools:

```jsonc
{
  "tools": {
    "profile": "full"
  }
}
```

Or allowlist the entire plugin by ID:

```jsonc
{
  "tools": {
    "alsoAllow": ["openclaw-agent-receipts"]
  }
}
```

## Configuration (optional)

All config is optional with sensible defaults:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-agent-receipts": {
        "enabled": true,
        "config": {
          "enabled": true,
          "dbPath": "~/.openclaw/agent-receipts/receipts.db",
          "keyPath": "~/.openclaw/agent-receipts/keys.json",
          // "taxonomyPath": "/path/to/custom-taxonomy.json",  // optional — overrides bundled taxonomy
          "parameterDisclosure": false    // false | true | "high" | string[]
        }
      }
    }
  }
}
```

## Parameter disclosure

By default, action parameters are hashed but not stored in plaintext. Enable `parameterDisclosure` to selectively disclose specific fields per action type — useful for auditing high-risk commands without exposing sensitive data on lower-risk calls.

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-agent-receipts": {
        "config": {
          "parameterDisclosure": "high"
        }
      }
    }
  }
}
```

Options:

| Value | Behavior |
|-------|----------|
| `false` | Hashes only — no plaintext (default) |
| `true` | Disclosure enabled for all action types |
| `"high"` | Disclosure enabled for `high` and `critical` risk actions only |
| `["system.command.execute"]` | Disclosure enabled for specific action types |

With `"high"` enabled, a `system.command.execute` receipt includes:

```jsonc
{
  // ...other receipt fields
  "parameters_hash": "sha256:9c84a8c9...",
  "parameters_disclosure": {
    "command": "echo \"Testing agent-receipts plugin fix\""
  }
}
```

The hash always covers the full original parameters regardless of disclosure config. Only the **first** matching field from the taxonomy's `disclosure_fields` list is included in `parameters_disclosure`, and non-string values are JSON-stringified. Disclosed values are signed and durable — do not list fields that may contain secrets.

## Verifying

**After `openclaw plugins install`** the gateway must be restarted before the plugin is active.
`openclaw.json` changes (tool policy, plugin config) are hot-reloaded and do not require a restart.

Restart the gateway with the appropriate command for your setup:

```bash
# systemd (most Linux installs)
systemctl restart openclaw-gateway
```

For other setups, stop and restart the gateway process however it was launched.

> **Note:** There is no `openclaw restart` command.

Confirm the plugin loaded:

```bash
openclaw plugins list
```

You should see `Agent Receipts` with status `loaded`. Then ask the agent
to use `ar_query_receipts` or `ar_verify_chain` to confirm the
tools are visible.
