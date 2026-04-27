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
          "taxonomyPath": null,           // custom taxonomy mapping
          "parameterPreview": false       // false | true | "high" | string[]
        }
      }
    }
  }
}
```

## Parameter preview

By default, action parameters are hashed but not stored in plaintext. Enable `parameterPreview` to selectively disclose specific fields per action type — useful for auditing high-risk commands without exposing sensitive data on lower-risk calls.

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-agent-receipts": {
        "config": {
          "parameterPreview": "high"
        }
      }
    }
  }
}
```

Options:

| Value | Behaviour |
|-------|-----------|
| `false` | Hashes only — no plaintext (default) |
| `true` | Preview enabled for all action types |
| `"high"` | Preview enabled for `high` and `critical` risk actions only |
| `["system.command.execute"]` | Preview enabled for specific action types |

With `"high"` enabled, a `system.command.execute` receipt includes:

```json
"parameters_hash": "sha256:9c84a8c9...",
"parameters_preview": {
  "command": "echo \"Testing agent-receipts plugin fix\""
}
```

The hash always covers the full original parameters regardless of preview config. The preview is additive and opt-in — fields disclosed are defined per action type in the taxonomy.

## Verifying

After setup, restart the gateway and confirm the plugin loaded:

```bash
openclaw plugins list
```

You should see `Agent Receipts` with status `loaded`. Then ask the agent
to use `ar_query_receipts` or `ar_verify_chain` to confirm the
tools are visible.
