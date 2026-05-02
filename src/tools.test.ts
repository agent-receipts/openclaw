import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type ReceiptStore, createReceipt, signReceipt, hashReceipt } from "@agnt-rcpt/sdk-ts";
import { createQueryReceiptsTool, createQueryReceiptsToolFactory, createVerifyChainTool, createVerifyChainToolFactory } from "./tools.js";
import { makeHookDeps, simulateToolCall } from "./test-helpers.js";
import { getChainId } from "./chain.js";

describe("ar_query_receipts", () => {
  let store: ReceiptStore;
  let deps: ReturnType<typeof makeHookDeps>;
  let tool: ReturnType<typeof createQueryReceiptsTool>;

  beforeEach(() => {
    store = openStore(":memory:");
    deps = makeHookDeps(store);
    // Use session context matching simulateToolCall defaults so the session-default
    // chain filter resolves to the same chain where receipts are written.
    tool = createQueryReceiptsToolFactory({
      store,
      publicKey: deps.publicKey,
      getChainId: (sk, sid) => getChainId(deps.chains, sk, sid),
    })({ sessionKey: "test-session", sessionId: "sid-1" });
  });

  afterEach(() => {
    store.close();
  });

  it("returns empty results on fresh store", async () => {
    const result = await tool.execute("tc-1", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.total_receipts).toBe(0);
    expect(data.results).toHaveLength(0);
  });

  it("returns receipts after hooks create them", async () => {
    await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });
    await simulateToolCall(deps, "write_file", { path: "/b.txt" }, { toolCallId: "tc-2" });

    const result = await tool.execute("tc-q", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.total_receipts).toBe(2);
    expect(data.results).toHaveLength(2);
  });

  it("filters by action_type", async () => {
    await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });
    await simulateToolCall(deps, "run_command", { cmd: "ls" }, { toolCallId: "tc-2" });

    const result = await tool.execute("tc-q", { action_type: "filesystem.file.read" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].action).toBe("filesystem.file.read");
  });

  it("filters by risk_level", async () => {
    await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });
    await simulateToolCall(deps, "delete_file", { path: "/b.txt" }, { toolCallId: "tc-2" });

    const result = await tool.execute("tc-q", { risk_level: "high" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].risk).toBe("high");
  });

  it("filters by status", async () => {
    await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });
    await simulateToolCall(deps, "read_file", { path: "/missing.txt" }, {
      toolCallId: "tc-2",
      error: "not found",
    });

    const result = await tool.execute("tc-q", { status: "failure" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].status).toBe("failure");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      await simulateToolCall(deps, "read_file", { path: `/f${i}` }, { toolCallId: `tc-${i}` });
    }

    const result = await tool.execute("tc-q", { limit: 2 });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    expect(data.total_receipts).toBe(5);
  });

  it("includes stats summary", async () => {
    await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });
    await simulateToolCall(deps, "delete_file", { path: "/b.txt" }, { toolCallId: "tc-2" });

    const result = await tool.execute("tc-q", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.total_receipts).toBe(2);
    expect(data.total_chains).toBe(1);
    expect(data.by_risk).toBeDefined();
    expect(data.by_status).toBeDefined();
    expect(data.by_action).toBeDefined();
  });

  it("ignores invalid risk_level values", async () => {
    await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });

    const result = await tool.execute("tc-q", { risk_level: "invalid_value" });
    const data = JSON.parse(result.content[0].text);

    // Invalid risk_level is ignored, returns all results
    expect(data.results).toHaveLength(1);
  });

  it("ignores invalid status values", async () => {
    await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });

    const result = await tool.execute("tc-q", { status: "not_a_status" });
    const data = JSON.parse(result.content[0].text);

    // Invalid status is ignored, returns all results
    expect(data.results).toHaveLength(1);
  });
});

/**
 * Insert a minimal signed receipt at an explicit timestamp directly into the store.
 * This lets ordering tests control timestamps precisely without relying on wall-clock.
 */
function insertReceiptAt(
  store: ReceiptStore,
  deps: ReturnType<typeof makeHookDeps>,
  opts: {
    seq: number;
    chainId: string;
    timestamp: string;
    previousHash: string | null;
    actionType?: string;
  },
): string {
  const unsigned = createReceipt({
    issuer: { id: "did:openclaw:test-agent" },
    principal: { id: "did:session:test-session" },
    action: {
      type: opts.actionType ?? "filesystem.file.read",
      risk_level: "low",
      target: { system: "openclaw", resource: "read_file" },
      parameters_hash: "abc123",
    },
    outcome: { status: "success" },
    chain: {
      sequence: opts.seq,
      previous_receipt_hash: opts.previousHash,
      chain_id: opts.chainId,
    },
    actionTimestamp: opts.timestamp,
  });
  const signed = signReceipt(unsigned, deps.privateKey, "did:openclaw:test-agent#key-1");
  const hash = hashReceipt(signed);
  store.insert(signed, hash);
  return hash;
}

