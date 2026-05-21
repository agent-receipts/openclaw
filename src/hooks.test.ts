import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  beforeToolCall,
  afterToolCall,
  evictPendingForSession,
  type HookDeps,
} from "./hooks.js";
import { FakeEmitter, makeHookDeps, simulateToolCall } from "./test-helpers.js";

describe("hooks", () => {
  let deps: HookDeps;

  beforeEach(() => {
    deps = makeHookDeps();
  });

  // ---- beforeToolCall ----

  describe("beforeToolCall", () => {
    it("emits a 'pending' frame with tool name and serialised params", async () => {
      const emitter = new FakeEmitter();
      const d = makeHookDeps({ emitter });

      beforeToolCall(
        { toolName: "read_file", params: { path: "/a.txt" }, runId: "r1", toolCallId: "tc1" },
        { sessionKey: "s", sessionId: "sid" },
        d,
      );

      // Allow microtasks (emit is fire-and-forget promise)
      await new Promise((resolve) => setImmediate(resolve));

      expect(emitter.events).toHaveLength(1);
      const frame = emitter.events[0]!;
      expect(frame.tool.name).toBe("read_file");
      expect(frame.decision).toBe("pending");
      expect(frame.input).toBe(JSON.stringify({ path: "/a.txt" }));
      expect(frame.output).toBeUndefined();
    });

    it("stashes the call in the pending map", () => {
      beforeToolCall(
        { toolName: "read_file", params: { path: "/a.txt" }, runId: "r1", toolCallId: "tc1" },
        { sessionKey: "test-session", sessionId: "sid-1" },
        deps,
      );

      expect(deps.pending.has("r1:tc1")).toBe(true);
      expect(deps.pending.get("r1:tc1")?.toolName).toBe("read_file");
    });

    it("uses 'default' sessionKey when ctx.sessionKey is absent", () => {
      beforeToolCall(
        { toolName: "read_file", params: { path: "/a.txt" }, runId: "r1", toolCallId: "tc1" },
        {},
        deps,
      );
      expect(deps.pending.get("r1:tc1")?.sessionKey).toBe("default");
    });

    it("skips the emit and logs a warning when params are not JSON-serialisable", async () => {
      const emitter = new FakeEmitter();
      const warnings: string[] = [];
      const d = makeHookDeps({ emitter });
      d.logger = { info: () => {}, warn: (msg) => warnings.push(msg) };

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      beforeToolCall(
        { toolName: "read_file", params: cyclic, runId: "r1", toolCallId: "tc1" },
        { sessionKey: "s" },
        d,
      );

      await new Promise((resolve) => setImmediate(resolve));

      expect(emitter.events).toHaveLength(0);
      expect(warnings.some((w) => w.includes("emitter pre-call forward skipped"))).toBe(true);
    });
  });

  // ---- afterToolCall ----

  describe("afterToolCall", () => {
    it("emits an 'allowed' frame with tool name, input, and output", async () => {
      const emitter = new FakeEmitter();
      const d = makeHookDeps({ emitter });

      await simulateToolCall(d, "read_file", { path: "/a.txt" });

      // One frame from beforeToolCall (pending), one from afterToolCall (allowed)
      expect(emitter.events).toHaveLength(2);
      const post = emitter.events[1]!;
      expect(post.tool.name).toBe("read_file");
      expect(post.decision).toBe("allowed");
      expect(post.input).toBe(JSON.stringify({ path: "/a.txt" }));
      expect(post.output).toBe(JSON.stringify({ ok: true }));
      expect(post.error).toBeUndefined();
    });

    it("populates the 'error' field when the tool failed", async () => {
      const emitter = new FakeEmitter();
      const d = makeHookDeps({ emitter });

      await simulateToolCall(d, "read_file", { path: "/missing.txt" }, {
        error: "ENOENT: file not found",
      });

      const post = emitter.events.at(-1)!;
      // decision is the policy outcome — not changed by a tool runtime error
      expect(post.decision).toBe("allowed");
      expect(post.error).toBe("ENOENT: file not found");
    });

    it("uses params stashed by beforeToolCall when available", async () => {
      const emitter = new FakeEmitter();
      const d = makeHookDeps({ emitter });
      const stashedParams = { path: "/stashed.txt" };
      const differentParams = { path: "/different.txt" };

      beforeToolCall(
        { toolName: "read_file", params: stashedParams, runId: "r1", toolCallId: "tc1" },
        { sessionKey: "s", sessionId: "sid" },
        d,
      );

      await afterToolCall(
        { toolName: "read_file", params: differentParams, runId: "r1", toolCallId: "tc1", result: { ok: true } },
        { sessionKey: "s", sessionId: "sid" },
        d,
      );

      const post = emitter.events.at(-1)!;
      // Should use stashed params, not the ones passed to afterToolCall
      expect(post.input).toBe(JSON.stringify(stashedParams));
    });

    it("works without prior beforeToolCall (uses event params)", async () => {
      const emitter = new FakeEmitter();
      const d = makeHookDeps({ emitter });

      await afterToolCall(
        { toolName: "read_file", params: { path: "/orphan.txt" }, runId: "r-orphan", toolCallId: "tc-orphan", result: { ok: true } },
        { sessionKey: "s", sessionId: "sid" },
        d,
      );

      expect(emitter.events).toHaveLength(1);
      const post = emitter.events[0]!;
      expect(post.decision).toBe("allowed");
      expect(post.input).toBe(JSON.stringify({ path: "/orphan.txt" }));
    });

    it("does not crash when result contains a circular reference", async () => {
      const emitter = new FakeEmitter();
      const warnings: string[] = [];
      const d = makeHookDeps({ emitter });
      d.logger = { info: () => {}, warn: (msg) => warnings.push(msg) };

      const cyclic: Record<string, unknown> = {};
      cyclic.self = cyclic;

      await afterToolCall(
        { toolName: "read_file", params: { path: "/a.txt" }, runId: "r1", toolCallId: "tc1", result: cyclic },
        { sessionKey: "s", sessionId: "sid" },
        d,
      );

      // The post-call emit is skipped with a warning
      expect(emitter.events).toHaveLength(0);
      expect(warnings.some((w) => w.includes("emitter post-call forward skipped"))).toBe(true);
    });
  });

  // ---- emitter error handling ----

  describe("emitter error handling", () => {
    it("absorbs an emitter that returns an Error (fire-and-forget)", async () => {
      const emitter = new FakeEmitter();
      emitter.emitImpl = (): Error => new Error("daemon down");
      const d = makeHookDeps({ emitter });

      // Even though emit() resolves to an Error, hooks must not throw
      await simulateToolCall(d, "read_file", { path: "/a.txt" });

      expect(emitter.events).toHaveLength(2);
    });

    it("does not produce an unhandled rejection if a custom emitter rejects", async () => {
      const rejecting = {
        emit: (): Promise<Error | null> =>
          Promise.reject(new Error("custom emitter rejected")),
      };
      const d = makeHookDeps({ emitter: rejecting });

      const unhandled: unknown[] = [];
      const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
      process.on("unhandledRejection", onUnhandled);
      try {
        await simulateToolCall(d, "read_file", { path: "/a.txt" });
        await new Promise((resolve) => setImmediate(resolve));
      } finally {
        process.off("unhandledRejection", onUnhandled);
      }

      expect(unhandled).toHaveLength(0);
    });
  });

  // ---- evictPendingForSession ----

  describe("evictPendingForSession", () => {
    it("only removes entries for the matching session", () => {
      beforeToolCall(
        { toolName: "read_file", params: { path: "/a.txt" }, runId: "rA", toolCallId: "tcA" },
        { sessionKey: "session-A", sessionId: "sid-A" },
        deps,
      );
      beforeToolCall(
        { toolName: "read_file", params: { path: "/b.txt" }, runId: "rB", toolCallId: "tcB" },
        { sessionKey: "session-B", sessionId: "sid-B" },
        deps,
      );

      evictPendingForSession(deps.pending, "session-B", "sid-B");

      expect(deps.pending.has("rA:tcA")).toBe(true);
      expect(deps.pending.has("rB:tcB")).toBe(false);
    });

    it("distinguishes sessions sharing a sessionKey by sessionId", () => {
      beforeToolCall(
        { toolName: "read_file", params: { path: "/a.txt" }, runId: "r1", toolCallId: "tc1" },
        { sessionKey: "default", sessionId: "sid-A" },
        deps,
      );
      beforeToolCall(
        { toolName: "read_file", params: { path: "/b.txt" }, runId: "r2", toolCallId: "tc2" },
        { sessionKey: "default", sessionId: "sid-B" },
        deps,
      );

      evictPendingForSession(deps.pending, "default", "sid-B");

      expect(deps.pending.has("r1:tc1")).toBe(true);
      expect(deps.pending.has("r2:tc2")).toBe(false);
    });

    it("matches undefined sessionId only to undefined", () => {
      beforeToolCall(
        { toolName: "read_file", params: { path: "/a.txt" }, runId: "r1", toolCallId: "tc1" },
        { sessionKey: "default" },
        deps,
      );
      beforeToolCall(
        { toolName: "read_file", params: { path: "/b.txt" }, runId: "r2", toolCallId: "tc2" },
        { sessionKey: "default", sessionId: "sid-B" },
        deps,
      );

      evictPendingForSession(deps.pending, "default", undefined);

      expect(deps.pending.has("r1:tc1")).toBe(false);
      expect(deps.pending.has("r2:tc2")).toBe(true);
    });
  });

  afterEach(() => {
    deps.pending.clear();
  });
});
