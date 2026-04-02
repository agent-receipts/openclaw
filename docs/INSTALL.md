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

Alternatively, you can use `"profile": "full"` to allow all registered
tools, or allowlist the entire plugin by ID:

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
          "taxonomyPath": null  // custom taxonomy mapping
        }
      }
    }
  }
}
```

## Verifying

After setup, restart the gateway and confirm the plugin loaded:

```bash
openclaw plugins list
```

You should see `Agent Receipts` with status `loaded`. Then ask the agent
to use `ar_query_receipts` or `ar_verify_chain` to confirm the
tools are visible.
