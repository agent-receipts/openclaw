/**
 * Agent-facing tools that let the AI introspect the daemon's audit trail.
 *
 * Under Flavor B (ADR-0010), receipts live in the daemon's SQLite database.
 * Each tool opens the daemon DB read-only per execute() call to get fresh
 * data, then closes it. The daemon's public key is read from disk for chain
 * verification.
 *
 * Tools are registered as factory functions (OpenClawPluginToolFactory
 * pattern) so they receive session context at runtime.
 */

import { readFileSync } from "node:fs";
import { Type } from "@sinclair/typebox";
import type { RiskLevel, OutcomeStatus } from "@agnt-rcpt/sdk-ts";
import { openDaemonStore, verifyDaemonChain, type DaemonStoreReader } from "./daemon-store.js";

const VALID_RISK_LEVELS = new Set<string>(["low", "medium", "high", "critical"]);
const VALID_STATUSES = new Set<string>(["success", "failure", "pending"]);

export type ToolDeps = {
  daemonDbPath: string;
  daemonPublicKeyPath: string;
};

/**
 * Context passed by OpenClaw to tool factories at runtime.
 */
type ToolFactoryContext = {
  sessionKey?: string;
  sessionId?: string;
  [key: string]: unknown;
};

/**
 * Create a factory function for the ar_query_receipts tool.
 */
