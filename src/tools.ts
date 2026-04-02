/**
 * Agent-facing tools that let the AI introspect its own audit trail.
 *
 * Tools are registered as factory functions (OpenClawPluginToolFactory pattern)
 * so they receive session context at runtime and match the AgentTool interface.
 */

import { Type } from "@sinclair/typebox";
import type { ReceiptStore, RiskLevel, OutcomeStatus } from "@agnt-rcpt/sdk-ts";
import { verifyStoredChain } from "@agnt-rcpt/sdk-ts";

const VALID_RISK_LEVELS = new Set<string>(["low", "medium", "high", "critical"]);
const VALID_STATUSES = new Set<string>(["success", "failure", "pending"]);

export type ToolDeps = {
  store: ReceiptStore;
  publicKey: string;
  getChainId: (sessionKey: string, sessionId?: string) => string;
};

/**
 * Context passed by OpenClaw to tool factories at runtime.
 * Mirrors the subset of OpenClawPluginToolContext we use.
 */
type ToolFactoryContext = {
  sessionKey?: string;
  sessionId?: string;
  [key: string]: unknown;
};

/**
 * Create a factory function for the ar_query_receipts tool.
 * The factory is called by OpenClaw at runtime with session context.
 */
export function createQueryReceiptsToolFactory(deps: ToolDeps) {
  return (_ctx: ToolFactoryContext) => ({
    name: "ar_query_receipts",
    label: "Query Attestation Receipts",
    description:
      "Search the cryptographic audit trail of actions taken in this session. " +
      "Returns signed receipts filtered by action type, risk level, or status.",
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
        limit?: number;
      },
    ) {
      const riskLevel = params.risk_level && VALID_RISK_LEVELS.has(params.risk_level)
        ? (params.risk_level as RiskLevel)
        : undefined;
      const status = params.status && VALID_STATUSES.has(params.status)
        ? (params.status as OutcomeStatus)
        : undefined;

      const results = deps.store.query({
        actionType: params.action_type,
        riskLevel,
        status,
        limit: params.limit ?? 20,
      });

      const stats = deps.store.stats();

      const summary = {
        total_receipts: stats.total,
        total_chains: stats.chains,
        by_risk: stats.byRisk,
        by_status: stats.byStatus,
        by_action: stats.byAction,
        results: results.map((r) => ({
          id: r.id,
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
    },
  });
}

/**
 * Create a factory function for the ar_verify_chain tool.
 * The factory captures session context from OpenClaw at runtime.
 */
export function createVerifyChainToolFactory(deps: ToolDeps) {
  return (ctx: ToolFactoryContext) => ({
    name: "ar_verify_chain",
    label: "Verify Attestation Chain",
    description:
      "Cryptographically verify the integrity of the action receipt chain for a session. " +
      "Checks Ed25519 signatures, hash links, and sequence numbering to prove the audit trail is tamper-evident.",
    parameters: Type.Object({
      chain_id: Type.Optional(
        Type.String({
          description: "Chain ID to verify. Defaults to the current session's chain.",
        }),
      ),
    }),
    async execute(
      _toolCallId: string,
      params: { chain_id?: string },
    ) {
      const chainId =
        params.chain_id ??
        deps.getChainId(ctx.sessionKey ?? "default", ctx.sessionId);

      const verification = verifyStoredChain(deps.store, chainId, deps.publicKey);

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
    },
  });
}

// --- Legacy direct-tool creators (used by tests) ---

/**
 * Create the ar_query_receipts tool definition (non-factory).
 * @deprecated Use createQueryReceiptsToolFactory for OpenClaw integration.
 */
export function createQueryReceiptsTool(deps: ToolDeps) {
  return createQueryReceiptsToolFactory(deps)({});
}

/**
 * Create the ar_verify_chain tool definition (non-factory).
 * @deprecated Use createVerifyChainToolFactory for OpenClaw integration.
 */
export function createVerifyChainTool(deps: ToolDeps) {
  return createVerifyChainToolFactory(deps)({});
}
