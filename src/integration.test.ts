/**
 * Integration smoke test — exercises the full plugin lifecycle
 * through index.ts register(), the same code path OpenClaw uses at runtime.
 *
 * Builds a mock OpenClawPluginApi, calls register(), then drives
 * session_start → tool calls → query → shutdown.
 *
 * Under Flavor B (ADR-0010), the plugin is a thin emitter — it does NOT
 * create receipts in-process. Receipts are created by the daemon. Tests that
 * need to verify tool read behaviour pre-populate a SQLite file directly,
 * then point the plugin at it via daemonDbPath.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import {
  openStore,
  generateKeyPair,
  createReceipt,
  signReceipt,
  hashReceipt,
  type ReceiptStore,
} from "@agnt-rcpt/sdk-ts";
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

/** Insert a signed receipt directly into a ReceiptStore. Returns the receipt hash. */
function insertReceiptAt(
  store: ReceiptStore,
  privateKey: string,
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
  const signed = signReceipt(unsigned, privateKey, "did:openclaw:test-agent#key-1");
  const h = hashReceipt(signed);
  store.insert(signed, h);
  return h;
}

// ---- Tests ----

describe("integration: full plugin lifecycle", () => {
  let tempDir: string;
  let teardown: (() => Promise<void>) | undefined;

  beforeEach(() => {
    tempDir = join(tmpdir(), `ar-integration-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
  });

  afterEach(async () => {
    if (teardown) {
      await teardown();
      teardown = undefined;
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  function setupPlugin(configOverrides?: Record<string, unknown>) {
    const mock = createMockApi(configOverrides);
    plugin.register(mock.api);

    teardown = async () => {
      for (const svc of mock.services) {
        await svc.stop?.();
      }
    };

    return mock;
  }

  it("register() wires hooks, tools, and service", () => {
    const { hooks, tools, services, logs } = setupPlugin();

    expect(hooks.has("session_start")).toBe(true);
    expect(hooks.has("before_tool_call")).toBe(true);
    expect(hooks.has("after_tool_call")).toBe(true);

    expect(tools.has("ar_query_receipts")).toBe(true);
    expect(tools.has("ar_verify_chain")).toBe(true);

    expect(services).toHaveLength(1);
    expect(services[0].id).toBe("ar-store");

    expect(logs.some((l) => l.includes("plugin registered"))).toBe(true);
  });

  it("enabled: false skips registration entirely", () => {
    const { hooks, tools, services, logs } = setupPlugin({ enabled: false });

    expect(hooks.size).toBe(0);
    expect(tools.size).toBe(0);
    expect(services).toHaveLength(0);
    expect(logs.some((l) => l.includes("plugin disabled"))).toBe(true);
  });

  it("logs a warning when the daemon socket is unreachable", async () => {
    const missingSocket = join(tempDir, `absent-${randomUUID()}.sock`);
    const saved = process.env.AGENTRECEIPTS_SOCKET;
    process.env.AGENTRECEIPTS_SOCKET = missingSocket;
    try {
      const { logs } = setupPlugin();

      // The probe is fire-and-forget; wait for it to settle.
      await new Promise((resolve) => setTimeout(resolve, 200));

      const warnLogs = logs.filter((l) => l.startsWith("WARN:"));
      expect(warnLogs.some((l) => l.includes("socket unreachable") && l.includes(missingSocket))).toBe(true);
      expect(warnLogs.some((l) => l.includes("Install and start the daemon"))).toBe(true);
      // Emitter is still constructed and "ready" is logged synchronously before the probe settles
      expect(logs.some((l) => l.includes("emitter ready"))).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.AGENTRECEIPTS_SOCKET;
      else process.env.AGENTRECEIPTS_SOCKET = saved;
    }
  });

  it("ar_query_receipts reads receipts from the configured daemon DB", async () => {
    const dbPath = join(tempDir, "receipts.db");
    const { publicKey, privateKey } = generateKeyPair();
    const pubKeyPath = join(tempDir, "signing.key.pub");
    writeFileSync(pubKeyPath, publicKey);

    // Pre-populate the DB before plugin registration (mimics daemon having written receipts)
    const wStore = openStore(dbPath);
    const h1 = insertReceiptAt(wStore, privateKey, {
      seq: 1, chainId: "chain-int", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null, actionType: "filesystem.file.read",
    });
    insertReceiptAt(wStore, privateKey, {
      seq: 2, chainId: "chain-int", timestamp: "2024-01-01T11:00:00.000Z", previousHash: h1, actionType: "filesystem.file.delete",
    });
    wStore.close();

    const { tools } = setupPlugin({ daemonDbPath: dbPath, daemonPublicKeyPath: pubKeyPath });

    const queryTool = tools.get("ar_query_receipts")!.definition;
    const result = await queryTool.execute("q", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.total_receipts).toBe(2);
    expect(data.results).toHaveLength(2);
    // Newest-first ordering
    expect(data.results[0].action).toBe("filesystem.file.delete");
    expect(data.results[1].action).toBe("filesystem.file.read");
  });

  it("ar_verify_chain verifies the daemon chain using the configured public key", async () => {
    const dbPath = join(tempDir, "receipts.db");
    const { publicKey, privateKey } = generateKeyPair();
    const pubKeyPath = join(tempDir, "signing.key.pub");
    writeFileSync(pubKeyPath, publicKey);

    const wStore = openStore(dbPath);
    const h1 = insertReceiptAt(wStore, privateKey, { seq: 1, chainId: "chain-verify", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });
    const h2 = insertReceiptAt(wStore, privateKey, { seq: 2, chainId: "chain-verify", timestamp: "2024-01-01T11:00:00.000Z", previousHash: h1 });
    insertReceiptAt(wStore, privateKey, { seq: 3, chainId: "chain-verify", timestamp: "2024-01-01T12:00:00.000Z", previousHash: h2 });
    wStore.close();

    const { tools } = setupPlugin({ daemonDbPath: dbPath, daemonPublicKeyPath: pubKeyPath });

    // Resolve the factory with session context (OpenClaw runtime pattern)
    const verifyFactory = tools.get("ar_verify_chain")!.factory!;
    const verifyTool = verifyFactory({ sessionKey: "main", sessionId: "sid-1" });
    const result = await verifyTool.execute("v", { chain_id: "chain-verify" });

    expect(result.content[0].text).toContain("is valid");
    expect(result.content[0].text).toContain("3 receipts");
    const data = JSON.parse(result.content[1].text);
    expect(data.valid).toBe(true);
    expect(data.length).toBe(3);
    for (const r of data.receipts) {
      expect(r.signature_valid).toBe(true);
      expect(r.hash_link_valid).toBe(true);
    }
  });

  it("session_start hook fires without throwing and logs the session", async () => {
    const { hooks, logs } = setupPlugin();

    await fireHook(hooks, "session_start", {}, { sessionKey: "my-session", sessionId: "sid-1" });

    expect(logs.some((l) => l.includes("session started") && l.includes("my-session"))).toBe(true);
  });

  it("before/after hooks fire without throwing even when the daemon is absent", async () => {
    const { hooks } = setupPlugin();

    const event = { toolName: "read_file", params: { path: "/a.txt" }, runId: "r1", toolCallId: "tc1" };
    const ctx = { sessionKey: "s", sessionId: "sid" };

    await expect(fireHook(hooks, "before_tool_call", event, ctx)).resolves.not.toThrow();
    await expect(fireHook(hooks, "after_tool_call", { ...event, result: { ok: true } }, ctx)).resolves.not.toThrow();
  });

  it("parameterDisclosure config logs a warning that the daemon controls disclosure", () => {
    const { logs } = setupPlugin({ parameterDisclosure: "high" });

    const warnLogs = logs.filter((l) => l.startsWith("WARN:"));
    expect(warnLogs.some((l) => l.includes("parameterDisclosure") && l.includes("ignored under daemon mode"))).toBe(true);
  });
});
