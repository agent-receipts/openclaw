import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStore, type ReceiptStore } from "@attest-protocol/attest-ts";
import { createQueryReceiptsTool, createVerifyChainTool, createVerifyChainToolFactory } from "./tools.js";
import { makeHookDeps, simulateToolCall } from "./test-helpers.js";
import { getChainId } from "./chain.js";

describe("attest_query_receipts", () => {
  let store: ReceiptStore;
  let deps: ReturnType<typeof makeHookDeps>;
  let tool: ReturnType<typeof createQueryReceiptsTool>;

  beforeEach(() => {
    store = openStore(":memory:");
    deps = makeHookDeps(store);
    tool = createQueryReceiptsTool({
      store,
      publicKey: deps.publicKey,
      getChainId: (sk, sid) => getChainId(deps.chains, sk, sid),
    });
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

describe("attest_verify_chain", () => {
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
