import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openStore,
  verifyChain,
  verifyStoredChain,
  hashReceipt,
  canonicalize,
  sha256,
  type ReceiptStore,
} from "@agnt-rcpt/sdk-ts";
import {
  beforeToolCall,
  afterToolCall,
  evictPendingForSession,
  shouldDisclose,
  extractDisclosure,
} from "./hooks.js";
import { makeHookDeps, simulateToolCall } from "./test-helpers.js";

describe("hooks", () => {
  let store: ReceiptStore;
  let deps: ReturnType<typeof makeHookDeps>;

  beforeEach(() => {
    store = openStore(":memory:");
    deps = makeHookDeps(store);
  });

  afterEach(() => {
    store.close();
  });

  describe("beforeToolCall + afterToolCall lifecycle", () => {
    it("creates a valid signed receipt", async () => {
      await simulateToolCall(deps, "read_file", { path: "/test.txt" });

      const stats = store.stats();
      expect(stats.total).toBe(1);

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      expect(chain).toHaveLength(1);

      const receipt = chain[0]!;
      expect(receipt.id).toMatch(/^urn:receipt:/);
      expect(receipt.proof).toBeDefined();
      expect(receipt.proof.type).toBe("Ed25519Signature2020");
    });

    it("sets correct issuer and principal DIDs", async () => {
      await simulateToolCall(deps, "read_file", { path: "/test.txt" });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      const receipt = chain[0]!;

      expect(receipt.issuer.id).toBe("did:openclaw:test-agent");
      expect(receipt.credentialSubject.principal.id).toBe("did:session:test-session");
    });

    it("classifies action type and risk level", async () => {
      await simulateToolCall(deps, "delete_file", { path: "/important.txt" });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      const action = chain[0]!.credentialSubject.action;

      expect(action.type).toBe("filesystem.file.delete");
      expect(action.risk_level).toBe("high");
    });

    it("sets target to the tool name", async () => {
      await simulateToolCall(deps, "run_command", { cmd: "ls" });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      const target = chain[0]!.credentialSubject.action.target;

      expect(target?.system).toBe("openclaw");
      expect(target?.resource).toBe("run_command");
    });

    it("hashes params correctly", async () => {
      const params = { path: "/test.txt", encoding: "utf-8" };
      await simulateToolCall(deps, "read_file", params);

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      const expected = sha256(canonicalize(params));

      expect(chain[0]!.credentialSubject.action.parameters_hash).toBe(expected);
    });

    it("sets success outcome when no error", async () => {
      await simulateToolCall(deps, "read_file", { path: "/test.txt" });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      const outcome = chain[0]!.credentialSubject.outcome;

      expect(outcome.status).toBe("success");
      // RFC 8785 canonicalize rejects undefined values, so the success path must
      // omit the `error` key entirely rather than emit `error: undefined`.
      expect("error" in outcome).toBe(false);
    });

    it("sets failure outcome when error is present", async () => {
      await simulateToolCall(deps, "read_file", { path: "/missing.txt" }, {
        error: "ENOENT: file not found",
      });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      const outcome = chain[0]!.credentialSubject.outcome;

      expect(outcome.status).toBe("failure");
      expect(outcome.error).toBe("ENOENT: file not found");
    });
  });

  describe("chain integrity", () => {
    it("advances chain after receipt creation", async () => {
      await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });
      await simulateToolCall(deps, "write_file", { path: "/b.txt" }, { toolCallId: "tc-2" });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      expect(chain).toHaveLength(2);
      expect(chain[0]!.credentialSubject.chain.sequence).toBe(1);
      expect(chain[1]!.credentialSubject.chain.sequence).toBe(2);
    });

    it("first receipt has null previous_receipt_hash", async () => {
      await simulateToolCall(deps, "read_file", { path: "/a.txt" });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      expect(chain[0]!.credentialSubject.chain.previous_receipt_hash).toBeNull();
    });

    it("subsequent receipts link to previous hash", async () => {
      await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });
      await simulateToolCall(deps, "write_file", { path: "/b.txt" }, { toolCallId: "tc-2" });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      expect(chain[1]!.credentialSubject.chain.previous_receipt_hash).toMatch(/^sha256:/);
      expect(chain[1]!.credentialSubject.chain.previous_receipt_hash).not.toBeNull();
    });

    it("multiple sequential calls produce a verifiable chain", async () => {
      for (let i = 0; i < 5; i++) {
        await simulateToolCall(
          deps,
          "read_file",
          { path: `/file-${i}.txt` },
          { toolCallId: `tc-${i}` },
        );
      }

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      expect(chain).toHaveLength(5);

      const verification = verifyChain(chain, deps.publicKey);
      expect(verification.valid).toBe(true);
      expect(verification.length).toBe(5);
    });
  });

  describe("edge cases", () => {
    it("works without prior beforeToolCall (no stashed data)", async () => {
      // Call afterToolCall directly without beforeToolCall
      await afterToolCall(
        {
          toolName: "read_file",
          params: { path: "/test.txt" },
          runId: "run-orphan",
          toolCallId: "tc-orphan",
        },
        { sessionKey: "test-session", sessionId: "sid-1" },
        deps,
      );

      const stats = store.stats();
      expect(stats.total).toBe(1);
    });

    it("uses unknown classification for unmapped tools", async () => {
      await simulateToolCall(deps, "custom_obscure_tool", { x: 1 });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      expect(chain[0]!.credentialSubject.action.type).toBe("unknown");
    });
  });

  describe("chain recovery after plugin restart", () => {
    it("resumes sequence and links chain correctly after in-memory state is lost", async () => {
      // Populate the store with two receipts
      await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });
      await simulateToolCall(deps, "read_file", { path: "/b.txt" }, { toolCallId: "tc-2" });

      // Simulate restart: same key reloaded from disk, in-memory chain state wiped
      deps.chains.clear();

      // Before this fix: threw UNIQUE constraint failed (receipts.chain_id, receipts.sequence)
      await simulateToolCall(deps, "read_file", { path: "/c.txt" }, { toolCallId: "tc-3" });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      expect(chain).toHaveLength(3);
      expect(chain[2]!.credentialSubject.chain.sequence).toBe(3);
      expect(chain[2]!.credentialSubject.chain.previous_receipt_hash).toBe(hashReceipt(chain[1]!));

      // All three receipts form a valid cryptographic chain under the same key
      const verification = verifyChain(chain, deps.publicKey);
      expect(verification.valid).toBe(true);
      expect(verification.length).toBe(3);
    });

    it("does not re-trigger recovery on calls after the first post-restart call", async () => {
      await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });
      deps.chains.clear();
      await simulateToolCall(deps, "read_file", { path: "/b.txt" }, { toolCallId: "tc-2" });
      await simulateToolCall(deps, "read_file", { path: "/c.txt" }, { toolCallId: "tc-3" });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      expect(chain).toHaveLength(3);
      expect(chain[2]!.credentialSubject.chain.sequence).toBe(3);
    });

    it("starts at sequence 1 when the store has no prior receipts for the chain", async () => {
      // Fresh store, fresh chains map — recovery should be a no-op
      await simulateToolCall(deps, "read_file", { path: "/a.txt" });

      const chain = store.getChain("chain_openclaw_test-session_sid-1");
      expect(chain).toHaveLength(1);
      expect(chain[0]!.credentialSubject.chain.sequence).toBe(1);
      expect(chain[0]!.credentialSubject.chain.previous_receipt_hash).toBeNull();
    });

    it("verifyStoredChain passes after recovery (exercises the production code path)", async () => {
      await simulateToolCall(deps, "read_file", { path: "/a.txt" }, { toolCallId: "tc-1" });
      await simulateToolCall(deps, "write_file", { path: "/b.txt" }, { toolCallId: "tc-2" });

      deps.chains.clear();

      await simulateToolCall(deps, "delete_file", { path: "/c.txt" }, { toolCallId: "tc-3" });

      const chainId = "chain_openclaw_test-session_sid-1";
      const result = verifyStoredChain(store, chainId, deps.publicKey);
      expect(result.valid).toBe(true);
      expect(result.length).toBe(3);
    });
  });

  describe("pending stash", () => {
    it("clearing pending stash does not break receipt creation", async () => {
      // Stash a call without completing it
      beforeToolCall(
        { toolName: "read_file", params: { path: "/a.txt" }, runId: "run-1", toolCallId: "tc-stale" },
        { sessionKey: "test-session" },
        deps,
      );

      deps.pending.clear();

      // After clearing, afterToolCall should still work (falls back to re-hashing params)
      await afterToolCall(
        {
          toolName: "read_file",
          params: { path: "/a.txt" },
          runId: "run-1",
          toolCallId: "tc-stale",
        },
        { sessionKey: "test-session", sessionId: "sid-1" },
        deps,
      );

      // Receipt was created even without stashed data
      expect(store.stats().total).toBe(1);
    });

    it("evictPendingForSession only removes entries for the matching session", () => {
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

    it("evictPendingForSession distinguishes sessions sharing a sessionKey by sessionId", () => {
      // Two sessions under the same sessionKey but different sessionIds —
      // the chain state in chain.ts is keyed by (sessionKey, sessionId), so
      // pending eviction must match both fields, not just sessionKey.
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

    it("evictPendingForSession matches undefined sessionId only to undefined", () => {
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

    it("falls back to 'default' sessionKey when ctx.sessionKey is absent", () => {
      beforeToolCall(
        { toolName: "read_file", params: { path: "/a.txt" }, runId: "r1", toolCallId: "tc1" },
        {},
        deps,
      );
      expect(deps.pending.get("r1:tc1")?.sessionKey).toBe("default");
    });
  });
});

describe("shouldDisclose", () => {
  it("returns false when config is undefined", () => {
    expect(shouldDisclose(undefined, "high", "system.command.execute")).toBe(false);
  });

  it("returns false when config is false", () => {
    expect(shouldDisclose(false, "high", "system.command.execute")).toBe(false);
  });

  it("returns true when config is true for any risk or action type", () => {
    expect(shouldDisclose(true, "low", "filesystem.file.read")).toBe(true);
    expect(shouldDisclose(true, "critical", "system.command.execute")).toBe(true);
  });

  it("returns true for high and critical risk when config is 'high'", () => {
    expect(shouldDisclose("high", "high", "system.command.execute")).toBe(true);
    expect(shouldDisclose("high", "critical", "system.command.execute")).toBe(true);
  });

  it("returns false for low and medium risk when config is 'high'", () => {
    expect(shouldDisclose("high", "low", "filesystem.file.read")).toBe(false);
    expect(shouldDisclose("high", "medium", "filesystem.file.read")).toBe(false);
  });

  it("returns true when action type is in the allowlist array", () => {
    expect(shouldDisclose(["system.command.execute"], "high", "system.command.execute")).toBe(true);
  });

  it("returns false when action type is not in the allowlist array", () => {
    expect(shouldDisclose(["system.command.execute"], "high", "filesystem.file.read")).toBe(false);
  });
});

describe("extractDisclosure", () => {
  it("returns the first matching field when it is present", () => {
    const result = extractDisclosure({ command: "ls -la", cmd: "ignored" }, ["command", "cmd"]);
    expect(result).toEqual({ command: "ls -la" });
  });

  it("falls back to the next field when the first is absent", () => {
    const result = extractDisclosure({ cmd: "ls -la" }, ["command", "cmd"]);
    expect(result).toEqual({ cmd: "ls -la" });
  });

  it("returns undefined when no fields match", () => {
    const result = extractDisclosure({ other: "value" }, ["command", "cmd"]);
    expect(result).toBeUndefined();
  });

  it("returns undefined for empty fields array", () => {
    const result = extractDisclosure({ command: "ls" }, []);
    expect(result).toBeUndefined();
  });

  it("stringifies non-string values via JSON.stringify", () => {
    const result = extractDisclosure({ timeout: 30 }, ["timeout"]);
    expect(result).toEqual({ timeout: "30" });
  });

  it("stringifies array and object values", () => {
    expect(extractDisclosure({ args: ["a", "b"] }, ["args"])).toEqual({ args: '["a","b"]' });
    expect(extractDisclosure({ meta: { key: 1 } }, ["meta"])).toEqual({ meta: '{"key":1}' });
  });

  it("skips null field values and falls back to next field", () => {
    const result = extractDisclosure({ command: null, cmd: undefined, script: "echo hi" }, ["command", "cmd", "script"]);
    expect(result).toEqual({ script: "echo hi" });
  });

  it("treats empty string as a valid value", () => {
    const result = extractDisclosure({ command: "" }, ["command"]);
    expect(result).toEqual({ command: "" });
  });
});
