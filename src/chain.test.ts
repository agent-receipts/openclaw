import { afterEach, describe, expect, it } from "vitest";
import {
  getChainState,
  advanceChain,
  resetChain,
  getChainId,
} from "./chain.js";

// Reset all chain state between tests to avoid cross-test pollution
afterEach(() => {
  resetChain("sess-a", "sid-1");
  resetChain("sess-b", "sid-2");
  resetChain("no-sid");
});

describe("getChainState", () => {
  it("returns initial state with sequence 0 and null previous hash", () => {
    const state = getChainState("sess-a", "sid-1");

    expect(state.sequence).toBe(0);
    expect(state.previousReceiptHash).toBeNull();
    expect(state.chainId).toBe("chain_openclaw_sess-a_sid-1");
  });

  it("returns the same instance on repeated calls", () => {
    const a = getChainState("sess-a", "sid-1");
    const b = getChainState("sess-a", "sid-1");

    expect(a).toBe(b);
  });

  it("returns different state for different sessions", () => {
    const a = getChainState("sess-a", "sid-1");
    const b = getChainState("sess-b", "sid-2");

    expect(a).not.toBe(b);
    expect(a.chainId).not.toBe(b.chainId);
  });

  it("omits sessionId suffix when not provided", () => {
    const state = getChainState("no-sid");

    expect(state.chainId).toBe("chain_openclaw_no-sid");
  });
});

describe("advanceChain", () => {
  it("increments sequence and stores hash", () => {
    advanceChain("sess-a", "sid-1", "sha256:abc");

    const state = getChainState("sess-a", "sid-1");
    expect(state.sequence).toBe(1);
    expect(state.previousReceiptHash).toBe("sha256:abc");
  });

  it("builds up sequence correctly over multiple advances", () => {
    advanceChain("sess-a", "sid-1", "sha256:first");
    advanceChain("sess-a", "sid-1", "sha256:second");
    advanceChain("sess-a", "sid-1", "sha256:third");

    const state = getChainState("sess-a", "sid-1");
    expect(state.sequence).toBe(3);
    expect(state.previousReceiptHash).toBe("sha256:third");
  });
});

describe("resetChain", () => {
  it("clears state so next getChainState returns fresh state", () => {
    advanceChain("sess-a", "sid-1", "sha256:abc");
    resetChain("sess-a", "sid-1");

    const state = getChainState("sess-a", "sid-1");
    expect(state.sequence).toBe(0);
    expect(state.previousReceiptHash).toBeNull();
  });
});

describe("getChainId", () => {
  it("returns chain ID without mutating state", () => {
    const id = getChainId("sess-a", "sid-1");

    expect(id).toBe("chain_openclaw_sess-a_sid-1");
    // State should still be at initial values
    const state = getChainState("sess-a", "sid-1");
    expect(state.sequence).toBe(0);
  });
});
