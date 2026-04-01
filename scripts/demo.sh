#!/usr/bin/env bash
#
# Demo: generate a nice screenshot-worthy output from openclaw-attest
#
# Prerequisites:
#   - Plugin installed and alsoAllow configured (run smoke-test.sh first)
#   - ANTHROPIC_API_KEY set
#   - Gateway NOT already running (this script starts its own)
#
set -euo pipefail

OPENCLAW="npx --yes openclaw"

echo "=== Clearing old sessions + receipts ==="
rm -rf ~/.openclaw-dev/agents/main/sessions/*
rm -f ~/.openclaw/attest/receipts.db

echo ""
echo "=== Starting gateway ==="
$OPENCLAW --dev gateway --verbose --auth none &
GATEWAY_PID=$!
sleep 5

echo ""
echo "=== Step 1: Generate some tool traffic ==="
$OPENCLAW --dev agent --agent main --message \
  "Do these three things quietly and briefly: 1) List files in /tmp 2) Read the file /etc/hostname 3) Write 'hello attest' to /tmp/attest-demo/greeting.txt"

echo ""
echo "=== Step 2: Query the audit trail ==="
$OPENCLAW --dev agent --agent main --message \
  "Use attest_query_receipts to show the full audit trail, then use attest_verify_chain to verify chain integrity."

echo ""
echo "=== Shutting down ==="
kill $GATEWAY_PID 2>/dev/null || true
wait $GATEWAY_PID 2>/dev/null || true

echo "=== Done! ==="