describe("ar_query_receipts — filters and ordering", () => {
  let store: ReceiptStore;
  let deps: ReturnType<typeof makeHookDeps>;
  let tool: ReturnType<typeof createQueryReceiptsTool>;

  const CHAIN_A = "chain_openclaw_test-session_sid-1";
  const CHAIN_B = "chain_openclaw_test-session_sid-2";

  beforeEach(() => {
    store = openStore(":memory:");
    deps = makeHookDeps(store);
    // Construct with session context matching CHAIN_A so session-default chain
    // resolves correctly for tests that rely on it.
    tool = createQueryReceiptsToolFactory({
      store,
      publicKey: deps.publicKey,
      getChainId: (sk, sid) => getChainId(deps.chains, sk, sid),
    })({ sessionKey: "test-session", sessionId: "sid-1" });
  });

  afterEach(() => {
    store.close();
  });

  it("default ordering is newest-first", async () => {
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });
    insertReceiptAt(store, deps, { seq: 2, chainId: CHAIN_A, timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h1" });
    insertReceiptAt(store, deps, { seq: 3, chainId: CHAIN_A, timestamp: "2024-01-01T12:00:00.000Z", previousHash: "h2" });

    const result = await tool.execute("tc-q", { chain_id: CHAIN_A });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(3);
    // First result should be the latest timestamp
    expect(data.results[0].timestamp).toBe("2024-01-01T12:00:00.000Z");
    expect(data.results[2].timestamp).toBe("2024-01-01T10:00:00.000Z");
  });

  it("limit is applied after newest-first ordering", async () => {
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T08:00:00.000Z", previousHash: null });
    insertReceiptAt(store, deps, { seq: 2, chainId: CHAIN_A, timestamp: "2024-01-01T09:00:00.000Z", previousHash: "h1" });
    insertReceiptAt(store, deps, { seq: 3, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: "h2" });
    insertReceiptAt(store, deps, { seq: 4, chainId: CHAIN_A, timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h3" });
    insertReceiptAt(store, deps, { seq: 5, chainId: CHAIN_A, timestamp: "2024-01-01T12:00:00.000Z", previousHash: "h4" });

    const result = await tool.execute("tc-q", { chain_id: CHAIN_A, limit: 2 });
    const data = JSON.parse(result.content[0].text);

    // Should return the 2 newest, not the 2 oldest
    expect(data.results).toHaveLength(2);
    expect(data.results[0].timestamp).toBe("2024-01-01T12:00:00.000Z");
    expect(data.results[1].timestamp).toBe("2024-01-01T11:00:00.000Z");
    expect(data.total_receipts).toBe(5);
  });

  it("filters by timestamp_after (exclusive — does not include the boundary timestamp)", async () => {
    const T1 = "2024-01-01T08:00:00.000Z";
    const T2 = "2024-01-01T10:00:00.000Z";
    const T3 = "2024-01-01T12:00:00.000Z";
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_A, timestamp: T1, previousHash: null });
    insertReceiptAt(store, deps, { seq: 2, chainId: CHAIN_A, timestamp: T2, previousHash: "h1" });
    insertReceiptAt(store, deps, { seq: 3, chainId: CHAIN_A, timestamp: T3, previousHash: "h2" });

    // Polling with timestamp_after: T1 should return T2 and T3 but NOT T1 itself.
    const result = await tool.execute("tc-q", { chain_id: CHAIN_A, timestamp_after: T1 });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    const timestamps = data.results.map((r: { timestamp: string }) => r.timestamp);
    expect(timestamps).toContain(T2);
    expect(timestamps).toContain(T3);
    expect(timestamps).not.toContain(T1);
  });

  it("filters by timestamp_after (mid-range)", async () => {
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T08:00:00.000Z", previousHash: null });
    insertReceiptAt(store, deps, { seq: 2, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: "h1" });
    insertReceiptAt(store, deps, { seq: 3, chainId: CHAIN_A, timestamp: "2024-01-01T12:00:00.000Z", previousHash: "h2" });

    const result = await tool.execute("tc-q", { chain_id: CHAIN_A, timestamp_after: "2024-01-01T09:00:00.000Z" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    for (const r of data.results) {
      expect(r.timestamp > "2024-01-01T09:00:00.000Z").toBe(true);
    }
  });

  it("filters by timestamp_before", async () => {
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T08:00:00.000Z", previousHash: null });
    insertReceiptAt(store, deps, { seq: 2, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: "h1" });
    insertReceiptAt(store, deps, { seq: 3, chainId: CHAIN_A, timestamp: "2024-01-01T12:00:00.000Z", previousHash: "h2" });

    const result = await tool.execute("tc-q", { chain_id: CHAIN_A, timestamp_before: "2024-01-01T11:00:00.000Z" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    for (const r of data.results) {
      expect(r.timestamp <= "2024-01-01T11:00:00.000Z").toBe(true);
    }
  });

  it("filters by chain_id", async () => {
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });
    insertReceiptAt(store, deps, { seq: 2, chainId: CHAIN_A, timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h1" });
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_B, timestamp: "2024-01-01T12:00:00.000Z", previousHash: null });

    const result = await tool.execute("tc-q", { chain_id: CHAIN_A });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    expect(data.total_receipts).toBe(3);
  });

  it("combining timestamp_after and limit returns newest receipts after cutoff", async () => {
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T06:00:00.000Z", previousHash: null });
    insertReceiptAt(store, deps, { seq: 2, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: "h1" });
    insertReceiptAt(store, deps, { seq: 3, chainId: CHAIN_A, timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h2" });
    insertReceiptAt(store, deps, { seq: 4, chainId: CHAIN_A, timestamp: "2024-01-01T12:00:00.000Z", previousHash: "h3" });

    // Poll: "give me the latest 2 receipts since 09:00"
    const result = await tool.execute("tc-q", {
      chain_id: CHAIN_A,
      timestamp_after: "2024-01-01T09:00:00.000Z",
      limit: 2,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    expect(data.results[0].timestamp).toBe("2024-01-01T12:00:00.000Z");
    expect(data.results[1].timestamp).toBe("2024-01-01T11:00:00.000Z");
  });

  it("ignores invalid timestamp_after values", async () => {
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });

    const result = await tool.execute("tc-q", { chain_id: CHAIN_A, timestamp_after: "not-a-date" });
    const data = JSON.parse(result.content[0].text);

    // Invalid timestamp is ignored — returns all results
    expect(data.results).toHaveLength(1);
  });

  it("ignores invalid timestamp_before values", async () => {
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });

    const result = await tool.execute("tc-q", { chain_id: CHAIN_A, timestamp_before: "not-a-date" });
    const data = JSON.parse(result.content[0].text);

    // Invalid timestamp is ignored — returns all results
    expect(data.results).toHaveLength(1);
  });

  it("result shape includes chain_id field", async () => {
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });

    const result = await tool.execute("tc-q", { chain_id: CHAIN_A });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].chain_id).toBe(CHAIN_A);
  });

  it("limit: -1 falls back to default of 20", async () => {
    // Insert 25 receipts so we can distinguish 20 from 25
    for (let i = 1; i <= 25; i++) {
      insertReceiptAt(store, deps, {
        seq: i,
        chainId: CHAIN_A,
        timestamp: `2024-01-01T${String(i).padStart(2, "0")}:00:00.000Z`,
        previousHash: i === 1 ? null : `h${i - 1}`,
      });
    }

    const result = await tool.execute("tc-q", { chain_id: CHAIN_A, limit: -1 });
    const data = JSON.parse(result.content[0].text);

    // -1 is invalid; falls back to default 20
    expect(data.results).toHaveLength(20);
  });

  it("limit: 5.7 (non-integer) falls back to default 20, not 5", async () => {
    // Insert 25 receipts
    for (let i = 1; i <= 25; i++) {
      insertReceiptAt(store, deps, {
        seq: i,
        chainId: CHAIN_A,
        timestamp: `2024-01-01T${String(i).padStart(2, "0")}:00:00.000Z`,
        previousHash: i === 1 ? null : `h${i - 1}`,
      });
    }

    const result = await tool.execute("tc-q", { chain_id: CHAIN_A, limit: 5.7 });
    const data = JSON.parse(result.content[0].text);

    // 5.7 is not an integer; falls back to default 20, not Math.floor(5.7)=5
    expect(data.results).toHaveLength(20);
  });

  it("same-millisecond sequence tiebreaker: higher sequence comes first", async () => {
    const SAME_TS = "2024-01-01T10:00:00.000Z";
    insertReceiptAt(store, deps, { seq: 1, chainId: CHAIN_A, timestamp: SAME_TS, previousHash: null });
    insertReceiptAt(store, deps, { seq: 2, chainId: CHAIN_A, timestamp: SAME_TS, previousHash: "h1" });

    const result = await tool.execute("tc-q", { chain_id: CHAIN_A });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    // seq 2 is "newer" within the same millisecond — must come first
    expect(data.results[0].sequence).toBe(2);
    expect(data.results[1].sequence).toBe(1);
  });

  it("defaults chain_id to current session's chain when omitted", async () => {
    // Session A receipts (CHAIN_A) — inserted via simulateToolCall
    await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-a1", sessionKey: "test-session", sessionId: "sid-1" });
    await simulateToolCall(deps, "read_file", { path: "/a2.txt" }, { toolCallId: "tc-a2", sessionKey: "test-session", sessionId: "sid-1" });
    // Session B receipt (CHAIN_B)
    await simulateToolCall(deps, "read_file", { path: "/b.txt" }, { toolCallId: "tc-b1", sessionKey: "test-session", sessionId: "sid-2" });

    // Query from session A context with no chain_id — should only return session A receipts
    const sessionATool = createQueryReceiptsToolFactory({
      store,
      publicKey: deps.publicKey,
      getChainId: (sk, sid) => getChainId(deps.chains, sk, sid),
    })({ sessionKey: "test-session", sessionId: "sid-1" });

    const result = await sessionATool.execute("tc-q", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    expect(data.total_receipts).toBe(3);
    for (const r of data.results) {
      expect(r.chain_id).toBe(CHAIN_A);
    }
  });

  it("all_chains: true returns receipts from every chain", async () => {
    await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-a1", sessionKey: "test-session", sessionId: "sid-1" });
    await simulateToolCall(deps, "read_file", { path: "/a2.txt" }, { toolCallId: "tc-a2", sessionKey: "test-session", sessionId: "sid-1" });
    await simulateToolCall(deps, "read_file", { path: "/b.txt" }, { toolCallId: "tc-b1", sessionKey: "test-session", sessionId: "sid-2" });

    // Query from session A context with all_chains — should return all 3
    const sessionATool = createQueryReceiptsToolFactory({
      store,
      publicKey: deps.publicKey,
      getChainId: (sk, sid) => getChainId(deps.chains, sk, sid),
    })({ sessionKey: "test-session", sessionId: "sid-1" });

    const result = await sessionATool.execute("tc-q", { all_chains: true });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(3);
  });

  it("explicit chain_id beats session default", async () => {
    await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-a1", sessionKey: "test-session", sessionId: "sid-1" });
    await simulateToolCall(deps, "read_file", { path: "/a2.txt" }, { toolCallId: "tc-a2", sessionKey: "test-session", sessionId: "sid-1" });
    await simulateToolCall(deps, "read_file", { path: "/b.txt" }, { toolCallId: "tc-b1", sessionKey: "test-session", sessionId: "sid-2" });

    // Query from session A context but explicitly targeting session B's chain
    const sessionATool = createQueryReceiptsToolFactory({
      store,
      publicKey: deps.publicKey,
      getChainId: (sk, sid) => getChainId(deps.chains, sk, sid),
    })({ sessionKey: "test-session", sessionId: "sid-1" });

    const result = await sessionATool.execute("tc-q", { chain_id: CHAIN_B });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].chain_id).toBe(CHAIN_B);
  });
});

