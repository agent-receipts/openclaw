/**
 * Thin fire-and-forget emitter for the agent-receipts daemon's local Unix
 * domain socket. Forwards a tool-call frame to the daemon, which captures
 * peer credentials, canonicalises (RFC 8785), signs (Ed25519), and persists
 * the receipt. The emitter does NO crypto, NO canonicalisation, and holds
 * NO chain state — those moved to the daemon per ADR-0010 (daemon process
 * separation, 2026-05-03).
 *
 * Concurrency: emit() is safe to call from multiple async contexts on a
 * single Emitter instance. The internal write is serialised via a promise
 * queue so concurrent calls cannot interleave bytes on the same socket.
 *
 * Failure model: emit() MUST NOT block the agent on the daemon. When the
 * socket is unreachable (daemon not started, socket file missing, broken
 * connection) emit() logs a debug-level drop and returns null within
 * milliseconds. Returns an Error only for caller bugs (missing tool name,
 * invalid decision, invalid JSON, emitter already closed, oversized frame)
 * — situations a retry could not fix.
 */

import { randomUUID } from "node:crypto";
import { createConnection } from "node:net";
import { platform } from "node:os";
import { join } from "node:path";

/** Maximum allowed frame size in bytes (1 MiB). Must match daemon's socket.MaxFrameSize. */
export const MAX_FRAME_SIZE = 1 << 20;

/** Wire format version. Must match daemon's pipeline.SupportedFrameVersion. */
export const SUPPORTED_FRAME_VERSION = "1";

/** Channel name for this plugin. Written into every frame's `channel` field. */
export const CHANNEL = "openclaw";

/** Dial timeout in milliseconds — caps how long emit() blocks reaching the daemon. */
export const DIAL_TIMEOUT_MS = 25;

/** Write deadline in milliseconds — caps how long a single frame write can block. */
export const WRITE_TIMEOUT_MS = 100;

/** Valid decision values (lowercase to match the wire format). */
const VALID_DECISIONS = Object.freeze([
  "allowed",
  "denied",
  "pending",
] as const);

/** One tool invocation to forward to the daemon. */
export interface EmitEvent {
  /** Tool that was called. */
  tool: {
    /** Tool name. Required and non-empty. */
    name: string;
    /** Optional server qualifier. When absent the action type is "openclaw.name". */
    server?: string;
  };
  /**
   * JSON string for the tool input. Must be valid JSON when provided.
   * Parsed once and embedded as the `input` value of the wire frame
   * (which is itself JSON-serialised before sending). The original byte
   * sequence is NOT preserved — the daemon receives canonical-equivalent
   * JSON, not the caller's exact source string.
   */
  input?: string;
  /**
   * JSON string for the tool output. Must be valid JSON when provided.
   * Parsed and embedded the same way as `input` — see that field for the
   * exact serialisation contract.
   */
  output?: string;
  /** Human-readable error message when the tool call failed. */
  error?: string;
  /** Policy decision for this call. */
  decision: "allowed" | "denied" | "pending";
}

/** Options for constructing an Emitter. */
export interface EmitterOptions {
  /**
   * Override the daemon socket path. When unset, resolved from the
   * AGENTRECEIPTS_SOCKET env var then the per-OS default.
   */
  socketPath?: string;
  /**
   * Supply a host session identifier instead of generating a fresh UUID v4.
   * Per ADR-0010 OQ4, use the host's session id when available so a single
   * agent loop produces one logical session. An empty or whitespace-only
   * string is ignored and a UUID is generated instead.
   */
  sessionId?: string;
  /**
   * Logger function for debug-level drop diagnostics. Defaults to no-op.
   * Pass `console.debug` or a structured logger to surface drops.
   */
  debugLog?: (message: string, attrs: Record<string, string>) => void;
}

/** Wire frame sent to the daemon. Field names must match the daemon's EmitterFrame exactly. */
interface WireFrame {
  v: string;
  ts_emit: string;
  session_id: string;
  channel: string;
  tool: {
    server?: string;
    name: string;
  };
  input?: unknown;
  output?: unknown;
  error?: string;
  decision: string;
}

