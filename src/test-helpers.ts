/**
 * Shared test utilities for openclaw-agent-receipts tests.
 */

import { beforeToolCall, afterToolCall, type EmitterLike, type HookDeps, type PendingMap } from "./hooks.js";
import { DEFAULT_MAPPINGS, DEFAULT_PATTERNS } from "./classify.js";
import type { EmitEvent } from "./emitter.js";

/**
 * Test double for the daemon emitter. Records every call and lets tests
 * inject failures (returning an Error or throwing) without spinning up an
 * actual AF_UNIX server. Structurally satisfies EmitterLike.
 *
 * Mirrors the real Emitter contract: emit() never rejects. A synchronous
 * throw from emitImpl is caught and surfaced as a returned Error so the
 * hook path's `.catch` is purely defensive and tests can't accidentally
 * leak unhandled rejections.
 */
export class FakeEmitter implements EmitterLike {
  readonly events: EmitEvent[] = [];
  emitImpl: (ev: EmitEvent) => Promise<Error | null> | Error | null =
    () => null;

  async emit(ev: EmitEvent): Promise<Error | null> {
    this.events.push(ev);
    try {
      return await this.emitImpl(ev);
    } catch (err) {
      return err instanceof Error ? err : new Error(String(err));
    }
  }
}

/**
 * Create HookDeps with a FakeEmitter and isolated state.
 * Each call creates fresh pending — no shared module state.
 * Mappings use the shared immutable DEFAULT_MAPPINGS.
 *
 * Pass `overrides.emitter` to inject a custom emitter (e.g. one with
 * `emitImpl` wired for failure scenarios). Access the default FakeEmitter
 * via `deps.emitter as FakeEmitter` when no override is given.
 */
export function makeHookDeps(overrides?: { emitter?: EmitterLike }): HookDeps {
  const pending: PendingMap = new Map();
  return {
    agentId: "test-agent",
    logger: {
      info: () => {},
      warn: () => {},
    },
    pending,
    mappings: DEFAULT_MAPPINGS,
    patterns: DEFAULT_PATTERNS,
    emitter: overrides?.emitter ?? new FakeEmitter(),
  };
}

/**
 * Simulate a complete tool call lifecycle (before + after).
 */
export async function simulateToolCall(
  deps: HookDeps,
  toolName: string,
  params: Record<string, unknown>,
  opts?: {
    runId?: string;
    toolCallId?: string;
    sessionKey?: string;
    sessionId?: string;
    error?: string;
    result?: unknown;
  },
): Promise<void> {
  const runId = opts?.runId ?? "run-1";
  const toolCallId = opts?.toolCallId ?? `tc-${Date.now()}`;
  const ctx = {
    sessionKey: opts?.sessionKey ?? "test-session",
    sessionId: opts?.sessionId ?? "sid-1",
  };

  beforeToolCall(
    { toolName, params, runId, toolCallId },
    ctx,
    deps,
  );

  await afterToolCall(
    {
      toolName,
      params,
      runId,
      toolCallId,
      result: opts?.error ? undefined : (opts?.result ?? { ok: true }),
      error: opts?.error,
    },
    { agentId: deps.agentId, ...ctx },
    deps,
  );
}
