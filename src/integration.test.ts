/**
 * Integration smoke test — exercises the full plugin lifecycle
 * through index.ts register(), the same code path OpenClaw uses at runtime.
 *
 * Builds a mock OpenClawPluginApi, calls register(), then drives
 * session_start → tool calls → query → verify → shutdown.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { OpenClawPluginApi } from "./openclaw-types.js";
import plugin from "./index.js";

// ---- Mock OpenClawPluginApi ----

type CapturedHook = {
  handler: (...args: any[]) => any;
  opts?: { priority?: number };
};

type CapturedTool = {
  definition: any;
  opts?: { name?: string };
};

function createMockApi(config?: Record<string, unknown>): {
  api: OpenClawPluginApi;
  hooks: Map<string, CapturedHook[]>;
  tools: Map<string, CapturedTool>;
  services: { name: string; stop?: () => Promise<void> | void }[];
  logs: string[];
} {
  const hooks = new Map<string, CapturedHook[]>();
  const tools = new Map<string, CapturedTool>();
  const services: { name: string; stop?: () => Promise<void> | void }[] = [];
  const logs: string[] = [];

  const api: OpenClawPluginApi = {
    id: "integration-test-agent",
    pluginConfig: config,
    logger: {
      info: (msg: string) => logs.push(`INFO: ${msg}`),
      warn: (msg: string) => logs.push(`WARN: ${msg}`),
    },
    on: (hookName: string, handler: (...args: any[]) => any, opts?: { priority?: number }) => {
      if (!hooks.has(hookName)) hooks.set(hookName, []);
      hooks.get(hookName)!.push({ handler, opts });
    },
    registerTool: (tool: any, opts?: { name?: string }) => {
      const name = opts?.name ?? tool.name;
      tools.set(name, { definition: tool, opts });
    },
    registerService: (service: { name: string; stop?: () => Promise<void> | void }) => {
      services.push(service);
    },
  };

  return { api, hooks, tools, services, logs };
}

/** Fire all handlers registered for a hook name. */
async function fireHook(
  hooks: Map<string, CapturedHook[]>,
  hookName: string,
  event: any,
  ctx: any,
): Promise<void> {
  const handlers = hooks.get(hookName) ?? [];
  for (const { handler } of handlers) {
    await handler(event, ctx);
  }
}

// ---- Tests ----

