import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  openStore,
  verifyChain,
  canonicalize,
  sha256,
  type ReceiptStore,
} from "@attest-protocol/attest-ts";
import { beforeToolCall, afterToolCall } from "./hooks.js";
import { makeHookDeps, simulateToolCall } from "./test-helpers.js";
import { resetChain } from "./chain.js";

describe("hooks", () => {
  let store: ReceiptStore;
  let deps: ReturnType<typeof makeHookDeps>;

  beforeEach(() => {
    store = openStore(":memory:");
    deps = makeHookDeps(store);
  });

  afterEach(() => {
    store.close();
    resetChain("test-session", "sid-1");
    resetChain("default");
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
      expect(chain[0]!.credentialSubject.outcome.status).toBe("success");
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
});
