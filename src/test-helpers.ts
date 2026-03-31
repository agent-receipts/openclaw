/**
 * Shared test utilities for openclaw-attest tests.
 */

import {
  generateKeyPair,
  openStore,
  type ReceiptStore,
} from "@attest-protocol/attest-ts";
import { beforeToolCall, afterToolCall, type HookDeps } from "./hooks.js";

/**
 * Create HookDeps with generated keys and an in-memory store.
 */
export function makeHookDeps(store?: ReceiptStore): HookDeps & {
  publicKey: string;
  store: ReceiptStore;
} {
  const keys = generateKeyPair();
  const s = store ?? openStore(":memory:");
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