/**
 * Pure socket path resolver, extracted for deterministic testing without
 * platform mocks. Call defaultSocketPath() for normal use.
 *
 * Resolution order:
 * 1. AGENTRECEIPTS_SOCKET environment variable (any platform).
 * 2. macOS: $TMPDIR/agentreceipts/events.sock (TMPDIR defaults to /tmp).
 * 3. Linux with $XDG_RUNTIME_DIR set: $XDG_RUNTIME_DIR/agentreceipts/events.sock.
 * 4. Linux, non-root uid: /run/user/<uid>/agentreceipts/events.sock.
 *    (systemd does not create /run/user/0 for root; fall through to system path.)
 * 5. Linux system fallback: /run/agentreceipts/events.sock.
 * 6. Other platforms: empty string — pass socketPath explicitly.
 *
 * @internal Exported for testing; use defaultSocketPath() in production code.
 */
export function _resolveSocketPath(
  env: Readonly<Record<string, string | undefined>>,
  platformName: string,
  uid: number | undefined,
): string {
  const envPath = env["AGENTRECEIPTS_SOCKET"];
  if (envPath) {
    return envPath;
  }
  if (platformName === "darwin") {
    const tmpdir = env["TMPDIR"] ?? "/tmp";
    return join(tmpdir, "agentreceipts", "events.sock");
  }
  if (platformName === "linux") {
    const xdgRuntime = env["XDG_RUNTIME_DIR"];
    if (xdgRuntime) {
      return join(xdgRuntime, "agentreceipts", "events.sock");
    }
    // systemd creates /run/user/<uid> only for non-root users; root falls through.
    if (uid !== undefined && uid !== 0) {
      return join("/run/user", String(uid), "agentreceipts", "events.sock");
    }
    return "/run/agentreceipts/events.sock";
  }
  return "";
}

/**
 * Returns the per-OS default path for the daemon socket.
 * See _resolveSocketPath for the full resolution order.
 */
export function defaultSocketPath(): string {
  return _resolveSocketPath(process.env, platform(), process.getuid?.());
}

/**
 * RFC3339Nano timestamp: Node's toISOString() produces milliseconds only
 * ("2026-05-07T12:34:56.789Z"). Extend to nanosecond-resolution zeros to
 * match Go's time.RFC3339Nano format ("2026-05-07T12:34:56.789000000Z").
 */
function rfc3339Nano(): string {
  return new Date().toISOString().replace(/\.(\d{3})Z$/, ".$1000000Z");
}

/**
 * Emitter is the daemon-socket client for the openclaw plugin. Construct
 * with `new Emitter(...)`, fire events with `emit()`, and release with
 * `close()` when the plugin stops.
 *
 * The session_id is generated once at construction (UUID v4) and remains
 * stable for the lifetime of this instance — including across daemon
 * reconnects (ADR-0010 OQ4).
 *
 * Construction does NOT dial the daemon — dialing is lazy on the first
 * `emit()` so that constructing an emitter cannot fail because the daemon
 * happens to be down at the moment.
 */
export class Emitter {
  /** Stable per-emitter session identifier (ADR-0010 OQ4). */
  readonly sessionId: string;

  private readonly socketPath: string;
  private readonly debugLog: (
    message: string,
    attrs: Record<string, string>,
  ) => void;

  private conn: ReturnType<typeof createConnection> | null = null;
  private closed = false;
  /** Serialise writes so concurrent emit() calls cannot interleave bytes. */
  private writeQueue: Promise<void> = Promise.resolve();
  /**
   * Set transiently when an async 'error' event has already logged a drop
   * for the live conn, so the synchronous write callback that follows
   * (with the same root cause) does not double-log.
   */
  private suppressNextWriteLog = false;

  constructor(options: EmitterOptions = {}) {
    const socketPath = options.socketPath ?? defaultSocketPath();
    if (!socketPath) {
      throw new Error(
        `emitter: no default socket path on ${platform()}; set AGENTRECEIPTS_SOCKET or pass socketPath`,
      );
    }
    this.socketPath = socketPath;
    const trimmedSessionId = options.sessionId?.trim();
    this.sessionId = trimmedSessionId ? trimmedSessionId : randomUUID();
    this.debugLog = options.debugLog ?? ((): void => {});
  }

