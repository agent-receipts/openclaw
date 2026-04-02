#!/usr/bin/env bash
#
# Smoke test: openclaw-agent-receipts plugin with a live OpenClaw instance
#
# Run this inside a `script` session to record everything:
#   script -q ~/repos/openclaw-agent-receipts/scripts/smoke-test-recording.txt bash scripts/smoke-test.sh
#
# Prerequisites:
#   - ANTHROPIC_API_KEY set in environment
#   - pnpm build already run
#
set -euo pipefail

if [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "ERROR: ANTHROPIC_API_KEY not set. Run: export ANTHROPIC_API_KEY=sk-ant-..."
  exit 1
fi

OPENCLAW="npx --yes openclaw"

echo "=== 1. Setting up isolated dev environment ==="
$OPENCLAW --dev onboard --non-interactive --accept-risk --skip-health \
  --auth-choice anthropic-api-key \
  --anthropic-api-key "$ANTHROPIC_API_KEY"

echo ""
echo "=== 2. Installing openclaw-agent-receipts plugin (linked) ==="
$OPENCLAW --dev plugins install . --link

echo ""
echo "=== 2b. Adding agent-receipts tools to tool policy allowlist ==="
# The "coding" tool profile does not include plugin tools by default.
# Tools must be added via tools.alsoAllow for the agent to see them.
OPENCLAW_JSON="$HOME/.openclaw-dev/openclaw.json"
if command -v node &>/dev/null; then
  node -e "
    const fs = require('fs');
    const cfg = JSON.parse(fs.readFileSync('$OPENCLAW_JSON', 'utf8'));
    cfg.tools = cfg.tools || {};
    const allow = new Set(cfg.tools.alsoAllow || []);
    allow.add('ar_query_receipts');
    allow.add('ar_verify_chain');
    cfg.tools.alsoAllow = [...allow];
    fs.writeFileSync('$OPENCLAW_JSON', JSON.stringify(cfg, null, 2) + '\n');
  "
  echo "Added agent-receipts tools to tools.alsoAllow"
else
  echo "WARNING: node not found — manually add agent-receipts tools to tools.alsoAllow in $OPENCLAW_JSON"
fi

echo ""
echo "=== 3. Verifying plugin is installed ==="
$OPENCLAW --dev plugins list

echo ""
echo "=== 3b. Clearing old sessions and receipts for clean run ==="
rm -rf ~/.openclaw-dev/agents/main/sessions/*
rm -f ~/.openclaw/agent-receipts/receipts.db

echo ""
echo "=== 4. Starting gateway in background ==="
$OPENCLAW --dev gateway --verbose --auth none &
GATEWAY_PID=$!
sleep 5  # give gateway time to start

echo ""
echo "=== 5. Triggering tool calls + querying receipts ==="
$OPENCLAW --dev agent --agent main --message "List the files in /tmp. Then use the ar_query_receipts tool to show me the audit trail, and finally use ar_verify_chain to verify the chain integrity."

echo ""
echo "=== 6. Shutting down gateway ==="
kill $GATEWAY_PID 2>/dev/null || true
wait $GATEWAY_PID 2>/dev/null || true

echo ""
echo "=== Done! Check ~/.openclaw/agent-receipts/ for receipts.db ==="
