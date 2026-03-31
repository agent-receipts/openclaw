/**
 * Shared test utilities for openclaw-attest tests.
 */

import {
  generateKeyPair,
  openStore,
  type ReceiptStore,
} from "@attest-protocol/attest-ts";
import { beforeToolCall, afterToolCall, type HookDeps, type PendingMap } from "./hooks.js";
import { type ChainsMap, type ChainState } from "./chain.js";
import { DEFAULT_MAPPINGS } from "./classify.js";

/**
 * Create HookDeps with generated keys, in-memory store, and isolated state.
 * Each call creates fresh chains/pending/mappings — no shared module state.
 */
export function makeHookDeps(store?: ReceiptStore): HookDeps & {
  publicKey: string;
  store: ReceiptStore;
} {
  const keys = generateKeyPair();
  const s = store ?? openStore(":memory:");
  const chains: ChainsMap = new Map<string, ChainState>();
  const pending: PendingMap = new Map();
  return {
    store: s,
    privateKey: keys.privateKey,
    publicKey: keys.publicKey,
    verificationMethod: "did:openclaw:test-agent#key-1",
    agentId: "test-agent",
    logger: {
      info: () => {},
      warn: () => {},
    },
    chains,
    pending,
    mappings: DEFAULT_MAPPINGS,
  };
}

/**
 * Simulate a complete tool call lifecycle (before + after).
 */
export async function simulateToolCall(
  deps: HookDeps,
  toolName: string,
  params: Record<string, unknown>,
  opts?: {
    runId?: string;
    toolCallId?: string;
    sessionKey?: string;
    sessionId?: string;
    error?: string;
  },
): Promise<void> {
  const runId = opts?.runId ?? "run-1";
  const toolCallId = opts?.toolCallId ?? `tc-${Date.now()}`;
  const ctx = {
    sessionKey: opts?.sessionKey ?? "test-session",
    sessionId: opts?.sessionId ?? "sid-1",
  };

  beforeToolCall(
    { toolName, params, runId, toolCallId },
    ctx,
    deps,
  );

  await afterToolCall(
    {
      toolName,
      params,
      runId,
      toolCallId,
      result: opts?.error ? undefined : { ok: true },
      error: opts?.error,
    },
    { agentId: deps.agentId, ...ctx },
    deps,
  );
}
