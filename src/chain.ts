/**
 * Per-session chain state management.
 *
 * Each OpenClaw session gets its own hash-linked receipt chain.
 * Chain state is held in memory and reset on session_start.
 *
 * All functions take a `chains` Map parameter — no module-level
 * mutable state — so multiple plugin instances are safe.
 */

export type ChainState = {
  chainId: string;
  sequence: number;
  previousReceiptHash: string | null;
};

export type ChainsMap = Map<string, ChainState>;

/** Build a chain ID from session identifiers. */
function buildChainId(sessionKey: string, sessionId?: string): string {
  const suffix = sessionId ? `_${sessionId}` : "";
  return `chain_openclaw_${sessionKey}${suffix}`;
}

/**
 * Get or initialize the chain state for a session.
 * Returns the current state (sequence starts at 1 for new chains).
 */
export function getChainState(chains: ChainsMap, sessionKey: string, sessionId?: string): ChainState {
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
  chains: ChainsMap,
  sessionKey: string,
  sessionId: string | undefined,
  receiptHash: string,
): void {
  const state = getChainState(chains, sessionKey, sessionId);
  state.sequence += 1;
  state.previousReceiptHash = receiptHash;
}

/**
 * Reset chain state for a session (called on session_start).
 */
export function resetChain(chains: ChainsMap, sessionKey: string, sessionId?: string): void {
  const key = `${sessionKey}:${sessionId ?? ""}`;
  chains.delete(key);
}

/**
 * Get the chain ID for a session without mutating state.
 */
export function getChainId(chains: ChainsMap, sessionKey: string, sessionId?: string): string {
  return getChainState(chains, sessionKey, sessionId).chainId;
}
