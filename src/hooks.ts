/**
 * OpenClaw lifecycle hook handlers for attestation receipt generation.
 *
 * before_tool_call: stash context (params, timestamp) for the pending call
 * after_tool_call:  create, sign, chain, and store the receipt
 *
 * All mutable state (pending, chains, mappings) is passed via HookDeps —
 * no module-level singletons — so multiple plugin instances are safe.
 */

import {
  createReceipt,
  signReceipt,
  hashReceipt,
  canonicalize,
  sha256,
  type ReceiptStore,
} from "@agnt-rcpt/sdk-ts";
import type { TaxonomyMapping } from "@agnt-rcpt/sdk-ts/taxonomy";

import { classify, type TaxonomyPattern } from "./classify.js";
import { type ChainsMap, getChainState, advanceChain } from "./chain.js";

export type PendingCall = {
  toolName: string;
  params: Record<string, unknown>;
  startedAt: string;
  paramsHash: string;
};

export type PendingMap = Map<string, PendingCall>;

const PENDING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const PENDING_MAX_SIZE = 1000;

function callKey(runId?: string, toolCallId?: string): string {
  return `${runId ?? "unknown"}:${toolCallId ?? "unknown"}`;
}

export type HookDeps = {
  store: ReceiptStore;
  privateKey: string;
  verificationMethod: string;
  agentId: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  pending: PendingMap;
  chains: ChainsMap;
  mappings: TaxonomyMapping[];
  patterns: TaxonomyPattern[];
};

/**
 * Evict stale entries from the pending map to prevent memory leaks
 * when afterToolCall is never called (e.g. tool crash).
 */
function evictStalePending(pending: PendingMap): void {
  if (pending.size === 0) return;

  const now = Date.now();
  for (const [key, entry] of pending) {
    if (now - new Date(entry.startedAt).getTime() > PENDING_MAX_AGE_MS) {
      pending.delete(key);
    }
  }

  // If still over the size limit, evict oldest entries
  if (pending.size > PENDING_MAX_SIZE) {
    const sorted = [...pending.entries()].sort(
      (a, b) => new Date(a[1].startedAt).getTime() - new Date(b[1].startedAt).getTime(),
    );
    const excess = pending.size - PENDING_MAX_SIZE;
    for (let i = 0; i < excess; i++) {
      pending.delete(sorted[i][0]);
    }
  }
}

/**
 * before_tool_call handler — stash context for receipt creation.
 */
export function beforeToolCall(
  event: { toolName: string; params: Record<string, unknown>; runId?: string; toolCallId?: string },
  _ctx: { sessionKey?: string; sessionId?: string },
  deps: HookDeps,
): void {
  evictStalePending(deps.pending);

  const key = callKey(event.runId, event.toolCallId);
  deps.pending.set(key, {
    toolName: event.toolName,
    params: event.params,
    startedAt: new Date().toISOString(),
    paramsHash: sha256(canonicalize(event.params)),
  });
}

/**
 * after_tool_call handler — create a signed, chained receipt and store it.
 */
export async function afterToolCall(
  event: {
    toolName: string;
    params: Record<string, unknown>;
    runId?: string;
    toolCallId?: string;
    result?: unknown;
    error?: string;
    durationMs?: number;
  },
  ctx: { agentId?: string; sessionKey?: string; sessionId?: string },
  deps: HookDeps,
): Promise<void> {
  const key = callKey(event.runId, event.toolCallId);
  const stashed = deps.pending.get(key);
  deps.pending.delete(key);

  const sessionKey = ctx.sessionKey ?? "default";
  const sessionId = ctx.sessionId;

  // Classify the tool call
  const classification = classify(event.toolName, deps.mappings, deps.patterns);

  // Get chain state and advance sequence
  const chain = getChainState(deps.chains, sessionKey, sessionId);
  const nextSequence = chain.sequence + 1;

  // Determine outcome
  const status = event.error ? "failure" as const : "success" as const;

  // Build the unsigned receipt
  const unsigned = createReceipt({
    issuer: { id: `did:openclaw:${deps.agentId}` },
    principal: { id: `did:session:${sessionKey}` },
    action: {
      type: classification.action_type,
      risk_level: classification.risk_level,
      target: { system: "openclaw", resource: event.toolName },
      parameters_hash: stashed?.paramsHash ?? sha256(canonicalize(event.params)),
    },
    outcome: {
      status,
      error: event.error ?? null,
    },
    chain: {
      sequence: nextSequence,
      previous_receipt_hash: chain.previousReceiptHash,
      chain_id: chain.chainId,
    },
    actionTimestamp: stashed?.startedAt,
  });

  // Sign and hash
  const signed = signReceipt(unsigned, deps.privateKey, deps.verificationMethod);
  const hash = hashReceipt(signed);

  // Store and advance chain
  deps.store.insert(signed, hash);
  advanceChain(deps.chains, sessionKey, sessionId, hash);

  deps.logger.info(
    `agent-receipts: receipt ${signed.id} (${classification.action_type}, ${classification.risk_level}) → chain ${chain.chainId} seq ${nextSequence}`,
  );
}
