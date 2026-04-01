#!/usr/bin/env node

/**
 * Receipt Explorer CLI for openclaw-attest.
 *
 * Query and verify the SQLite receipt database outside of the agent.
 * Useful for auditing and debugging.
 *
 * Usage:
 *   openclaw-attest receipts [--risk <level>] [--action <type>] [--status <status>] [--limit <n>] [--db <path>] [--json]
 *   openclaw-attest verify [--chain <id>] [--db <path>] [--json]
 *   openclaw-attest --help
 *   openclaw-attest --version
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { readFileSync } from "node:fs";
import { openStore, verifyStoredChain } from "@attest-protocol/attest-ts";
import type { ActionReceipt, RiskLevel, OutcomeStatus, ReceiptStore, StoreStats } from "@attest-protocol/attest-ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RiskFilter = RiskLevel;
type StatusFilter = OutcomeStatus;

interface ReceiptsOptions {
  risk?: RiskFilter;
  action?: string;
  status?: StatusFilter;
  limit: number;
  db: string;
  json: boolean;
}

interface VerifyOptions {
  chain?: string;
  db: string;
  json: boolean;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const VALID_RISK_LEVELS = new Set<string>(["low", "medium", "high", "critical"]);
const VALID_STATUSES = new Set<string>(["success", "failure", "pending"]);

const DEFAULT_DB_PATH = "~/.openclaw/attest/receipts.db";
const DEFAULT_LIMIT = 20;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) {
      throw new Error(
        "Cannot expand ~/ path: HOME environment variable is not set. " +
        "Use an absolute path with --db instead.",
      );
    }
    return resolve(home, p.slice(2));
  }
  return p;
}

function loadVersion(): string {
  try {
    // Walk up from src/cli.ts (or dist/src/cli.js) to find package.json
    const url = new URL("../../package.json", import.meta.url);
    const raw = readFileSync(url, "utf-8");
    const pkg = JSON.parse(raw) as { version: string };
    return pkg.version;
  } catch {
    return "unknown";
  }
}

// ---------------------------------------------------------------------------
// Help text
// ---------------------------------------------------------------------------

export function helpText(): string {
  return `openclaw-attest — Receipt Explorer CLI

Usage:
  openclaw-attest receipts [options]   Query receipts from the audit trail
  openclaw-attest verify  [options]    Verify chain integrity
  openclaw-attest --help               Show this help
  openclaw-attest --version            Show version

receipts options:
  --risk <level>     Filter by risk level (low, medium, high, critical)
  --action <type>    Filter by action type (e.g. filesystem.file.read)
  --status <status>  Filter by outcome (success, failure, pending)
  --limit <n>        Max results (default: 20)
  --db <path>        Override database path (default: ~/.openclaw/attest/receipts.db)
  --json             Output as JSON

verify options:
  --chain <id>       Chain ID to verify (verifies all chains if omitted)
  --db <path>        Override database path
  --json             Output as JSON`;
}

// ---------------------------------------------------------------------------
// Table formatting
// ---------------------------------------------------------------------------

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + "\u2026";
}

function padRight(s: string, width: number): string {
  return s + " ".repeat(Math.max(0, width - s.length));
}

function padLeft(s: string, width: number): string {
  return " ".repeat(Math.max(0, width - s.length)) + s;
}

export function formatReceiptsTable(
  receipts: ActionReceipt[],
  stats: StoreStats,
): string {
  const lines: string[] = [];

  // Stats summary
  lines.push(`Total receipts: ${stats.total}  |  Chains: ${stats.chains}`);

  if (stats.byRisk.length > 0) {
    const riskParts = stats.byRisk.map((r) => `${r.risk_level}: ${r.count}`);
    lines.push(`Risk: ${riskParts.join(", ")}`);
  }

  if (stats.byStatus.length > 0) {
    const statusParts = stats.byStatus.map((s) => `${s.status}: ${s.count}`);
    lines.push(`Status: ${statusParts.join(", ")}`);
  }

  lines.push("");

  if (receipts.length === 0) {
    lines.push("No receipts found.");
    return lines.join("\n");
  }

  // Table header
  const cols = {
    seq: 5,
    action: 30,
    risk: 8,
    status: 8,
    target: 20,
    timestamp: 20,
  };

  const header =
    padLeft("#", cols.seq) + "  " +
    padRight("ACTION", cols.action) + "  " +
    padRight("RISK", cols.risk) + "  " +
    padRight("STATUS", cols.status) + "  " +
    padRight("TARGET", cols.target) + "  " +
    padRight("TIMESTAMP", cols.timestamp);

  lines.push(header);
  lines.push("-".repeat(header.length));

  for (const r of receipts) {
    const sub = r.credentialSubject;
    const line =
      padLeft(String(sub.chain.sequence), cols.seq) + "  " +
      padRight(truncate(sub.action.type, cols.action), cols.action) + "  " +
      padRight(sub.action.risk_level, cols.risk) + "  " +
      padRight(sub.outcome.status, cols.status) + "  " +
      padRight(truncate(sub.action.target?.resource ?? "-", cols.target), cols.target) + "  " +
      padRight(sub.action.timestamp, cols.timestamp);
    lines.push(line);
  }

  lines.push("");
  lines.push(`Showing ${receipts.length} of ${stats.total} receipts.`);

  return lines.join("\n");
}

export function formatVerifyResult(
  chainId: string,
  verification: { valid: boolean; length: number; brokenAt: number; receipts: Array<{ index: number; receiptId: string; signatureValid: boolean; hashLinkValid: boolean; sequenceValid: boolean }> },
): string {
  const lines: string[] = [];

  if (verification.valid) {
    lines.push(`Chain "${chainId}": VALID (${verification.length} receipts)`);
    lines.push("All signatures and hash links verified.");
  } else {
    lines.push(`Chain "${chainId}": BROKEN at position ${verification.brokenAt}`);
    lines.push("Tamper detected! The following receipts have issues:");
    lines.push("");

    for (const r of verification.receipts) {
      if (!r.signatureValid || !r.hashLinkValid || !r.sequenceValid) {
        const issues: string[] = [];
        if (!r.signatureValid) issues.push("signature");
        if (!r.hashLinkValid) issues.push("hash link");
        if (!r.sequenceValid) issues.push("sequence");
        lines.push(`  [${r.index}] ${r.receiptId}: invalid ${issues.join(", ")}`);
      }
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function runReceipts(opts: ReceiptsOptions): void {
  const dbPath = expandHome(opts.db);
  let store: ReceiptStore | undefined;

  try {
    store = openStore(dbPath);

    const results = store.query({
      riskLevel: opts.risk,
      actionType: opts.action,
      status: opts.status,
      limit: opts.limit,
    });

    const stats = store.stats();

    if (opts.json) {
      const output = {
        stats: {
          total: stats.total,
          chains: stats.chains,
          byRisk: stats.byRisk,
          byStatus: stats.byStatus,
          byAction: stats.byAction,
        },
        receipts: results.map((r) => ({
          id: r.id,
          action: r.credentialSubject.action.type,
          risk: r.credentialSubject.action.risk_level,
          target: r.credentialSubject.action.target?.resource ?? null,
          status: r.credentialSubject.outcome.status,
          sequence: r.credentialSubject.chain.sequence,
          chain_id: r.credentialSubject.chain.chain_id,
          timestamp: r.credentialSubject.action.timestamp,
        })),
      };
      process.stdout.write(JSON.stringify(output, null, 2) + "\n");
    } else {
      process.stdout.write(formatReceiptsTable(results, stats) + "\n");
    }
  } finally {
    store?.close();
  }
}

function runVerify(opts: VerifyOptions): void {
  const dbPath = expandHome(opts.db);
  let store: ReceiptStore | undefined;

  try {
    store = openStore(dbPath);

    if (opts.chain) {
      // Load the public key from the standard keys.json location
      const publicKey = loadPublicKey(dbPath);
      const result = verifyStoredChain(store, opts.chain, publicKey);

      if (opts.json) {
        process.stdout.write(JSON.stringify({
          chain_id: opts.chain,
          valid: result.valid,
          length: result.length,
          broken_at: result.brokenAt,
          receipts: result.receipts.map((r) => ({
            index: r.index,
            receipt_id: r.receiptId,
            signature_valid: r.signatureValid,
            hash_link_valid: r.hashLinkValid,
            sequence_valid: r.sequenceValid,
          })),
        }, null, 2) + "\n");
      } else {
        process.stdout.write(formatVerifyResult(opts.chain, result) + "\n");
      }
    } else {
      // Verify all chains: get stats to find chain IDs, then verify each
      const publicKey = loadPublicKey(dbPath);
      const stats = store.stats();

      if (stats.total === 0) {
        if (opts.json) {
          process.stdout.write(JSON.stringify({ chains: [] }, null, 2) + "\n");
        } else {
          process.stdout.write("No receipts found in the database.\n");
        }
        return;
      }

      // Query all receipts to discover chain IDs
      const allReceipts = store.query({ limit: 100_000 });
      const chainIds = [...new Set(allReceipts.map((r) => r.credentialSubject.chain.chain_id))];

      const results = chainIds.map((chainId) => {
        const v = verifyStoredChain(store!, chainId, publicKey);
        return {
          chain_id: chainId,
          valid: v.valid,
          length: v.length,
          broken_at: v.brokenAt,
        };
      });

      if (opts.json) {
        process.stdout.write(JSON.stringify({ chains: results }, null, 2) + "\n");
      } else {
        for (const r of results) {
          const status = r.valid ? "VALID" : `BROKEN at ${r.broken_at}`;
          process.stdout.write(`${r.chain_id}: ${status} (${r.length} receipts)\n`);
        }
      }
    }
  } finally {
    store?.close();
  }
}

/**
 * Attempt to load the public key from the keys.json file next to the DB.
 * Falls back to empty string if not found (signature checks will fail
 * but hash-link and sequence checks still work).
 */
