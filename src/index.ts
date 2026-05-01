/**
 * openclaw-agent-receipts — Agent Receipts plugin for OpenClaw
 *
 * Generates cryptographically signed, hash-linked action receipts
 * for every tool call the agent makes, creating a tamper-evident
 * audit trail using the Agent Receipts TypeScript SDK.
 */

import { dirname } from "node:path";
import { mkdirSync } from "node:fs";
import { definePluginEntry } from "./openclaw-types.js";
import { openStore } from "@agnt-rcpt/sdk-ts";

import { resolveConfig, loadOrCreateKeys } from "./config.js";
import { loadCustomMappings, DEFAULT_MAPPINGS, DEFAULT_PATTERNS } from "./classify.js";
import {
  beforeToolCall,
  afterToolCall,
  evictPendingForSession,
  type HookDeps,
  type PendingMap,
} from "./hooks.js";
import { resetChain, getChainId, type ChainsMap, type ChainState } from "./chain.js";
import { createQueryReceiptsToolFactory, createVerifyChainToolFactory } from "./tools.js";

export default definePluginEntry({
  id: "openclaw-agent-receipts",
  name: "Agent Receipts",
  description: "Cryptographically signed audit trail for agent actions",

  register(api) {
    const cfg = resolveConfig(api.pluginConfig);

    if (!cfg.enabled) {
      api.logger.info("agent-receipts: plugin disabled via config");
      return;
    }

    // All mutable state lives here, scoped to this plugin instance
    const chains: ChainsMap = new Map<string, ChainState>();
    const pending: PendingMap = new Map();
    let mappings = DEFAULT_MAPPINGS;
    let patterns = DEFAULT_PATTERNS;

    if (cfg.taxonomyPath) {
      const custom = loadCustomMappings(cfg.taxonomyPath);
      mappings = custom.mappings;
      patterns = custom.patterns;
      api.logger.info(`agent-receipts: loaded custom taxonomy from ${cfg.taxonomyPath}`);
    }

    // Init signing keys (generate on first run)
    const keys = loadOrCreateKeys(cfg.keyPath);
    api.logger.info(`agent-receipts: keys loaded from ${cfg.keyPath}`);

    // Open receipt store
    mkdirSync(dirname(cfg.dbPath), { recursive: true });
    const store = openStore(cfg.dbPath);
    api.logger.info(`agent-receipts: receipt store opened at ${cfg.dbPath}`);

    const agentId = api.id;

    const hookDeps: HookDeps = {
      store,
      privateKey: keys.privateKey,
      verificationMethod: keys.verificationMethod,
      agentId,
      logger: api.logger,
      pending,
      chains,
      mappings,
      patterns,
      parameterDisclosure: cfg.parameterDisclosure,
    };

    // --- Hooks ---

    // Reset chain and clear pending stash on new session
    api.on("session_start", (_event, ctx) => {
      const sessionKey = ctx.sessionKey ?? "default";
      const sessionId = ctx.sessionId;
      resetChain(chains, sessionKey, sessionId);
      evictPendingForSession(pending, sessionKey, sessionId);
      api.logger.info(`agent-receipts: new chain for session ${sessionKey}`);
    });

    // Capture tool call context before execution
    api.on(
      "before_tool_call",
      (event, ctx) => {
        beforeToolCall(event, ctx, hookDeps);
      },
      { priority: 100 }, // Run early to capture timing
    );

    // Create receipt after tool execution
    api.on("after_tool_call", async (event, ctx) => {
      try {
        await afterToolCall(event, ctx, hookDeps);
      } catch (err) {
        api.logger.warn(`agent-receipts: receipt creation failed: ${String(err)}`);
      }
    });

    // --- Tools ---

    const toolDeps = {
      store,
      publicKey: keys.publicKey,
      getChainId: (sessionKey: string, sessionId?: string) =>
        getChainId(chains, sessionKey, sessionId),
    };

    // Register as factory functions (OpenClawPluginToolFactory pattern)
    api.registerTool(createQueryReceiptsToolFactory(toolDeps), {
      name: "ar_query_receipts",
    });

    api.registerTool(createVerifyChainToolFactory(toolDeps), {
      name: "ar_verify_chain",
    });

    // --- Service: clean up store on shutdown ---

    api.registerService({
      id: "ar-store",
      async start() {
        // Store is already opened during register — nothing to do
      },
      async stop() {
        store.close();
        api.logger.info("agent-receipts: receipt store closed");
      },
    });

    api.logger.info("agent-receipts: plugin registered — receipts will be generated for all tool calls");
  },
});