  /**
   * Emit sends one event to the daemon. Returns null even when the daemon
   * is unreachable: dial and write failures are logged at debug level and
   * the conn is reset for re-dial on the next emit(). Returns an Error only
   * for caller bugs (emitter closed, oversized frame, invalid event fields,
   * malformed input/output JSON) — situations a retry could not fix.
   */
  async emit(ev: EmitEvent): Promise<Error | null> {
    // Validate caller-supplied fields before acquiring the write lock.
    if (this.closed) {
      return new Error("emitter: closed");
    }
    if (!ev.tool.name || ev.tool.name.trim() === "") {
      return new Error("emitter: missing tool.name");
    }
    if (!VALID_DECISIONS.includes(ev.decision)) {
      return new Error(
        `emitter: invalid decision "${ev.decision}" (want allowed|denied|pending)`,
      );
    }

    let parsedInput: ParsedJson | undefined;
    if (ev.input !== undefined) {
      parsedInput = tryParseJson(ev.input);
      if (!parsedInput.ok) {
        return new Error("emitter: input is not valid JSON");
      }
    }
    let parsedOutput: ParsedJson | undefined;
    if (ev.output !== undefined) {
      parsedOutput = tryParseJson(ev.output);
      if (!parsedOutput.ok) {
        return new Error("emitter: output is not valid JSON");
      }
    }

    const wireFrame: WireFrame = {
      v: SUPPORTED_FRAME_VERSION,
      ts_emit: rfc3339Nano(),
      session_id: this.sessionId,
      channel: CHANNEL,
      tool: {
        ...(ev.tool.server ? { server: ev.tool.server } : {}),
        name: ev.tool.name,
      },
      ...(parsedInput?.ok ? { input: parsedInput.value } : {}),
      ...(parsedOutput?.ok ? { output: parsedOutput.value } : {}),
      ...(ev.error !== undefined ? { error: ev.error } : {}),
      decision: ev.decision,
    };

    const body = Buffer.from(JSON.stringify(wireFrame), "utf8");
    if (body.length > MAX_FRAME_SIZE) {
      return new Error(
        `emitter: frame too large: ${body.length} bytes (max ${MAX_FRAME_SIZE})`,
      );
    }

    // Serialise into the write queue so concurrent calls do not interleave.
    return this.enqueueWrite(body);
  }

  /**
   * Close releases the underlying connection. After close(), subsequent
   * emit() calls return an Error. Safe to call multiple times.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.conn !== null) {
      this.conn.destroy();
      this.conn = null;
    }
  }

  /**
   * Enqueue a serialised write onto the sequential write queue. All calls
   * run in order; a failed write drops and resets the connection so the
   * next emit() re-dials transparently.
   */
  private enqueueWrite(body: Buffer): Promise<Error | null> {
    const next = this.writeQueue.then(() => this.doWrite(body));
    // Keep the queue advancing even if doWrite rejects (it should not, but guard it).
    this.writeQueue = next.then(
      () => {},
      () => {},
    );
    return next;
  }

  /**
   * doWrite dials if needed, then writes the framed body. Returns null on
   * success, logs and returns null on transient errors (fire-and-forget).
   *
   * If the write fails on a previously-established connection (e.g. daemon
   * restarted), the dead socket is discarded and one transparent re-dial
   * and re-write is attempted before giving up.
   */
  private async doWrite(body: Buffer): Promise<Error | null> {
    // Re-check `closed` at execution time: emit() might have validated
    // and enqueued, then close() ran while we were waiting in the queue.
    if (this.closed) {
      return null;
    }

    const dialErr = await this.dialIfNeeded();
    if (dialErr !== null) {
      this.logDrop("dial", dialErr);
      return null;
    }

    // close() may have run while we were dialing; in that case dialIfNeeded()
    // still opened a fresh socket — discard it and bail before writing.
    if (this.closed) {
      this.dropConn();
      return null;
    }

    const writeErr = await this.writeFrame(body);
    if (writeErr !== null) {
      // If handleConnError already logged this for us (peer reset surfaced
      // asynchronously), skip the duplicate "write" line.
      if (!this.suppressNextWriteLog) {
        this.logDrop("write", writeErr);
      }
      this.suppressNextWriteLog = false;
      this.dropConn();
      await this.retryWrite(body);
    }
    return null;
  }

  /**
   * retryWrite re-dials and writes once. On failure the connection is
   * dropped and the error is logged. Separated into its own method so that
   * TypeScript's narrowing of `this.conn` from `dropConn()` does not flow
   * into this scope.
   */
  private async retryWrite(body: Buffer): Promise<void> {
    // close() may have run while we awaited the failed first write — bail
    // out so we don't open a fresh connection on a closed emitter.
    if (this.closed) {
      return;
    }
    const redialErr = await this.dialIfNeeded();
    if (redialErr !== null) {
      this.logDrop("dial", redialErr);
      return;
    }
    if (this.closed) {
      this.dropConn();
      return;
    }
    const retryErr = await this.writeFrame(body);
    if (retryErr !== null) {
      if (!this.suppressNextWriteLog) {
        this.logDrop("write", retryErr);
      }
      this.suppressNextWriteLog = false;
      this.dropConn();
    }
  }