describe("ar_verify_chain", () => {
  let store: ReceiptStore;
  let deps: ReturnType<typeof makeHookDeps>;
  let tool: ReturnType<typeof createVerifyChainTool>;

  beforeEach(() => {
    store = openStore(":memory:");
    deps = makeHookDeps(store);
    tool = createVerifyChainTool({
      store,
      publicKey: deps.publicKey,
      getChainId: (sk, sid) => getChainId(deps.chains, sk, sid),
    });
  });

  afterEach(() => {
    store.close();
  });

  it("returns valid for a correct chain", async () => {
    for (let i = 0; i < 3; i++) {
      await simulateToolCall(deps, "read_file", { path: `/f${i}` }, { toolCallId: `tc-${i}` });
    }

    const chainId = getChainId(deps.chains, "test-session", "sid-1");
    const result = await tool.execute("tc-v", { chain_id: chainId });

    expect(result.content[0].text).toContain("is valid");
    const data = JSON.parse(result.content[1].text);
    expect(data.valid).toBe(true);
    expect(data.length).toBe(3);
  });

  it("defaults to current session chain ID via factory context", async () => {
    await simulateToolCall(deps, "read_file", { path: "/a.txt" });

    // Create tool via factory with session context (OpenClaw pattern)
    const toolWithCtx = createVerifyChainToolFactory({
      store,
      publicKey: deps.publicKey,
      getChainId: (sk, sid) => getChainId(deps.chains, sk, sid),
    })({ sessionKey: "test-session", sessionId: "sid-1" });

    const result = await toolWithCtx.execute("tc-v", {});

    expect(result.content[0].text).toContain("is valid");
  });

  it("reports empty chain as valid with length 0", async () => {
    const result = await tool.execute("tc-v", { chain_id: "chain_nonexistent" });

    const data = JSON.parse(result.content[1].text);
    expect(data.valid).toBe(true);
    expect(data.length).toBe(0);
  });
});