describe("integration: full plugin lifecycle", () => {
  let tempDir: string;
  let teardown: (() => Promise<void>) | undefined;

  afterEach(async () => {
    // Close the store before removing temp files to avoid leaked file handles
    if (teardown) {
      await teardown();
      teardown = undefined;
    }
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  function setupPlugin(configOverrides?: Record<string, unknown>) {
    tempDir = join(tmpdir(), `attest-integration-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });

    const config = {
      dbPath: join(tempDir, "receipts.db"),
      keyPath: join(tempDir, "keys.json"),
      ...configOverrides,
    };

    const mock = createMockApi(config);
    plugin.register(mock.api);

    // Wire up teardown so afterEach always closes the store
    teardown = async () => {
      for (const svc of mock.services) {
        await svc.stop?.();
      }
    };

    return mock;
  }

  it("register() wires hooks, tools, and service", () => {
    const { hooks, tools, services, logs } = setupPlugin();

    // Three hooks registered
    expect(hooks.has("session_start")).toBe(true);
    expect(hooks.has("before_tool_call")).toBe(true);
    expect(hooks.has("after_tool_call")).toBe(true);

    // Two tools registered
    expect(tools.has("attest_query_receipts")).toBe(true);
    expect(tools.has("attest_verify_chain")).toBe(true);

    // One service registered
    expect(services).toHaveLength(1);
    expect(services[0].name).toBe("attest-store");

    // Logs confirm successful registration
    expect(logs.some((l) => l.includes("plugin registered"))).toBe(true);
  });

  it("full lifecycle: session → tool calls → query → verify → shutdown", async () => {
    const { hooks, tools, services } = setupPlugin();

    const sessionCtx = { sessionKey: "main", sessionId: "sid-42" };

    // 1. Start session
    await fireHook(hooks, "session_start", {}, sessionCtx);

    // 2. Simulate 3 tool calls: read, write, delete
    const toolCalls = [
      { toolName: "read_file", params: { path: "/docs/report.md" }, toolCallId: "tc-1" },
      { toolName: "write_file", params: { path: "/docs/summary.md", content: "..." }, toolCallId: "tc-2" },
      { toolName: "delete_file", params: { path: "/tmp/old.log" }, toolCallId: "tc-3" },
    ];

    for (const tc of toolCalls) {
      const event = { ...tc, runId: "run-1" };

      await fireHook(hooks, "before_tool_call", event, sessionCtx);
      await fireHook(hooks, "after_tool_call", {
        ...event,
        result: { ok: true },
      }, sessionCtx);
    }

    // 3. Query receipts via the registered tool
    const queryTool = tools.get("attest_query_receipts")!.definition;
    const queryResult = await queryTool.execute("tc-query", {});
    const queryData = JSON.parse(queryResult.content[0].text);

    expect(queryData.total_receipts).toBe(3);
    expect(queryData.results).toHaveLength(3);
    expect(queryData.results[0].action).toBe("filesystem.file.read");
    expect(queryData.results[1].action).toBe("filesystem.file.create");
    expect(queryData.results[2].action).toBe("filesystem.file.delete");

    // Verify risk levels are classified correctly
    expect(queryData.results[0].risk).toBe("low");    // read
    expect(queryData.results[2].risk).toBe("high");    // delete

    // Verify sequence numbering
    expect(queryData.results[0].sequence).toBe(1);
    expect(queryData.results[1].sequence).toBe(2);
    expect(queryData.results[2].sequence).toBe(3);

    // 4. Verify chain integrity via the registered tool
    const verifyTool = tools.get("attest_verify_chain")!.definition;
    const verifyResult = await verifyTool.execute("tc-verify", {}, sessionCtx);

    expect(verifyResult.content[0].text).toContain("is valid");
    expect(verifyResult.content[0].text).toContain("3 receipts");

    const verifyData = JSON.parse(verifyResult.content[1].text);
    expect(verifyData.valid).toBe(true);
    expect(verifyData.length).toBe(3);

    // Every receipt has valid signature and hash link
    for (const r of verifyData.receipts) {
      expect(r.signature_valid).toBe(true);
      expect(r.hash_link_valid).toBe(true);
      expect(r.sequence_valid).toBe(true);
    }

    // 5. Shutdown is handled by afterEach teardown
  });

  it("session reset clears chain state", async () => {
    const { hooks, tools } = setupPlugin();

    const session1 = { sessionKey: "s1", sessionId: "sid-1" };
    const session2 = { sessionKey: "s2", sessionId: "sid-2" };

    // Session 1: 2 tool calls
    await fireHook(hooks, "session_start", {}, session1);
    for (let i = 0; i < 2; i++) {
      const event = { toolName: "read_file", params: { path: `/f${i}` }, runId: "run-1", toolCallId: `tc-1-${i}` };
      await fireHook(hooks, "before_tool_call", event, session1);
      await fireHook(hooks, "after_tool_call", { ...event, result: { ok: true } }, session1);
    }

    // Session 2: 1 tool call
    await fireHook(hooks, "session_start", {}, session2);
    const event = { toolName: "delete_file", params: { path: "/x" }, runId: "run-2", toolCallId: "tc-2-0" };
    await fireHook(hooks, "before_tool_call", event, session2);
    await fireHook(hooks, "after_tool_call", { ...event, result: { ok: true } }, session2);

    // Verify both chains independently
    const verifyTool = tools.get("attest_verify_chain")!.definition;

    const r1 = await verifyTool.execute("v1", {}, session1);
    const d1 = JSON.parse(r1.content[1].text);
    expect(d1.valid).toBe(true);
    expect(d1.length).toBe(2);

    const r2 = await verifyTool.execute("v2", {}, session2);
    const d2 = JSON.parse(r2.content[1].text);
    expect(d2.valid).toBe(true);
    expect(d2.length).toBe(1);

    // Session 2's receipt starts at sequence 1 (fresh chain)
    const queryTool = tools.get("attest_query_receipts")!.definition;
    const qr = await queryTool.execute("q", { action_type: "filesystem.file.delete" });
    const qd = JSON.parse(qr.content[0].text);
    expect(qd.results[0].sequence).toBe(1);
  });

  it("enabled: false skips registration entirely", () => {
    const { hooks, tools, services, logs } = setupPlugin({ enabled: false });

    expect(hooks.size).toBe(0);
    expect(tools.size).toBe(0);
    expect(services).toHaveLength(0);
    expect(logs.some((l) => l.includes("plugin disabled"))).toBe(true);
  });

  it("tool call failure records failure outcome", async () => {
    const { hooks, tools } = setupPlugin();

    await fireHook(hooks, "session_start", {}, { sessionKey: "err", sessionId: "sid-err" });

    const event = { toolName: "run_command", params: { cmd: "exit 1" }, runId: "run-1", toolCallId: "tc-fail" };
    await fireHook(hooks, "before_tool_call", event, { sessionKey: "err", sessionId: "sid-err" });
    await fireHook(hooks, "after_tool_call", {
      ...event,
      error: "Command failed with exit code 1",
    }, { sessionKey: "err", sessionId: "sid-err" });

    const queryTool = tools.get("attest_query_receipts")!.definition;
    const result = await queryTool.execute("q", { status: "failure" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].status).toBe("failure");
    expect(data.results[0].action).toBe("system.command.execute");
    expect(data.results[0].risk).toBe("high");
  });
});
