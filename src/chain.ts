/**
 * Per-session chain state management.
 *
 * Each OpenClaw session gets its own hash-linked receipt chain.
 * Chain state is held in memory and reset on session_start.
 */

export type ChainState = {
  chainId: string;
  sequence: number;
  previousReceiptHash: string | null;
};

const chains = new Map<string, ChainState>();

/** Build a chain ID from session identifiers. */
function buildChainId(sessionKey: string, sessionId?: string): string {
  const suffix = sessionId ? `_${sessionId}` : "";
  return `chain_openclaw_${sessionKey}${suffix}`;
}

/**
 * Get or initialize the chain state for a session.
 * Returns the current state (sequence starts at 1 for new chains).
 */
export function getChainState(sessionKey: string, sessionId?: string): ChainState {
  const key = `${sessionKey}:${sessionId ?? ""}`;
  let state = chains.get(key);
  if (!state) {
    state = {
      chainId: buildChainId(sessionKey, sessionId),
      sequence: 0,
      previousReceiptHash: null,
    };
    chains.set(key, state);
  }
  return state;
}

/**
 * Advance the chain: increment sequence and record the latest receipt hash.
 * Call this after a receipt has been created and stored.
 */
export function advanceChain(
  sessionKey: string,
  sessionId: string | undefined,
  receiptHash: string,
): void {
  const state = getChainState(sessionKey, sessionId);
  state.sequence += 1;
  state.previousReceiptHash = receiptHash;
}

/**
 * Reset chain state for a session (called on session_start).
 */
export function resetChain(sessionKey: string, sessionId?: string): void {
  const key = `${sessionKey}:${sessionId ?? ""}`;
  chains.delete(key);
}

/**
 * Get the chain ID for a session without mutating state.
 */
export function getChainId(sessionKey: string, sessionId?: string): string {
  return getChainState(sessionKey, sessionId).chainId;
}
