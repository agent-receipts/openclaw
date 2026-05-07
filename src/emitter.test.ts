/**
 * Tests for the fire-and-forget AF_UNIX socket emitter.
 *
 * The round-trip tests spin up the real daemon binary (built from
 * `daemon/` in the agent-receipts/ar repo) as a subprocess and verify
 * that the emitter's wire frames are accepted by the daemon without error.
 *
 * Tests that require a running daemon are skipped when the binary
 * is absent (CI without a Go toolchain step, etc.).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createServer, type Server } from "node:net";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { Emitter, defaultSocketPath, MAX_FRAME_SIZE } from "./emitter.js";

// macOS AF_UNIX sun_path is capped at 104 bytes. Node's os.tmpdir() on
// macOS returns "/var/folders/.../T/" which can push our test socket paths
// near the limit. Use /tmp directly (a 4-byte prefix that resolves to the
// same /private/tmp on macOS) so paths stay well under the cap, regardless
// of how long mkdtemp's random suffix grows in future Node versions. See
// https://man7.org/linux/man-pages/man7/unix.7.html for the cap.
const SHORT_TMP = "/tmp";
const TMP_PREFIX = "oc-em-";

function makeShortTmpDir(): string {
  return mkdtempSync(join(SHORT_TMP, TMP_PREFIX));
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create an in-process echo server that records received frames. */
function createEchoServer(socketPath: string): {
  server: Server;
  frames: Buffer[];
  close: () => Promise<void>;
} {
  const frames: Buffer[] = [];
  const server = createServer((socket) => {
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      // Consume all complete frames from the buffer
      while (buf.length >= 4) {
        const len = buf.readUInt32BE(0);
        if (buf.length < 4 + len) break;
        frames.push(buf.subarray(4, 4 + len));
        buf = buf.subarray(4 + len);
      }
    });
  });

  server.listen(socketPath);

  const close = (): Promise<void> =>
    new Promise((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });

  return { server, frames, close };
}

