/**
 * openclaw-attest — Attest Protocol plugin for OpenClaw
 *
 * Generates cryptographically signed, hash-linked action receipts
 * for every tool call the agent makes, creating a tamper-evident
 * audit trail using the Attest Protocol TypeScript SDK.
 */

import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { definePluginEntry } from "./openclaw-types.js";
import { openStore } from "@attest-protocol/attest-ts";

import { resolveConfig, loadOrCreateKeys } from "./config.js";
import { loadCustomMappings } from "./classify.js";
import { beforeToolCall, afterToolCall, type HookDeps } from "./hooks.js";
import { resetChain, getChainId } from "./chain.js";
import { createQueryReceiptsTool, createVerifyChainTool } from "./tools.js";

export default definePluginEntry({
  id: "openclaw-attest",
  name: "Attest Protocol",
  description: "Cryptographically signed audit trail for agent actions",

  register(api) {
    const cfg = resolveConfig(api.pluginConfig);

    if (!cfg.enabled) {
      api.logger.info("attest: plugin disabled via config");
      return;
    }

    // Load custom taxonomy if provided
    if (cfg.taxonomyPath) {
      loadCustomMappings(cfg.taxonomyPath);
      api.logger.info(`attest: loaded custom taxonomy from ${cfg.taxonomyPath}`);
    }

    // Init signing keys (generate on first run)
    const keys = loadOrCreateKeys(cfg.keyPath);
    api.logger.info(`attest: keys loaded from ${cfg.keyPath}`);

    // Open receipt store
    mkdirSync(dirname(cfg.dbPath), { recursive: true });
    const store = openStore(cfg.dbPath);
    api.logger.info(`attest: receipt store opened at ${cfg.dbPath}`);

    const agentId = api.id;

    const hookDeps: HookDeps = {
      store,
      privateKey: keys.privateKey,
      verificationMethod: keys.verificationMethod,
      agentId,
      logger: api.logger,
    };

    // --- Hooks ---

    // Reset chain on new session
    api.on("session_start", (_event, ctx) => {
      const sessionKey = ctx.sessionKey ?? "default";
      const sessionId = ctx.sessionId;
      resetChain(sessionKey, sessionId);
      api.logger.info(`attest: new chain for session ${sessionKey}`);
    });

    // Capture tool call context before execution
    api.on(
      "before_tool_call",
      (event, ctx) => {
        beforeToolCall(event, ctx);
      },
      { priority: 100 }, // Run early to capture timing
    );

    // Create receipt after tool execution
    api.on("after_tool_call", async (event, ctx) => {
      try {
        await afterToolCall(event, ctx, hookDeps);
      } catch (err) {
        api.logger.warn(`attest: receipt creation failed: ${String(err)}`);
      }
    });

    // --- Tools ---

    const toolDeps = {
      store,
      publicKey: keys.publicKey,
      getChainId,
    };

    api.registerTool(createQueryReceiptsTool(toolDeps), {
      name: "attest_query_receipts",
    });

    api.registerTool(createVerifyChainTool(toolDeps), {
      name: "attest_verify_chain",
    });

    // --- Service: clean up store on shutdown ---

    api.registerService({
      name: "attest-store",
      async stop() {
        store.close();
        api.logger.info("attest: receipt store closed");
      },
    });

    api.logger.info("attest: plugin registered — receipts will be generated for all tool calls");
  },
});
