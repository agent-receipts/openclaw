/**
 * Agent-facing tools that let the AI introspect its own audit trail.
 */

import { Type } from "@sinclair/typebox";
import type { ReceiptStore } from "@attest-protocol/attest-ts";
import { verifyStoredChain } from "@attest-protocol/attest-ts";
import type { getChainId } from "./chain.js";

type ToolDeps = {
  store: ReceiptStore;
  publicKey: string;
  getChainId: typeof getChainId;
};

/**
 * Create the attest_query_receipts tool definition.
 */
export function createQueryReceiptsTool(deps: ToolDeps) {
  return {
    name: "attest_query_receipts",
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
        Type.String({ description: 'Filter by outcome status: "success" or "failure"' }),
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
      const results = deps.store.query({
        actionType: params.action_type,
        riskLevel: params.risk_level as "low" | "medium" | "high" | "critical" | undefined,
        status: params.status as "success" | "failure" | "pending" | undefined,
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
        content: [{ type: "text", text: JSON.stringify(summary, null, 2) }],
      };
    },
  };
}

/**
 * Create the attest_verify_chain tool definition.
 */
export function createVerifyChainTool(deps: ToolDeps) {
  return {
    name: "attest_verify_chain",
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
      ctx?: { sessionKey?: string; sessionId?: string },
    ) {
      const chainId =
        params.chain_id ??
        deps.getChainId(ctx?.sessionKey ?? "default", ctx?.sessionId);

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

      return {
        content: [
          {
            type: "text",
            text: verification.valid
              ? `Chain "${chainId}" is valid: ${verification.length} receipts, all signatures and hash links verified.`
              : `Chain "${chainId}" is BROKEN at position ${verification.brokenAt}: tamper detected.`,
          },
          { type: "text", text: JSON.stringify(result, null, 2) },
        ],
      };
    },
  };
}