  /** Destroy and null the current connection (if any). */
  private dropConn(): void {
    if (this.conn !== null) {
      this.conn.destroy();
      this.conn = null;
    }
  }

  /**
   * Dial the daemon socket if not already connected. The closed state is
   * also re-checked inside the connect callback so a close() that races
   * with a queued emit can drop the orphan socket immediately rather than
   * keeping the event loop alive during shutdown.
   */
  private dialIfNeeded(): Promise<Error | null> {
    if (this.conn !== null) {
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      // settled guards against the timer firing AND the connect/error
      // listeners firing — only the first outcome wins.
      let settled = false;
      let timer: NodeJS.Timeout | null = null;
      const settle = (result: Error | null): void => {
        if (settled) return;
        settled = true;
        if (timer !== null) {
          clearTimeout(timer);
          timer = null;
        }
        resolve(result);
      };

      // Pre-connect error listener: covers ENOENT/ECONNREFUSED etc. Removed
      // once the connection succeeds and replaced by the long-lived 'error'
      // listener installed in the connect callback below.
      const preConnectError = (err: Error): void => {
        if (!settled) {
          settle(err);
        }
      };
      const socket = createConnection({ path: this.socketPath }, () => {
        if (settled) {
          // Lost the race against the timeout — drop this orphan socket.
          socket.destroy();
          return;
        }
        if (this.closed) {
          // close() ran while we were dialing. Don't register this
          // socket on `this.conn` (which would keep the event loop
          // alive); destroy it and tell doWrite() to bail silently via
          // the post-dial closed check.
          socket.removeListener("error", preConnectError);
          socket.destroy();
          settle(null);
          return;
        }
        socket.removeListener("error", preConnectError);
        // Attach a long-lived error handler so that a later peer reset
        // (daemon crash, socket removed) does NOT surface as an
        // unhandled 'error' event and crash the host process.
        // The next emit() will see the broken conn via writeFrame's
        // callback and drop+redial transparently.
        socket.on("error", (err) => {
          this.handleConnError(socket, err);
        });
        this.conn = socket;
        settle(null);
      });

      socket.once("error", preConnectError);

      timer = setTimeout(() => {
        socket.destroy();
        settle(new Error(`dial timeout after ${DIAL_TIMEOUT_MS}ms`));
      }, DIAL_TIMEOUT_MS);
    });
  }

  /**
   * Handle a post-connect 'error' event on a live connection. If the
   * erroring socket is still our active conn, drop it so the next emit()
   * re-dials. We guard against stale events from sockets we already
   * destroyed (e.g. via dropConn during retry).
   */
  private handleConnError(
    socket: ReturnType<typeof createConnection>,
    err: Error,
  ): void {
    if (this.conn === socket) {
      this.conn = null;
      socket.destroy();
      // The pending write callback will resolve with the same root cause —
      // suppress its drop log so a single peer reset produces a single line.
      this.suppressNextWriteLog = true;
    }
    this.logDrop("conn", err);
  }

  /** Write a 4-byte big-endian length prefix followed by the body. */
  private writeFrame(body: Buffer): Promise<Error | null> {
    return new Promise((resolve) => {
      if (this.conn === null) {
        resolve(new Error("no connection"));
        return;
      }
      const conn = this.conn;

      const header = Buffer.allocUnsafe(4);
      header.writeUInt32BE(body.length, 0);
      const frame = Buffer.concat([header, body]);

      const timer = setTimeout(() => {
        resolve(new Error(`write timeout after ${WRITE_TIMEOUT_MS}ms`));
      }, WRITE_TIMEOUT_MS);

      conn.write(frame, (err) => {
        clearTimeout(timer);
        resolve(err ?? null);
      });
    });
  }

  private logDrop(stage: string, err: Error): void {
    this.debugLog("agent-receipts emitter dropped event", {
      stage,
      socket: this.socketPath,
      err: err.message,
    });
  }
}

/**
 * Result of attempting to parse a JSON string. `ok` distinguishes a valid
 * `null` value (`{ ok: true, value: null }`) from a parse failure
 * (`{ ok: false }`), so callers can branch unambiguously.
 */
type ParsedJson = { ok: true; value: unknown } | { ok: false };

/**
 * Parse a raw JSON string once. Returns `{ ok: true, value }` on success or
 * `{ ok: false }` on syntactic failure. Combines the previous validity check
 * and parse step into a single pass so we don't pay JSON.parse twice.
 */
function tryParseJson(s: string): ParsedJson {
  try {
    return { ok: true, value: JSON.parse(s) };
  } catch {
    return { ok: false };
  }
}
