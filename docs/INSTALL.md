# Installing openclaw-attest

## Quick start

```bash
# Install the plugin
openclaw plugins install @agnt-rcpt/openclaw

# Or link a local clone for development
openclaw plugins install /path/to/openclaw-attest --link
```

## Tool visibility

OpenClaw's tool policy pipeline filters which tools the agent can use.
The default `"coding"` profile does not include plugin tools, so after
installing you must allowlist the two attest tools in your `openclaw.json`:

```jsonc
{
  "tools": {
    "profile": "coding",
    "alsoAllow": ["attest_query_receipts", "attest_verify_chain"]
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
    "alsoAllow": ["openclaw-attest"]
  }
}
```

## Configuration (optional)

All config is optional with sensible defaults:

```jsonc
{
  "plugins": {
    "entries": {
      "openclaw-attest": {
        "enabled": true,
        "config": {
          "enabled": true,
          "dbPath": "~/.openclaw/attest/receipts.db",
          "keyPath": "~/.openclaw/attest/keys.json",
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
to use `attest_query_receipts` or `attest_verify_chain` to confirm the
tools are visible.
