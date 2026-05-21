/**
 * OpenClaw lifecycle hook handlers.
 *
 * Under Flavor B (ADR-0010), the daemon owns signing, hashing, chain state,
 * and storage. The plugin's only responsibilities are:
 *   1. Classify each tool call and log it.
 *   2. Emit a frame to the daemon via the emitter (before + after).
 *
 * All mutable state (pending map) is passed via HookDeps — no module-level
 * singletons — so multiple plugin instances are safe.
 */

import { classify, type ExtendedTaxonomyMapping, type TaxonomyPattern } from "./classify.js";
import type { EmitEvent } from "./emitter.js";

/**
 * Minimal structural interface the hook code uses from the daemon emitter.
 * Defined here so test doubles are assignable without the concrete Emitter class.
 */
export interface EmitterLike {
  emit(ev: EmitEvent): Promise<Error | null>;
}

export type PendingCall = {
  toolName: string;
  params: Record<string, unknown>;
  startedAt: string;
  sessionKey: string;
  sessionId?: string;
};

export type PendingMap = Map<string, PendingCall>;

const PENDING_MAX_AGE_MS = 5 * 60 * 1000; // 5 minutes
const PENDING_MAX_SIZE = 1000;

function callKey(runId?: string, toolCallId?: string): string {
  return `${runId ?? "unknown"}:${toolCallId ?? "unknown"}`;
}

export type HookDeps = {
  agentId: string;
  logger: { info: (msg: string) => void; warn: (msg: string) => void };
  pending: PendingMap;
  mappings: ExtendedTaxonomyMapping[];
  patterns: TaxonomyPattern[];
  emitter: EmitterLike;
};

/**
 * Evict stale entries from the pending map to prevent memory leaks
 * when afterToolCall is never called (e.g. tool crash).
 */
function evictStalePending(pending: PendingMap): void {
  if (pending.size === 0) return;

  const now = Date.now();
  for (const [key, entry] of pending) {
    if (now - new Date(entry.startedAt).getTime() > PENDING_MAX_AGE_MS) {
      pending.delete(key);
    }
  }

  if (pending.size > PENDING_MAX_SIZE) {
    const sorted = [...pending.entries()].sort(
      (a, b) => new Date(a[1].startedAt).getTime() - new Date(b[1].startedAt).getTime(),
    );
    const excess = pending.size - PENDING_MAX_SIZE;
    for (let i = 0; i < excess; i++) {
      pending.delete(sorted[i][0]);
    }
  }
}

/**
 * before_tool_call handler — stash context and forward a "pending" frame
 * to the daemon so it can record that a call is in flight.
 */
export function beforeToolCall(
  event: { toolName: string; params: Record<string, unknown>; runId?: string; toolCallId?: string },
  ctx: { sessionKey?: string; sessionId?: string },
  deps: HookDeps,
): void {
  evictStalePending(deps.pending);

  const key = callKey(event.runId, event.toolCallId);
  deps.pending.set(key, {
    toolName: event.toolName,
    params: event.params,
    startedAt: new Date().toISOString(),
    sessionKey: ctx.sessionKey ?? "default",
    sessionId: ctx.sessionId,
  });

  // Forward "pending" frame to daemon. Defensive try/catch: guards against
  // non-serialisable params (BigInt, cycles) that JSON.stringify would throw on.
  try {
    const inputJson = JSON.stringify(event.params);
    deps.emitter
      .emit({
        tool: { name: event.toolName },
        ...(inputJson !== undefined ? { input: inputJson } : {}),
        decision: "pending",
      })
      .catch(() => {});
  } catch (err) {
    deps.logger.warn(
      `agent-receipts: emitter pre-call forward skipped: ${String(err)}`,
    );
  }
}

/**
 * Evict pending entries whose stash belongs to the given session.
 */
export function evictPendingForSession(
  pending: PendingMap,
  sessionKey: string,
  sessionId: string | undefined,
): void {
  for (const [key, entry] of pending) {
    if (entry.sessionKey === sessionKey && entry.sessionId === sessionId) {
      pending.delete(key);
    }
  }
}

/**
 * after_tool_call handler — classify the call, emit an "allowed" frame to
 * the daemon, and log. Receipt creation, signing, and storage all happen
 * inside the daemon process (ADR-0010 Flavor B).
 */
export async function afterToolCall(
  event: {
    toolName: string;
    params: Record<string, unknown>;
    runId?: string;
    toolCallId?: string;
    result?: unknown;
    error?: string;
  },
  _ctx: { agentId?: string; sessionKey?: string; sessionId?: string },
  deps: HookDeps,
): Promise<void> {
  const key = callKey(event.runId, event.toolCallId);
  const stashed = deps.pending.get(key);
  deps.pending.delete(key);

  const classification = classify(event.toolName, deps.mappings, deps.patterns);

  deps.logger.info(
    `agent-receipts: ${event.toolName} (${classification.action_type}, ${classification.risk_level}) → emitted to daemon`,
  );

  // Forward "allowed" frame to daemon. The daemon signs, hashes, chains, and
  // persists. Raw input/output cross the socket so the daemon can canonicalise
  // and hash them; they are not persisted by the daemon unless
  // --parameter-disclosure is explicitly set daemon-side.
  try {
    const inputJson = JSON.stringify(stashed?.params ?? event.params);
    const resultJson =
      event.result !== undefined ? JSON.stringify(event.result) : undefined;
    deps.emitter
      .emit({
        tool: { name: event.toolName },
        ...(inputJson !== undefined ? { input: inputJson } : {}),
        ...(resultJson !== undefined ? { output: resultJson } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
        decision: "allowed",
      })
      .catch(() => {});
  } catch (err) {
    deps.logger.warn(
      `agent-receipts: emitter post-call forward skipped: ${String(err)}`,
    );
  }
}