function loadPublicKey(dbPath: string): string {
  try {
    // Default keys location is sibling to DB
    const keysPath = resolve(dbPath, "..", "keys.json");
    const raw = readFileSync(keysPath, "utf-8");
    const keys = JSON.parse(raw) as { publicKey?: string };
    return keys.publicKey ?? "";
  } catch {
    return "";
  }
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

export interface ParsedArgs {
  command: "receipts" | "verify" | "help" | "version";
  risk?: string;
  action?: string;
  status?: string;
  limit: number;
  db: string;
  json: boolean;
  chain?: string;
}

export function parseCliArgs(argv: string[]): ParsedArgs {
  const { values, positionals } = parseArgs({
    args: argv,
    options: {
      help: { type: "boolean", default: false },
      version: { type: "boolean", default: false },
      risk: { type: "string" },
      action: { type: "string" },
      status: { type: "string" },
      limit: { type: "string" },
      db: { type: "string" },
      json: { type: "boolean", default: false },
      chain: { type: "string" },
    },
    allowPositionals: true,
    strict: true,
  });

  if (values.help) {
    return { command: "help", limit: DEFAULT_LIMIT, db: DEFAULT_DB_PATH, json: false };
  }

  if (values.version) {
    return { command: "version", limit: DEFAULT_LIMIT, db: DEFAULT_DB_PATH, json: false };
  }

  const command = positionals[0] ?? "receipts";

  if (command !== "receipts" && command !== "verify") {
    throw new Error(`Unknown command: "${command}". Use --help for usage.`);
  }

  const limit = values.limit !== undefined ? Number(values.limit) : DEFAULT_LIMIT;
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error(`Invalid --limit value: "${values.limit}". Must be a positive integer.`);
  }

  const risk = values.risk;
  if (risk !== undefined && !VALID_RISK_LEVELS.has(risk)) {
    throw new Error(
      `Invalid --risk value: "${risk}". Must be one of: low, medium, high, critical.`,
    );
  }

  const status = values.status;
  if (status !== undefined && !VALID_STATUSES.has(status)) {
    throw new Error(
      `Invalid --status value: "${status}". Must be one of: success, failure, pending.`,
    );
  }

  return {
    command: command as "receipts" | "verify",
    risk,
    action: values.action,
    status,
    limit: Math.floor(limit),
    db: values.db ?? DEFAULT_DB_PATH,
    json: values.json ?? false,
    chain: values.chain,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export function run(argv: string[]): void {
  const args = parseCliArgs(argv);

  switch (args.command) {
    case "help":
      process.stdout.write(helpText() + "\n");
      break;

    case "version":
      process.stdout.write(`openclaw-attest v${loadVersion()}\n`);
      break;

    case "receipts":
      runReceipts({
        risk: args.risk as RiskFilter | undefined,
        action: args.action,
        status: args.status as StatusFilter | undefined,
        limit: args.limit,
        db: args.db,
        json: args.json,
      });
      break;

    case "verify":
      runVerify({
        chain: args.chain,
        db: args.db,
        json: args.json,
      });
      break;
  }
}

// Entry point when run as a script
const isDirectRun =
  process.argv[1] &&
  (
    import.meta.url.endsWith(process.argv[1]) ||
    import.meta.url === `file://${process.argv[1]}`
  );

if (isDirectRun) {
  try {
    run(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