export function createQueryReceiptsToolFactory(deps: ToolDeps) {
  return (_ctx: ToolFactoryContext) => ({
    name: "ar_query_receipts",
    label: "Query Attestation Receipts",
    description:
      "Search the cryptographic audit trail in the daemon's receipt database. " +
      "Returns receipts newest-first, across all sessions, filtered by action type, risk level, status, or time window. " +
      "To poll for new actions since your last check, pass `timestamp_after` set to the timestamp of " +
      "the most recent receipt you've already seen.",
    parameters: Type.Object({
      action_type: Type.Optional(
        Type.String({ description: 'Filter by action type (e.g. "filesystem.file.read")' }),
      ),
      risk_level: Type.Optional(
        Type.String({ description: 'Filter by risk level: "low", "medium", "high", "critical"' }),
      ),
      status: Type.Optional(
        Type.String({ description: 'Filter by outcome status: "success", "failure", or "pending"' }),
      ),
      timestamp_after: Type.Optional(
        Type.String({ description: "ISO 8601 — return only receipts after this time (exclusive)." }),
      ),
      timestamp_before: Type.Optional(
        Type.String({ description: "ISO 8601 — return only receipts at or before this time." }),
      ),
      limit: Type.Optional(
        Type.Number({ description: "Maximum number of receipts to return (default: 20)" }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: {
        action_type?: string;
        risk_level?: string;
        status?: string;
        timestamp_after?: string;
        timestamp_before?: string;
        limit?: number;
      },
    ) {
      const riskLevel = params.risk_level && VALID_RISK_LEVELS.has(params.risk_level)
        ? (params.risk_level as RiskLevel)
        : undefined;
      const status = params.status && VALID_STATUSES.has(params.status)
        ? (params.status as OutcomeStatus)
        : undefined;

      const after =
        params.timestamp_after && !isNaN(Date.parse(params.timestamp_after))
          ? params.timestamp_after
          : undefined;
      const before =
        params.timestamp_before && !isNaN(Date.parse(params.timestamp_before))
          ? params.timestamp_before
          : undefined;

      const limit =
        typeof params.limit === "number" && Number.isInteger(params.limit) && params.limit >= 0
          ? params.limit
          : 20;

      let store: DaemonStoreReader;
      try {
        store = openDaemonStore(deps.daemonDbPath);
      } catch {
        const error = `Cannot open daemon database at ${deps.daemonDbPath}. Is the agent-receipts daemon running?`;
        const empty = { error, total_receipts: 0, total_chains: 0, by_risk: [], by_status: [], by_action: [], results: [] };
        return { content: [{ type: "text" as const, text: JSON.stringify(empty, null, 2) }], details: empty };
      }
      try {
        const all = store.query({
          actionType: params.action_type,
          riskLevel,
          status,
          after,
          before,
        });

        // Exclusive after filter: SDK uses >=, we want >.
        const filtered = after
          ? all.filter((r) => r.credentialSubject.action.timestamp !== after)
          : all;

        const results = filtered
          .sort((a, b) => {
            const ta = a.credentialSubject.action.timestamp;
            const tb = b.credentialSubject.action.timestamp;
            if (tb < ta) return -1;
            if (tb > ta) return 1;
            return b.credentialSubject.chain.sequence - a.credentialSubject.chain.sequence;
          })
          .slice(0, limit);

        const stats = store.stats();

        const summary = {
          total_receipts: stats.total,
          total_chains: stats.chains,
          by_risk: stats.byRisk,
          by_status: stats.byStatus,
          by_action: stats.byAction,
          results: results.map((r) => ({
            id: r.id,
            chain_id: r.credentialSubject.chain.chain_id,
            action: r.credentialSubject.action.type,
            risk: r.credentialSubject.action.risk_level,
            target: r.credentialSubject.action.target?.resource,
            status: r.credentialSubject.outcome.status,
            sequence: r.credentialSubject.chain.sequence,
            timestamp: r.credentialSubject.action.timestamp,
          })),
        };

        return {
          content: [{ type: "text" as const, text: JSON.stringify(summary, null, 2) }],
          details: summary,
        };
      } finally {
        store.close();
      }
    },
  });
}

/**
 * Create a factory function for the ar_verify_chain tool.
 */
export function createVerifyChainToolFactory(deps: ToolDeps) {
  return (_ctx: ToolFactoryContext) => ({
    name: "ar_verify_chain",
    label: "Verify Attestation Chain",
    description:
      "Cryptographically verify the integrity of the daemon's receipt chain. " +
      "Checks Ed25519 signatures, hash links, and sequence numbering to prove the audit trail is tamper-evident. " +
      "Reads directly from the daemon's receipt database.",
    parameters: Type.Object({
      chain_id: Type.Optional(
        Type.String({
          description: "Chain ID to verify. Auto-discovers the daemon's chain if omitted.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { chain_id?: string },
    ) {
      let store: DaemonStoreReader;
      try {
        store = openDaemonStore(deps.daemonDbPath);
      } catch {
        const text = `Cannot open daemon database at ${deps.daemonDbPath}. Is the agent-receipts daemon running?`;
        const details = { error: text, chain_id: params.chain_id ?? null, valid: false, length: 0, broken_at: null, receipts: [] };
        return {
          content: [
            { type: "text" as const, text },
            { type: "text" as const, text: JSON.stringify(details, null, 2) },
          ],
          details,
        };
      }
      try {
        let chainId = params.chain_id;
        if (!chainId) {
          // Auto-discover: loads all receipts and takes the first chain ID seen.
          // Reasonable for Phase 1 where the daemon typically has one chain.
          const first = store.query({});
          if (first.length === 0) {
            const text = "No receipts found in the daemon's database.";
            return {
              content: [{ type: "text" as const, text }],
              details: { chain_id: null, valid: false, length: 0, broken_at: null, receipts: [] },
            };
          }
          chainId = first[0]!.credentialSubject.chain.chain_id;
        }

        let publicKeyPEM: string;
        try {
          publicKeyPEM = readFileSync(deps.daemonPublicKeyPath, "utf-8");
        } catch (err) {
          const text = `Cannot read daemon public key at ${deps.daemonPublicKeyPath}: ${String(err)}`;
          return {
            content: [{ type: "text" as const, text }],
            details: { chain_id: chainId, valid: false, length: 0, broken_at: null, receipts: [] },
          };
        }

        const verification = verifyDaemonChain(store, chainId, publicKeyPEM);

        const result = {
          chain_id: chainId,
          valid: verification.valid,
          length: verification.length,
          broken_at: verification.brokenAt,
          receipts: verification.receipts.map((r) => ({
            index: r.index,
            receipt_id: r.receiptId,
            signature_valid: r.signatureValid,
            hash_link_valid: r.hashLinkValid,
            sequence_valid: r.sequenceValid,
          })),
        };

        const text = verification.valid
          ? `Chain "${chainId}" is valid: ${verification.length} receipts, all signatures and hash links verified.`
          : `Chain "${chainId}" is BROKEN at position ${verification.brokenAt}: tamper detected.`;

        return {
          content: [
            { type: "text" as const, text },
            { type: "text" as const, text: JSON.stringify(result, null, 2) },
          ],
          details: result,
        };
      } finally {
        store.close();
      }
    },
  });
}

// Legacy direct-tool creators used by tests.
export function createQueryReceiptsTool(deps: ToolDeps) {
  return createQueryReceiptsToolFactory(deps)({});
}

export function createVerifyChainTool(deps: ToolDeps) {
  return createVerifyChainToolFactory(deps)({});
}