/** Wait until a condition is true, polling every 10ms, up to timeoutMs. */
async function waitFor(
  condition: () => boolean,
  timeoutMs = 1000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitFor: timed out");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---------------------------------------------------------------------------
// Daemon-based helpers (skipped when binary is absent)
// ---------------------------------------------------------------------------

const DAEMON_BIN = "/tmp/agent-receipts-daemon";
const DAEMON_AVAILABLE = existsSync(DAEMON_BIN);

/**
 * Start the daemon subprocess pointing at a temp socket and db.
 *
 * The key file is generated once per tmpDir (keyed to "signing.key").
 * If the file already exists (e.g. daemon restart in the same dir),
 * it is reused so the daemon comes back up with the same key.
 */
function startDaemon(tmpDir: string): {
  proc: ChildProcess;
  socketPath: string;
  keyPath: string;
} {
  const socketPath = join(tmpDir, "events.sock");
  const dbPath = join(tmpDir, "receipts.db");
  const keyPath = join(tmpDir, "signing.key");

  // Generate PKCS#8 PEM Ed25519 key if not already present.
  if (!existsSync(keyPath)) {
    execFileSync("openssl", [
      "genpkey",
      "-algorithm",
      "ed25519",
      "-out",
      keyPath,
    ]);
    // The daemon requires mode 0600
    execFileSync("chmod", ["600", keyPath]);
  }

  const proc = spawn(DAEMON_BIN, [], {
    env: {
      ...process.env,
      AGENTRECEIPTS_SOCKET: socketPath,
      AGENTRECEIPTS_DB: dbPath,
      AGENTRECEIPTS_KEY: keyPath,
    },
    stdio: "pipe",
  });

  return { proc, socketPath, keyPath };
}

// ---------------------------------------------------------------------------
// defaultSocketPath
// ---------------------------------------------------------------------------

describe("defaultSocketPath", () => {
  it("returns AGENTRECEIPTS_SOCKET when set", () => {
    const original = process.env.AGENTRECEIPTS_SOCKET;
    process.env.AGENTRECEIPTS_SOCKET = "/custom/path/events.sock";
    try {
      expect(defaultSocketPath()).toBe("/custom/path/events.sock");
    } finally {
      if (original === undefined) {
        delete process.env.AGENTRECEIPTS_SOCKET;
      } else {
        process.env.AGENTRECEIPTS_SOCKET = original;
      }
    }
  });

  it("returns a non-empty path on darwin/linux", () => {
    const p = defaultSocketPath();
    // On darwin or linux the path is always non-empty; on other platforms
    // it may be empty (that's expected behaviour, not an error here).
    if (process.platform === "darwin" || process.platform === "linux") {
      expect(p.length).toBeGreaterThan(0);
      expect(p).toContain("agentreceipts");
    }
  });
});

// ---------------------------------------------------------------------------
// Constructor validation
// ---------------------------------------------------------------------------

describe("Emitter constructor", () => {
  it("constructs with an explicit socketPath and exposes a session_id", () => {
    const e = new Emitter({ socketPath: "/tmp/test.sock" });
    expect(e.sessionId).toBeTruthy();
    e.close();
  });

  it("throws for empty socketPath option", () => {
    // The Emitter constructor guards against empty string — covers the
    // "no default socket path on this platform" path in a platform-agnostic
    // way (no need to monkey-patch process.platform).
    expect(
      () => new Emitter({ socketPath: "" }),
    ).toThrow(/no default socket path/);
  });

  it("generates a stable UUID v4 session_id", () => {
    const e = new Emitter({ socketPath: "/tmp/test.sock" });
    expect(e.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    e.close();
  });

  it("accepts an explicit sessionId", () => {
    const id = "aaaabbbb-cccc-4ddd-8eee-ffffffffffff";
    const e = new Emitter({ socketPath: "/tmp/test.sock", sessionId: id });
    expect(e.sessionId).toBe(id);
    e.close();
  });

  it("ignores whitespace-only sessionId and generates fresh UUID", () => {
    const e = new Emitter({ socketPath: "/tmp/test.sock", sessionId: "   " });
    expect(e.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    e.close();
  });
});

// ---------------------------------------------------------------------------
// Validation errors (caller bugs → returned Error, not silent drop)
// ---------------------------------------------------------------------------

describe("emit() validation", () => {
  let tmpDir: string;
  let emitter: Emitter;

  beforeEach(() => {
    tmpDir = makeShortTmpDir();
    const socketPath = join(tmpDir, "events.sock");
    emitter = new Emitter({ socketPath });
  });

  afterEach(() => {
    emitter.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns error for empty tool name", async () => {
    const err = await emitter.emit({
      tool: { name: "" },
      decision: "allowed",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/missing tool\.name/);
  });

  it("returns error for invalid decision", async () => {
    const err = await emitter.emit({
      tool: { name: "bash" },
      // @ts-expect-error intentional bad value
      decision: "maybe",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/invalid decision/);
  });

  it("returns error for invalid JSON input", async () => {
    const err = await emitter.emit({
      tool: { name: "bash" },
      input: "{not json}",
      decision: "allowed",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/not valid JSON/i);
  });

  it("returns error for invalid JSON output", async () => {
    const err = await emitter.emit({
      tool: { name: "bash" },
      output: "not-json",
      decision: "allowed",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/not valid JSON/i);
  });

  it("returns error after close()", async () => {
    emitter.close();
    const err = await emitter.emit({
      tool: { name: "bash" },
      decision: "allowed",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/closed/);
  });

  it("returns error for oversized frame", async () => {
    // Build a payload just over 1 MiB
    const bigValue = "x".repeat(MAX_FRAME_SIZE + 1);
    const err = await emitter.emit({
      tool: { name: "bash" },
      input: JSON.stringify({ data: bigValue }),
      decision: "allowed",
    });
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toMatch(/frame too large/);
  });
});

// ---------------------------------------------------------------------------
// session_id stability across reconnects
// ---------------------------------------------------------------------------

describe("session_id stability", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeShortTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("session_id is the same across multiple emits (no daemon needed)", async () => {
    // No server is listening — all emits fire-and-forget.
    const socketPath = join(tmpDir, "events.sock");
    const emitter = new Emitter({ socketPath });
    const id = emitter.sessionId;

    // Fire several emits; none should change the session_id
    for (let i = 0; i < 3; i++) {
      await emitter.emit({ tool: { name: "bash" }, decision: "allowed" });
    }
    expect(emitter.sessionId).toBe(id);
    emitter.close();
  });
});

// ---------------------------------------------------------------------------
// Fire-and-forget when daemon is down
// ---------------------------------------------------------------------------

describe("fire-and-forget (daemon down)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeShortTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns null quickly (<50ms) when no daemon is reachable", async () => {
    const socketPath = join(tmpDir, "no-daemon.sock");
    const emitter = new Emitter({ socketPath });

    const start = Date.now();
    const err = await emitter.emit({
      tool: { name: "bash" },
      decision: "allowed",
    });
    const elapsed = Date.now() - start;

    expect(err).toBeNull();
    expect(elapsed).toBeLessThan(50);
    emitter.close();
  });

  it("drops a debug log when daemon is not reachable", async () => {
    const drops: string[] = [];
    const socketPath = join(tmpDir, "no-daemon.sock");
    const emitter = new Emitter({
      socketPath,
      debugLog: (msg) => drops.push(msg),
    });

    await emitter.emit({ tool: { name: "bash" }, decision: "allowed" });
    expect(drops.length).toBeGreaterThan(0);
    expect(drops[0]).toMatch(/dropped/);
    emitter.close();
  });
});

// ---------------------------------------------------------------------------
// Frame round-trip against in-process echo server
// ---------------------------------------------------------------------------

describe("frame round-trip (in-process server)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = makeShortTmpDir();
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("sends correctly framed JSON to the server", async () => {
    const socketPath = join(tmpDir, "events.sock");
    const { frames, close } = createEchoServer(socketPath);

    const emitter = new Emitter({ socketPath });

    const err = await emitter.emit({
      tool: { name: "bash", server: "host-tools" },
      input: JSON.stringify({ cmd: "ls -la" }),
      output: JSON.stringify({ exitCode: 0 }),
      decision: "allowed",
    });

    await waitFor(() => frames.length >= 1);

    expect(err).toBeNull();
    expect(frames).toHaveLength(1);

    const parsed = JSON.parse(frames[0].toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.v).toBe("1");
    expect(parsed.session_id).toBe(emitter.sessionId);
    expect(parsed.channel).toBe("openclaw");
    expect(parsed.decision).toBe("allowed");
    expect((parsed.tool as { name: string }).name).toBe("bash");
    expect((parsed.tool as { server: string }).server).toBe("host-tools");
    expect(parsed.input).toEqual({ cmd: "ls -la" });
    expect(parsed.output).toEqual({ exitCode: 0 });
    // ts_emit must look like RFC3339Nano (ends in Z, has nanoseconds)
    expect(typeof parsed.ts_emit).toBe("string");
    // Match Go's RFC3339Nano: ".789000000Z" — exactly nine fractional digits
    // preceded by a literal dot. The leading dot pins the format so we'd
    // catch a regression that drops fractional seconds entirely.
    expect(parsed.ts_emit as string).toMatch(/\.\d{9}Z$/);

    emitter.close();
    await close();
  });

  it("omits server field when not provided", async () => {
    const socketPath = join(tmpDir, "events2.sock");
    const { frames, close } = createEchoServer(socketPath);

    const emitter = new Emitter({ socketPath });
    await emitter.emit({ tool: { name: "read_file" }, decision: "pending" });

    await waitFor(() => frames.length >= 1);

    const parsed = JSON.parse(frames[0].toString("utf8")) as Record<
      string,
      unknown
    >;
    expect((parsed.tool as Record<string, unknown>).server).toBeUndefined();
    expect(parsed.decision).toBe("pending");

    emitter.close();
    await close();
  });

  it("omits input/output when not provided", async () => {
    const socketPath = join(tmpDir, "events3.sock");
    const { frames, close } = createEchoServer(socketPath);

    const emitter = new Emitter({ socketPath });
    await emitter.emit({
      tool: { name: "noop" },
      error: "tool crashed",
      decision: "denied",
    });

    await waitFor(() => frames.length >= 1);

    const parsed = JSON.parse(frames[0].toString("utf8")) as Record<
      string,
      unknown
    >;
    expect(parsed.input).toBeUndefined();
    expect(parsed.output).toBeUndefined();
    expect(parsed.error).toBe("tool crashed");
    expect(parsed.decision).toBe("denied");

    emitter.close();
    await close();
  });

  it("preserves an explicit empty-string error (no falsy drop)", async () => {
    const socketPath = join(tmpDir, "empty-err.sock");
    const { frames, close } = createEchoServer(socketPath);

    const emitter = new Emitter({ socketPath });
    await emitter.emit({
      tool: { name: "noop" },
      error: "",
      decision: "allowed",
    });

    await waitFor(() => frames.length >= 1);

    const parsed = JSON.parse(frames[0].toString("utf8")) as Record<
      string,
      unknown
    >;
    // Caller passed an empty string deliberately — preserve it on the wire
    // rather than silently dropping the field via a falsy check.
    expect(parsed.error).toBe("");
    emitter.close();
    await close();
  });

  it(
    "session_id is stable across reconnects (server restart)",
    async () => {
      const socketPath = join(tmpDir, "reconnect.sock");
      const frames1: Buffer[] = [];
      const frames2: Buffer[] = [];

      // First server: receives one frame then forcefully closes each connection
      // so the emitter detects the broken pipe on the next write.
      const s1 = createServer((socket) => {
        let buf = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          if (buf.length >= 4) {
            const len = buf.readUInt32BE(0);
            if (buf.length >= 4 + len) {
              frames1.push(buf.subarray(4, 4 + len));
              // Forcefully destroy so the emitter's conn gets a reset error
              socket.destroy();
            }
          }
        });
      });
      await new Promise<void>((resolve) => s1.listen(socketPath, resolve));

      const emitter = new Emitter({ socketPath });
      const originalSessionId = emitter.sessionId;

      await emitter.emit({ tool: { name: "bash" }, decision: "allowed" });
      await waitFor(() => frames1.length >= 1, 2000);

      // Close server1 and remove socket
      await new Promise<void>((resolve, reject) =>
        s1.close((e) => (e ? reject(e) : resolve())),
      );
      rmSync(socketPath, { force: true });
      await new Promise((resolve) => setTimeout(resolve, 20));

      // Start server2
      const s2 = createServer((socket) => {
        let buf = Buffer.alloc(0);
        socket.on("data", (chunk: Buffer) => {
          buf = Buffer.concat([buf, chunk]);
          while (buf.length >= 4) {
            const len = buf.readUInt32BE(0);
            if (buf.length < 4 + len) break;
            frames2.push(buf.subarray(4, 4 + len));
            buf = buf.subarray(4 + len);
          }
        });
      });
      await new Promise<void>((resolve) => s2.listen(socketPath, resolve));

      // The emitter's old conn was destroyed by s1; the next emit re-dials.
      await emitter.emit({ tool: { name: "bash" }, decision: "allowed" });
      await waitFor(() => frames2.length >= 1, 2000);

      const parsed1 = JSON.parse(frames1[0].toString("utf8")) as {
        session_id: string;
      };
      const parsed2 = JSON.parse(frames2[0].toString("utf8")) as {
        session_id: string;
      };

      expect(parsed1.session_id).toBe(originalSessionId);
      expect(parsed2.session_id).toBe(originalSessionId);

      emitter.close();
      await new Promise<void>((resolve, reject) =>
        s2.close((e) => (e ? reject(e) : resolve())),
      );
    },
    10_000,
  );

  it("concurrent emits do not interleave bytes and preserve order", async () => {
    const socketPath = join(tmpDir, "concurrent.sock");
    const { frames, close } = createEchoServer(socketPath);

    const emitter = new Emitter({ socketPath });

    const N = 10;
    const results = await Promise.all(
      Array.from({ length: N }, (_, i) =>
        emitter.emit({
          tool: { name: `tool-${i}` },
          decision: "allowed",
        }),
      ),
    );

    await waitFor(() => frames.length >= N, 2000);

    // All emits succeed
    expect(results.every((r) => r === null)).toBe(true);
    // All frames are valid JSON, and the write queue preserved submission
    // order so frame[i].tool.name == "tool-i".
    for (let i = 0; i < N; i++) {
      const parsed = JSON.parse(frames[i].toString("utf8")) as {
        tool: { name: string };
      };
      expect(parsed.tool.name).toBe(`tool-${i}`);
    }

    emitter.close();
    await close();
  });

  it("does not crash the host when peer resets after dial succeeds", async () => {
    // Reproduces the unhandled 'error' event hazard: server accepts the
    // connection, the emitter caches it, then the server forcefully drops
    // the socket. Without a long-lived 'error' listener on the conn, Node
    // surfaces the peer reset as an uncaught exception and tears the
    // process down. With the fix, the next emit() simply re-dials.
    const socketPath = join(tmpDir, "peer-reset.sock");

    const s1 = createServer((socket) => {
      // Drop the connection as soon as it's established.
      setImmediate(() => socket.destroy());
    });
    await new Promise<void>((resolve) => s1.listen(socketPath, resolve));

    const emitter = new Emitter({ socketPath });

    // First emit dials and writes (may or may not race with the server's
    // destroy — both outcomes are acceptable: the framework must not crash).
    const err1 = await emitter.emit({
      tool: { name: "first" },
      decision: "allowed",
    });
    expect(err1).toBeNull();

    // Give the peer reset time to propagate.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Second emit should not throw and must redial cleanly. Since the
    // server is still alive (just kicks off connections), the dial works
    // even though the previous conn was reset.
    const err2 = await emitter.emit({
      tool: { name: "second" },
      decision: "allowed",
    });
    expect(err2).toBeNull();

    emitter.close();
    await new Promise<void>((resolve, reject) =>
      s1.close((e) => (e ? reject(e) : resolve())),
    );
  });

});

// ---------------------------------------------------------------------------
// Round-trip against the real daemon binary (skipped if binary absent)
// ---------------------------------------------------------------------------

describe.skipIf(!DAEMON_AVAILABLE)(
  "frame round-trip against real daemon",
  () => {
    let tmpDir: string;
    let proc: ChildProcess;
    let socketPath: string;

    beforeEach(async () => {
      tmpDir = makeShortTmpDir();
      const started = startDaemon(tmpDir);
      proc = started.proc;
      socketPath = started.socketPath;
      // Wait for the daemon to create the socket file
      await waitFor(() => existsSync(socketPath), 3000);
    });

    afterEach(() => {
      proc.kill("SIGTERM");
      rmSync(tmpDir, { recursive: true, force: true });
    });

    it("accepts a well-formed frame without error", async () => {
      const emitter = new Emitter({ socketPath });

      const err = await emitter.emit({
        tool: { name: "bash" },
        input: JSON.stringify({ cmd: "echo hello" }),
        decision: "allowed",
      });

      // Fire-and-forget: null means "delivered or dropped silently"
      expect(err).toBeNull();

      emitter.close();
    });

    it(
      "session_id is stable across daemon reconnect",
      async () => {
        const emitter = new Emitter({ socketPath });
        const id = emitter.sessionId;

        await emitter.emit({ tool: { name: "bash" }, decision: "allowed" });

        // Kill and restart daemon
        proc.kill("SIGTERM");
        await new Promise((resolve) => setTimeout(resolve, 200));
        rmSync(socketPath, { force: true });

        const restarted = startDaemon(tmpDir);
        proc = restarted.proc;
        await waitFor(() => existsSync(socketPath), 5000);

        await emitter.emit({ tool: { name: "bash" }, decision: "allowed" });

        // session_id must not have changed
        expect(emitter.sessionId).toBe(id);

        emitter.close();
      },
      15_000,
    );
  },
);
