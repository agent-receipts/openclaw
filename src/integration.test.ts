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
import { openStore } from "@agnt-rcpt/sdk-ts";
import type { OpenClawPluginApi } from "./openclaw-types.js";
import plugin from "./index.js";

// ---- Mock OpenClawPluginApi ----

type CapturedHook = {
  handler: (...args: any[]) => any;
  opts?: { priority?: number };
};

type CapturedTool = {
  definition: any;
  factory?: (ctx: any) => any;
  opts?: { name?: string };
};

function createMockApi(config?: Record<string, unknown>): {
  api: OpenClawPluginApi;
  hooks: Map<string, CapturedHook[]>;
  tools: Map<string, CapturedTool>;
  services: { id: string; start?: () => Promise<void> | void; stop?: () => Promise<void> | void }[];
  logs: string[];
} {
  const hooks = new Map<string, CapturedHook[]>();
  const tools = new Map<string, CapturedTool>();
  const services: { id: string; start?: () => Promise<void> | void; stop?: () => Promise<void> | void }[] = [];
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
      // If tool is a factory function (OpenClaw pattern), call it with mock context
      const isFactory = typeof tool === "function";
      const resolved = isFactory
        ? tool({ sessionKey: "test", sessionId: "sid-mock" })
        : tool;
      const name = opts?.name ?? resolved.name;
      tools.set(name, { definition: resolved, factory: isFactory ? tool : undefined, opts });
    },
    registerService: (service: { id: string; start: () => Promise<void> | void; stop?: () => Promise<void> | void }) => {
      services.push(service);
      service.start?.();
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
    tempDir = join(tmpdir(), `ar-integration-${randomUUID()}`);
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
    expect(tools.has("ar_query_receipts")).toBe(true);
    expect(tools.has("ar_verify_chain")).toBe(true);

    // One service registered
    expect(services).toHaveLength(1);
    expect(services[0].id).toBe("ar-store");

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
    const queryTool = tools.get("ar_query_receipts")!.definition;
    const queryResult = await queryTool.execute("tc-query", { all_chains: true });
    const queryData = JSON.parse(queryResult.content[0].text);

    expect(queryData.total_receipts).toBe(3);
    expect(queryData.results).toHaveLength(3);
    // Results are newest-first (delete → write → read)
    expect(queryData.results[0].action).toBe("filesystem.file.delete");
    expect(queryData.results[1].action).toBe("filesystem.file.create");
    expect(queryData.results[2].action).toBe("filesystem.file.read");

    // Verify risk levels are classified correctly
    expect(queryData.results[0].risk).toBe("high");    // delete
    expect(queryData.results[2].risk).toBe("low");     // read

    // Verify sequence numbering (newest-first: sequences 3, 2, 1)
    expect(queryData.results[0].sequence).toBe(3);
    expect(queryData.results[1].sequence).toBe(2);
    expect(queryData.results[2].sequence).toBe(1);

    // 4. Verify chain integrity via the registered tool (resolve factory with session context)
    const verifyFactory = tools.get("ar_verify_chain")!.factory!;
    const verifyTool = verifyFactory(sessionCtx);
    const verifyResult = await verifyTool.execute("tc-verify", {});

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

    // Verify both chains independently (resolve factory per session)
    const verifyFactory = tools.get("ar_verify_chain")!.factory!;

    const r1 = await verifyFactory(session1).execute("v1", {});
    const d1 = JSON.parse(r1.content[1].text);
    expect(d1.valid).toBe(true);
    expect(d1.length).toBe(2);

    const r2 = await verifyFactory(session2).execute("v2", {});
    const d2 = JSON.parse(r2.content[1].text);
    expect(d2.valid).toBe(true);
    expect(d2.length).toBe(1);

    // Session 2's receipt starts at sequence 1 (fresh chain)
    const queryTool = tools.get("ar_query_receipts")!.definition;
    const qr = await queryTool.execute("q", { action_type: "filesystem.file.delete", all_chains: true });
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

    const queryTool = tools.get("ar_query_receipts")!.definition;
    const result = await queryTool.execute("q", { status: "failure", all_chains: true });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].status).toBe("failure");
    expect(data.results[0].action).toBe("system.command.execute");
    expect(data.results[0].risk).toBe("high");
  });

  describe("parameter disclosure", () => {
    it("parameterDisclosure: 'high' adds parameters_disclosure to high-risk receipts but not low-risk", async () => {
      const { hooks, tools } = setupPlugin({ parameterDisclosure: "high" });
      const sessionCtx = { sessionKey: "disclose-high", sessionId: "sid-dh" };

      await fireHook(hooks, "session_start", {}, sessionCtx);

      // bash = system.command.execute (high risk) — should have disclosure
      const bashCall = { toolName: "bash", params: { command: "ls -la" }, runId: "run-d", toolCallId: "tc-bash" };
      await fireHook(hooks, "before_tool_call", bashCall, sessionCtx);
      await fireHook(hooks, "after_tool_call", { ...bashCall, result: { ok: true } }, sessionCtx);

      // read_file = filesystem.file.read (low risk) — should NOT have disclosure
      const readCall = { toolName: "read_file", params: { path: "/secret.txt" }, runId: "run-d", toolCallId: "tc-read" };
      await fireHook(hooks, "before_tool_call", readCall, sessionCtx);
      await fireHook(hooks, "after_tool_call", { ...readCall, result: { ok: true } }, sessionCtx);

      // Open a second store connection to read raw receipts (SQLite allows concurrent readers)
      const readStore = openStore(join(tempDir, "receipts.db"));
      try {
        const chain = readStore.getChain("chain_openclaw_disclose-high_sid-dh");
        expect(chain).toHaveLength(2);

        // bash receipt (high risk) should have parameters_disclosure with first matching field
        const bashAction = chain[0]!.credentialSubject.action;
        expect(bashAction.parameters_disclosure).toEqual({ command: "ls -la" });

        // read_file receipt (low risk) should NOT have parameters_disclosure
        const readAction = chain[1]!.credentialSubject.action;
        expect(readAction.parameters_disclosure).toBeUndefined();

        // Chain must still be cryptographically valid with parameters_disclosure present
        const verifyFactory = tools.get("ar_verify_chain")!.factory!;
        const verifyResult = await verifyFactory(sessionCtx).execute("v", {});
        const verifyData = JSON.parse(verifyResult.content[1].text);
        expect(verifyData.valid).toBe(true);
        for (const r of verifyData.receipts) {
          expect(r.signature_valid).toBe(true);
          expect(r.hash_link_valid).toBe(true);
        }
      } finally {
        readStore.close();
      }
    });

    it("parameterDisclosure: false (default) adds no parameters_disclosure to any receipt", async () => {
      const { hooks } = setupPlugin({ parameterDisclosure: false });
      const sessionCtx = { sessionKey: "no-disclose", sessionId: "sid-nd" };

      await fireHook(hooks, "session_start", {}, sessionCtx);

      const bashCall = { toolName: "bash", params: { command: "rm -rf /tmp/test" }, runId: "run-nd", toolCallId: "tc-bash-nd" };
      await fireHook(hooks, "before_tool_call", bashCall, sessionCtx);
      await fireHook(hooks, "after_tool_call", { ...bashCall, result: { ok: true } }, sessionCtx);

      const readStore = openStore(join(tempDir, "receipts.db"));
      try {
        const chain = readStore.getChain("chain_openclaw_no-disclose_sid-nd");
        expect(chain).toHaveLength(1);

        const action = chain[0]!.credentialSubject.action;
        expect(action.parameters_disclosure).toBeUndefined();
      } finally {
        readStore.close();
      }
    });

    it("parameterDisclosure: true adds parameters_disclosure to all receipts including low-risk, but omits it when no disclosure_fields configured", async () => {
      const { hooks } = setupPlugin({ parameterDisclosure: true });
      const sessionCtx = { sessionKey: "disclose-all", sessionId: "sid-da" };

      await fireHook(hooks, "session_start", {}, sessionCtx);

      // read_file has disclosure_fields configured — should produce disclosure
      const readCall = { toolName: "read_file", params: { path: "/docs/readme.md" }, runId: "run-a", toolCallId: "tc-read-a" };
      await fireHook(hooks, "before_tool_call", readCall, sessionCtx);
      await fireHook(hooks, "after_tool_call", { ...readCall, result: { ok: true } }, sessionCtx);

      // edit_file has no disclosure_fields — should produce no disclosure even with parameterDisclosure: true
      const editCall = { toolName: "edit_file", params: { path: "/docs/readme.md", content: "..." }, runId: "run-a", toolCallId: "tc-edit-a" };
      await fireHook(hooks, "before_tool_call", editCall, sessionCtx);
      await fireHook(hooks, "after_tool_call", { ...editCall, result: { ok: true } }, sessionCtx);

      const readStore = openStore(join(tempDir, "receipts.db"));
      try {
        const chain = readStore.getChain("chain_openclaw_disclose-all_sid-da");
        expect(chain).toHaveLength(2);

        // read_file discloses path (first of ["path", "file_path", "filename"])
        const readAction = chain[0]!.credentialSubject.action;
        expect(readAction.parameters_disclosure).toEqual({ path: "/docs/readme.md" });

        // edit_file has no disclosure_fields in taxonomy — no parameters_disclosure
        const editAction = chain[1]!.credentialSubject.action;
        expect(editAction.parameters_disclosure).toBeUndefined();
      } finally {
        readStore.close();
      }
    });

    it("parameterDisclosure: string[] adds parameters_disclosure only for matching action types", async () => {
      const { hooks } = setupPlugin({ parameterDisclosure: ["system.command.execute"] });
      const sessionCtx = { sessionKey: "disclose-arr", sessionId: "sid-arr" };

      await fireHook(hooks, "session_start", {}, sessionCtx);

      // bash matches the allowlist
      const bashCall = { toolName: "bash", params: { command: "echo hello" }, runId: "run-arr", toolCallId: "tc-bash-arr" };
      await fireHook(hooks, "before_tool_call", bashCall, sessionCtx);
      await fireHook(hooks, "after_tool_call", { ...bashCall, result: { ok: true } }, sessionCtx);

      // read_file does not match
      const readCall = { toolName: "read_file", params: { path: "/file.txt" }, runId: "run-arr", toolCallId: "tc-read-arr" };
      await fireHook(hooks, "before_tool_call", readCall, sessionCtx);
      await fireHook(hooks, "after_tool_call", { ...readCall, result: { ok: true } }, sessionCtx);

      const readStore = openStore(join(tempDir, "receipts.db"));
      try {
        const chain = readStore.getChain("chain_openclaw_disclose-arr_sid-arr");
        expect(chain).toHaveLength(2);

        const bashAction = chain[0]!.credentialSubject.action;
        expect(bashAction.parameters_disclosure).toEqual({ command: "echo hello" });

        const readAction = chain[1]!.credentialSubject.action;
        expect(readAction.parameters_disclosure).toBeUndefined();
      } finally {
        readStore.close();
      }
    });
  });
});
