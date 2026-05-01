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
  type Action,
  type ReceiptStore,
} from "@agnt-rcpt/sdk-ts";

import { classify, type ExtendedTaxonomyMapping, type TaxonomyPattern } from "./classify.js";
import { type ChainsMap, type ChainState, getChainState, advanceChain } from "./chain.js";
import type { ParameterDisclosureConfig } from "./config.js";

export type PendingCall = {
  toolName: string;
  params: Record<string, unknown>;
  startedAt: string;
  paramsHash: string;
  sessionKey: string;
  sessionId?: string;
};

export type PendingMap = Map<string, PendingCall>;

const PENDING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const PENDING_MAX_SIZE = 1000;

function callKey(runId?: string, toolCallId?: string): string {
  return `${runId ?? "unknown"}:${toolCallId ?? "unknown"}`;
}

/**
 * If in-memory chain state is fresh (sequence=0, no prior hash), check the store
 * for existing receipts and resume from the last one. Handles plugin restarts
 * where the DB retains receipts but in-memory state is wiped.
 */
function recoverChainState(
  state: ChainState,
  store: ReceiptStore,
  logger: { warn: (msg: string) => void },
): void {
  const last = store.getChain(state.chainId).at(-1);
  if (!last) return;
  state.sequence = last.credentialSubject.chain.sequence;
  state.previousReceiptHash = hashReceipt(last);
  logger.warn(
    `agent-receipts: in-memory chain state was missing; recovered chain ${state.chainId} at sequence ${state.sequence}`,
  );
}

export type HookDeps = {
  store: ReceiptStore;
  privateKey: string;
  verificationMethod: string;
  agentId: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  pending: PendingMap;
  chains: ChainsMap;
  mappings: ExtendedTaxonomyMapping[];
  patterns: TaxonomyPattern[];
  parameterDisclosure?: ParameterDisclosureConfig;
};

export function shouldDisclose(
  config: ParameterDisclosureConfig | undefined,
  riskLevel: string,
  actionType: string,
): boolean {
  if (!config) return false;
  if (config === true) return true;
  if (config === "high") return riskLevel === "high" || riskLevel === "critical";
  if (Array.isArray(config)) return config.includes(actionType);
  return false;
}

export function extractDisclosure(
  params: Record<string, unknown>,
  fields: string[],
): Record<string, string> | undefined {
  for (const field of fields) {
    const val = params[field];
    if (val !== null && val !== undefined) {
      const serialized = typeof val === "string" ? val : JSON.stringify(val);
      if (serialized !== undefined) {
        return { [field]: serialized };
      }
    }
  }
  return undefined;
}

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
  ctx: { sessionKey?: string; sessionId?: string },
  deps: HookDeps,
): void {
  evictStalePending(deps.pending);

  const key = callKey(event.runId, event.toolCallId);
  deps.pending.set(key, {
    toolName: event.toolName,
    params: event.params,
    startedAt: new Date().toISOString(),
    paramsHash: sha256(canonicalize(event.params)),
    sessionKey: ctx.sessionKey ?? "default",
    sessionId: ctx.sessionId,
  });
}

/**
 * Evict pending entries whose stash belongs to the given session.
 * Matches on both sessionKey and sessionId so two sessions sharing a
 * sessionKey but with different sessionIds do not trample each other.
 */
export function evictPendingForSession(
  pending: PendingMap,
  sessionKey: string,
  sessionId: string | undefined,
): void {
  for (const [key, entry] of pending) {
    if (entry.sessionKey === sessionKey && entry.sessionId === sessionId) {
      pending.delete(key);
    }
  }
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

  // Optionally disclose named parameters in plaintext (opt-in only).
  // Use stashed params so disclosure and hash are derived from the same source.
  const disclosureParams = stashed?.params ?? event.params;
  const disclosure =
    shouldDisclose(deps.parameterDisclosure, classification.risk_level, classification.action_type) &&
    classification.disclosure_fields?.length
      ? extractDisclosure(disclosureParams, classification.disclosure_fields)
      : undefined;

  // Recover from the store if in-memory state was lost (e.g. plugin restart mid-session)
  const chain = getChainState(deps.chains, sessionKey, sessionId);
  if (chain.sequence === 0 && chain.previousReceiptHash === null) {
    recoverChainState(chain, deps.store, deps.logger);
  }
  const nextSequence = chain.sequence + 1;

  // Determine outcome
  const status = event.error ? "failure" as const : "success" as const;

  const action: Omit<Action, "id" | "timestamp"> = {
    type: classification.action_type,
    risk_level: classification.risk_level,
    target: { system: "openclaw", resource: event.toolName },
    parameters_hash: stashed?.paramsHash ?? sha256(canonicalize(event.params)),
    ...(disclosure !== undefined ? { parameters_disclosure: disclosure } : {}),
  };

  // Build the unsigned receipt
  const unsigned = createReceipt({
    issuer: { id: `did:openclaw:${deps.agentId}` },
    principal: { id: `did:session:${sessionKey}` },
    action,
    outcome: {
      status,
      // Omit `error` when absent — RFC 8785 canonicalize rejects undefined values,
      // so `error: undefined` would throw during hashReceipt.
      ...(event.error !== undefined ? { error: event.error } : {}),
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
