/**
 * openclaw-agent-receipts — Agent Receipts plugin for OpenClaw (Flavor B)
 *
 * Under ADR-0010 Flavor B the daemon owns signing, hashing, chain state,
 * and storage. This plugin is a thin emitter: it classifies tool calls,
 * forwards frames to the daemon over AF_UNIX, and exposes read tools that
 * query the daemon's SQLite database directly.
 *
 * The daemon is required. If the socket is unreachable, events drop
 * silently (fire-and-forget) and a startup warning is logged.
 */

import { createConnection } from "node:net";
import { definePluginEntry } from "./openclaw-types.js";

import { resolveConfig } from "./config.js";
import { loadCustomMappings, DEFAULT_MAPPINGS, DEFAULT_PATTERNS } from "./classify.js";
import {
  beforeToolCall,
  afterToolCall,
  evictPendingForSession,
  type HookDeps,
  type PendingMap,
} from "./hooks.js";
import { Emitter, defaultSocketPath, DIAL_TIMEOUT_MS } from "./emitter.js";
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

    // OQ-C: warn if parameterDisclosure is configured — daemon controls this now.
    if (cfg.parameterDisclosure !== false) {
      api.logger.warn(
        "agent-receipts: parameterDisclosure config is ignored under daemon mode — " +
        "set --parameter-disclosure on the daemon instead",
      );
    }

    // All mutable state, scoped to this plugin instance
    const pending: PendingMap = new Map();
    let mappings = DEFAULT_MAPPINGS;
    let patterns = DEFAULT_PATTERNS;

    if (cfg.taxonomyPath) {
      const custom = loadCustomMappings(cfg.taxonomyPath);
      mappings = custom.mappings;
      patterns = custom.patterns;
      api.logger.info(`agent-receipts: loaded custom taxonomy from ${cfg.taxonomyPath}`);
    }

    // Construct the daemon emitter. The socket is dialled lazily so construction
    // cannot fail if the daemon is down at startup. An unreachable socket produces
    // silent per-emit drops (ADR-0010 fire-and-forget contract).
    const socketPath = defaultSocketPath();
    let emitter: Emitter | undefined;

    if (!socketPath) {
      api.logger.warn(
        "agent-receipts: no default socket path on this platform; set AGENTRECEIPTS_SOCKET. " +
        "Tool calls will not be recorded until a socket path is available.",
      );
    } else {
      try {
        emitter = new Emitter({
          socketPath,
          warnLog: (msg, attrs) =>
            api.logger.warn(`agent-receipts: ${msg} (${JSON.stringify(attrs)})`),
        });

        // Probe the socket once at startup for an early actionable warning.
        void new Promise<void>((resolve) => {
          let settled = false;
          const settle = (): void => {
            if (settled) return;
            settled = true;
            resolve();
          };
          const probe = createConnection({ path: socketPath });
          const timer = setTimeout(() => {
            probe.destroy();
            api.logger.warn(
              `agent-receipts: daemon socket unreachable at ${socketPath} (connection timed out)`,
            );
            api.logger.warn(
              "=> Install and start the daemon: https://github.com/agent-receipts/ar/tree/main/daemon",
            );
            settle();
          }, DIAL_TIMEOUT_MS);
          probe.once("connect", () => {
            clearTimeout(timer);
            probe.destroy();
            settle();
          });
          probe.once("error", (err) => {
            clearTimeout(timer);
            api.logger.warn(
              `agent-receipts: daemon socket unreachable at ${socketPath}: ${err.message}`,
            );
            api.logger.warn(
              "=> Install and start the daemon: https://github.com/agent-receipts/ar/tree/main/daemon",
            );
            settle();
          });
        });

        api.logger.info(
          `agent-receipts: emitter ready (socket=${socketPath}, session_id=${emitter.sessionId})`,
        );
      } catch (err) {
        api.logger.warn(`agent-receipts: emitter construction failed: ${String(err)}`);
      }
    }

    // Use a no-op emitter when none is available so HookDeps.emitter is always typed.
    const hookEmitter = emitter ?? { emit: async (): Promise<null> => null };

    const hookDeps: HookDeps = {
      agentId: api.id,
      logger: api.logger,
      pending,
      mappings,
      patterns,
      emitter: hookEmitter,
    };

    // --- Hooks ---

    api.on("session_start", (_event, ctx) => {
      const sessionKey = ctx.sessionKey ?? "default";
      const sessionId = ctx.sessionId;
      evictPendingForSession(pending, sessionKey, sessionId);
      api.logger.info(`agent-receipts: session started (${sessionKey})`);
    });

    api.on(
      "before_tool_call",
      (event, ctx) => {
        beforeToolCall(event, ctx, hookDeps);
      },
      { priority: 100 },
    );

    api.on("after_tool_call", async (event, ctx) => {
      try {
        await afterToolCall(event, ctx, hookDeps);
      } catch (err) {
        api.logger.warn(`agent-receipts: hook error: ${String(err)}`);
      }
    });

    // --- Tools ---

    const toolDeps = {
      daemonDbPath: cfg.daemonDbPath,
      daemonPublicKeyPath: cfg.daemonPublicKeyPath,
    };

    api.registerTool(createQueryReceiptsToolFactory(toolDeps), {
      name: "ar_query_receipts",
    });

    api.registerTool(createVerifyChainToolFactory(toolDeps), {
      name: "ar_verify_chain",
    });

    // --- Service: close emitter on shutdown ---

    api.registerService({
      id: "ar-receipts",
      async start() {},
      async stop() {
        emitter?.close();
        api.logger.info("agent-receipts: emitter closed");
      },
    });

    api.logger.info(
      `agent-receipts: plugin registered — tool calls will be forwarded to daemon at ${socketPath ?? "(no socket)"}`,
    );
  },
});
