import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash, randomUUID } from "node:crypto";
import {
  openStore,
  generateKeyPair,
  createReceipt,
  signReceipt,
  hashReceipt,
  encryptDisclosure,
  decryptDisclosure,
  generateForensicKeyPair,
  type ReceiptStore,
  type RiskLevel,
  type OutcomeStatus,
} from "@agnt-rcpt/sdk-ts";
import {
  createQueryReceiptsTool,
  createVerifyChainTool,
  createVerifyChainToolFactory,
} from "./tools.js";
import { openDaemonStore } from "./daemon-store.js";

// ---- Test fixture helpers ----

/**
 * Insert a signed receipt directly into the store.
 * Receipts inserted this way are NOT hash-linked by default; use the returned
 * hash as `previousHash` on the next call to build a proper linked chain.
 */
function insertReceiptAt(
  store: ReceiptStore,
  privateKey: string,
  opts: {
    seq: number;
    chainId: string;
    timestamp: string;
    previousHash: string | null;
    actionType?: string;
    riskLevel?: RiskLevel;
    status?: OutcomeStatus;
  },
): string {
  const unsigned = createReceipt({
    issuer: { id: "did:openclaw:test-agent" },
    principal: { id: "did:session:test-session" },
    action: {
      type: opts.actionType ?? "filesystem.file.read",
      risk_level: opts.riskLevel ?? "low",
      target: { system: "openclaw", resource: "read_file" },
      parameters_hash: "abc123",
    },
    outcome: {
      status: opts.status ?? "success",
      ...(opts.status === "failure" ? { error: "test error" } : {}),
    },
    chain: {
      sequence: opts.seq,
      previous_receipt_hash: opts.previousHash,
      chain_id: opts.chainId,
    },
    actionTimestamp: opts.timestamp,
  });
  const signed = signReceipt(unsigned, privateKey, "did:openclaw:test-agent#key-1");
  const h = hashReceipt(signed);
  store.insert(signed, h);
  return h;
}

// ---- ar_query_receipts ----

describe("ar_query_receipts", () => {
  let tempDir: string;
  let dbPath: string;
  let keys: ReturnType<typeof generateKeyPair>;
  let writableStore: ReceiptStore;

  beforeEach(() => {
    tempDir = join(tmpdir(), `ar-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "receipts.db");
    keys = generateKeyPair();
    writableStore = openStore(dbPath);
  });

  afterEach(() => {
    writableStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns empty results on fresh store", async () => {
    const tool = createQueryReceiptsTool({ daemonDbPath: dbPath, daemonPublicKeyPath: "" });
    const result = await tool.execute("tc-1", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.total_receipts).toBe(0);
    expect(data.results).toHaveLength(0);
  });

  it("returns inserted receipts", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "chain-1", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: "chain-1", timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h1" });

    const tool = createQueryReceiptsTool({ daemonDbPath: dbPath, daemonPublicKeyPath: "" });
    const result = await tool.execute("tc-q", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.total_receipts).toBe(2);
    expect(data.results).toHaveLength(2);
  });

  it("filters by action_type", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "chain-1", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null, actionType: "filesystem.file.read" });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: "chain-1", timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h1", actionType: "system.command.execute" });

    const tool = createQueryReceiptsTool({ daemonDbPath: dbPath, daemonPublicKeyPath: "" });
    const result = await tool.execute("tc-q", { action_type: "filesystem.file.read" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].action).toBe("filesystem.file.read");
  });

  it("filters by risk_level", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "chain-1", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null, riskLevel: "low" });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: "chain-1", timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h1", riskLevel: "high" });

    const tool = createQueryReceiptsTool({ daemonDbPath: dbPath, daemonPublicKeyPath: "" });
    const result = await tool.execute("tc-q", { risk_level: "high" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].risk).toBe("high");
  });

  it("filters by status", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "chain-1", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null, status: "success" });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: "chain-1", timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h1", status: "failure" });

    const tool = createQueryReceiptsTool({ daemonDbPath: dbPath, daemonPublicKeyPath: "" });
    const result = await tool.execute("tc-q", { status: "failure" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].status).toBe("failure");
  });

  it("respects limit", async () => {
    for (let i = 0; i < 5; i++) {
      insertReceiptAt(writableStore, keys.privateKey, {
        seq: i + 1, chainId: "chain-1",
        timestamp: `2024-01-01T${String(i + 10).padStart(2, "0")}:00:00.000Z`,
        previousHash: i === 0 ? null : `h${i}`,
      });
    }

    const tool = createQueryReceiptsTool({ daemonDbPath: dbPath, daemonPublicKeyPath: "" });
    const result = await tool.execute("tc-q", { limit: 2 });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    expect(data.total_receipts).toBe(5);
  });

  it("includes stats summary", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "chain-1", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null, riskLevel: "low" });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: "chain-1", timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h1", riskLevel: "high" });

    const tool = createQueryReceiptsTool({ daemonDbPath: dbPath, daemonPublicKeyPath: "" });
    const result = await tool.execute("tc-q", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.total_receipts).toBe(2);
    expect(data.total_chains).toBe(1);
    expect(data.by_risk).toBeDefined();
    expect(data.by_status).toBeDefined();
    expect(data.by_action).toBeDefined();
  });

  it("ignores invalid risk_level values", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "chain-1", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });

    const tool = createQueryReceiptsTool({ daemonDbPath: dbPath, daemonPublicKeyPath: "" });
    const result = await tool.execute("tc-q", { risk_level: "invalid_value" });
    const data = JSON.parse(result.content[0].text);

    // Invalid risk_level is silently ignored — returns all results
    expect(data.results).toHaveLength(1);
  });

  it("ignores invalid status values", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "chain-1", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });

    const tool = createQueryReceiptsTool({ daemonDbPath: dbPath, daemonPublicKeyPath: "" });
    const result = await tool.execute("tc-q", { status: "not_a_status" });
    const data = JSON.parse(result.content[0].text);

    // Invalid status is silently ignored — returns all results
    expect(data.results).toHaveLength(1);
  });
});

// ---- ar_query_receipts — filters and ordering ----

describe("ar_query_receipts — filters and ordering", () => {
  let tempDir: string;
  let dbPath: string;
  let keys: ReturnType<typeof generateKeyPair>;
  let writableStore: ReceiptStore;
  let tool: ReturnType<typeof createQueryReceiptsTool>;

  const CHAIN_A = "chain_openclaw_test-session_sid-1";
  const CHAIN_B = "chain_openclaw_test-session_sid-2";

  beforeEach(() => {
    tempDir = join(tmpdir(), `ar-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "receipts.db");
    keys = generateKeyPair();
    writableStore = openStore(dbPath);
    tool = createQueryReceiptsTool({ daemonDbPath: dbPath, daemonPublicKeyPath: "" });
  });

  afterEach(() => {
    writableStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("default ordering is newest-first", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: CHAIN_A, timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h1" });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 3, chainId: CHAIN_A, timestamp: "2024-01-01T12:00:00.000Z", previousHash: "h2" });

    const result = await tool.execute("tc-q", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(3);
    expect(data.results[0].timestamp).toBe("2024-01-01T12:00:00.000Z");
    expect(data.results[2].timestamp).toBe("2024-01-01T10:00:00.000Z");
  });

  it("limit is applied after newest-first ordering", async () => {
    for (let i = 1; i <= 5; i++) {
      insertReceiptAt(writableStore, keys.privateKey, {
        seq: i, chainId: CHAIN_A,
        timestamp: `2024-01-01T${String(i + 7).padStart(2, "0")}:00:00.000Z`,
        previousHash: i === 1 ? null : `h${i - 1}`,
      });
    }

    const result = await tool.execute("tc-q", { limit: 2 });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    expect(data.results[0].timestamp).toBe("2024-01-01T12:00:00.000Z");
    expect(data.results[1].timestamp).toBe("2024-01-01T11:00:00.000Z");
    expect(data.total_receipts).toBe(5);
  });

  it("filters by timestamp_after (exclusive — does not include the boundary timestamp)", async () => {
    const T1 = "2024-01-01T08:00:00.000Z";
    const T2 = "2024-01-01T10:00:00.000Z";
    const T3 = "2024-01-01T12:00:00.000Z";
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: CHAIN_A, timestamp: T1, previousHash: null });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: CHAIN_A, timestamp: T2, previousHash: "h1" });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 3, chainId: CHAIN_A, timestamp: T3, previousHash: "h2" });

    const result = await tool.execute("tc-q", { timestamp_after: T1 });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    const timestamps = data.results.map((r: { timestamp: string }) => r.timestamp);
    expect(timestamps).toContain(T2);
    expect(timestamps).toContain(T3);
    expect(timestamps).not.toContain(T1);
  });

  it("filters by timestamp_after (mid-range)", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T08:00:00.000Z", previousHash: null });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: "h1" });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 3, chainId: CHAIN_A, timestamp: "2024-01-01T12:00:00.000Z", previousHash: "h2" });

    const result = await tool.execute("tc-q", { timestamp_after: "2024-01-01T09:00:00.000Z" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    for (const r of data.results) {
      expect(r.timestamp > "2024-01-01T09:00:00.000Z").toBe(true);
    }
  });

  it("filters by timestamp_before", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T08:00:00.000Z", previousHash: null });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: "h1" });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 3, chainId: CHAIN_A, timestamp: "2024-01-01T12:00:00.000Z", previousHash: "h2" });

    const result = await tool.execute("tc-q", { timestamp_before: "2024-01-01T11:00:00.000Z" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    for (const r of data.results) {
      expect(r.timestamp <= "2024-01-01T11:00:00.000Z").toBe(true);
    }
  });

  it("combining timestamp_after and limit returns newest receipts after cutoff", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T06:00:00.000Z", previousHash: null });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: "h1" });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 3, chainId: CHAIN_A, timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h2" });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 4, chainId: CHAIN_A, timestamp: "2024-01-01T12:00:00.000Z", previousHash: "h3" });

    const result = await tool.execute("tc-q", {
      timestamp_after: "2024-01-01T09:00:00.000Z",
      limit: 2,
    });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    expect(data.results[0].timestamp).toBe("2024-01-01T12:00:00.000Z");
    expect(data.results[1].timestamp).toBe("2024-01-01T11:00:00.000Z");
  });

  it("ignores invalid timestamp_after values", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });

    const result = await tool.execute("tc-q", { timestamp_after: "not-a-date" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
  });

  it("ignores invalid timestamp_before values", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });

    const result = await tool.execute("tc-q", { timestamp_before: "not-a-date" });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
  });

  it("result shape includes chain_id field", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });

    const result = await tool.execute("tc-q", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(1);
    expect(data.results[0].chain_id).toBe(CHAIN_A);
  });

  it("limit: -1 falls back to default of 20", async () => {
    for (let i = 1; i <= 25; i++) {
      insertReceiptAt(writableStore, keys.privateKey, {
        seq: i, chainId: CHAIN_A,
        timestamp: `2024-01-01T${String(i).padStart(2, "0")}:00:00.000Z`,
        previousHash: i === 1 ? null : `h${i - 1}`,
      });
    }

    const result = await tool.execute("tc-q", { limit: -1 });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(20);
  });

  it("limit: 5.7 (non-integer) falls back to default 20, not 5", async () => {
    for (let i = 1; i <= 25; i++) {
      insertReceiptAt(writableStore, keys.privateKey, {
        seq: i, chainId: CHAIN_A,
        timestamp: `2024-01-01T${String(i).padStart(2, "0")}:00:00.000Z`,
        previousHash: i === 1 ? null : `h${i - 1}`,
      });
    }

    const result = await tool.execute("tc-q", { limit: 5.7 });
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(20);
  });

  it("same-millisecond sequence tiebreaker: higher sequence comes first", async () => {
    const SAME_TS = "2024-01-01T10:00:00.000Z";
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: CHAIN_A, timestamp: SAME_TS, previousHash: null });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: CHAIN_A, timestamp: SAME_TS, previousHash: "h1" });

    const result = await tool.execute("tc-q", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(2);
    expect(data.results[0].sequence).toBe(2);
    expect(data.results[1].sequence).toBe(1);
  });

  it("returns receipts from all chains when no filter is applied", async () => {
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: CHAIN_A, timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: CHAIN_A, timestamp: "2024-01-01T11:00:00.000Z", previousHash: "h1" });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: CHAIN_B, timestamp: "2024-01-01T12:00:00.000Z", previousHash: null });

    const result = await tool.execute("tc-q", {});
    const data = JSON.parse(result.content[0].text);

    expect(data.results).toHaveLength(3);
    expect(data.total_receipts).toBe(3);
    expect(data.total_chains).toBe(2);
  });
});

// ---- ar_verify_chain ----

describe("ar_verify_chain", () => {
  let tempDir: string;
  let dbPath: string;
  let pubKeyPath: string;
  let keys: ReturnType<typeof generateKeyPair>;
  let writableStore: ReceiptStore;

  beforeEach(() => {
    tempDir = join(tmpdir(), `ar-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "receipts.db");
    pubKeyPath = join(tempDir, "signing.key.pub");
    keys = generateKeyPair();
    writeFileSync(pubKeyPath, keys.publicKey);
    writableStore = openStore(dbPath);
  });

  afterEach(() => {
    writableStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns valid for a correctly hash-linked chain", async () => {
    const h1 = insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "chain-1", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });
    const h2 = insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: "chain-1", timestamp: "2024-01-01T11:00:00.000Z", previousHash: h1 });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 3, chainId: "chain-1", timestamp: "2024-01-01T12:00:00.000Z", previousHash: h2 });

    const tool = createVerifyChainTool({ daemonDbPath: dbPath, daemonPublicKeyPath: pubKeyPath });
    const result = await tool.execute("tc-v", { chain_id: "chain-1" });

    expect(result.content[0].text).toContain("is valid");
    expect(result.content[0].text).toContain("3 receipts");
    const data = JSON.parse(result.content[1].text);
    expect(data.valid).toBe(true);
    expect(data.length).toBe(3);
    for (const r of data.receipts) {
      expect(r.signature_valid).toBe(true);
      expect(r.hash_link_valid).toBe(true);
      expect(r.sequence_valid).toBe(true);
    }
  });

  it("auto-discovers the chain when chain_id is omitted", async () => {
    const h1 = insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "chain-auto", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: "chain-auto", timestamp: "2024-01-01T11:00:00.000Z", previousHash: h1 });

    const tool = createVerifyChainTool({ daemonDbPath: dbPath, daemonPublicKeyPath: pubKeyPath });
    const result = await tool.execute("tc-v", {});

    expect(result.content[0].text).toContain("is valid");
    const data = JSON.parse(result.content[1].text);
    expect(data.chain_id).toBe("chain-auto");
    expect(data.valid).toBe(true);
    expect(data.length).toBe(2);
  });

  it("reports no receipts found when the DB is empty and chain_id is omitted", async () => {
    const tool = createVerifyChainTool({ daemonDbPath: dbPath, daemonPublicKeyPath: pubKeyPath });
    const result = await tool.execute("tc-v", {});

    expect(result.content[0].text).toContain("No receipts found");
    expect(result.details.valid).toBe(false);
    expect(result.details.length).toBe(0);
  });

  it("reports empty chain as valid (length 0) when an explicit chain_id has no receipts", async () => {
    // Insert receipts under a different chain so the DB file is not empty
    insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "other-chain", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });

    const tool = createVerifyChainTool({ daemonDbPath: dbPath, daemonPublicKeyPath: pubKeyPath });
    const result = await tool.execute("tc-v", { chain_id: "chain_nonexistent" });

    const data = JSON.parse(result.content[1].text);
    expect(data.valid).toBe(true);
    expect(data.length).toBe(0);
  });

  it("returns an error message when the public key file is missing", async () => {
    const h1 = insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "chain-1", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: "chain-1", timestamp: "2024-01-01T11:00:00.000Z", previousHash: h1 });

    const tool = createVerifyChainTool({ daemonDbPath: dbPath, daemonPublicKeyPath: "/nonexistent/path/signing.key.pub" });
    const result = await tool.execute("tc-v", { chain_id: "chain-1" });

    expect(result.content[0].text).toContain("Cannot read daemon public key");
  });

  it("factory context is accepted but not required for chain verification", async () => {
    const h1 = insertReceiptAt(writableStore, keys.privateKey, { seq: 1, chainId: "chain-ctx", timestamp: "2024-01-01T10:00:00.000Z", previousHash: null });
    insertReceiptAt(writableStore, keys.privateKey, { seq: 2, chainId: "chain-ctx", timestamp: "2024-01-01T11:00:00.000Z", previousHash: h1 });

    // Factory is called with session context (OpenClaw pattern) but ignores it
    const tool = createVerifyChainToolFactory({ daemonDbPath: dbPath, daemonPublicKeyPath: pubKeyPath })({
      sessionKey: "test-session",
      sessionId: "sid-1",
    });
    const result = await tool.execute("tc-v", { chain_id: "chain-ctx" });

    expect(result.content[0].text).toContain("is valid");
    const data = JSON.parse(result.content[1].text);
    expect(data.valid).toBe(true);
  });
});

// ---- HPKE parameter disclosure: cross-engine read path ----
//
// The daemon (Go) WRITES the HPKE `parameters_disclosure` envelope into the
// SQLite DB; the plugin READS it back through the TS SDK's strict zod schema
// (which `store.query()` / `verifyStoredChain()` run on every load). These
// tests pin that an envelope of the shape the daemon emits is accepted on the
// read path, that the Ed25519 signature commits to it, and that the ciphertext
// stays recoverable — but only with the forensic private key, which lives with
// the responder, not here. The plugin itself never decrypts.

describe("HPKE parameter disclosure — cross-engine read path", () => {
  let tempDir: string;
  let dbPath: string;
  let pubKeyPath: string;
  let keys: ReturnType<typeof generateKeyPair>;
  let forensic: Awaited<ReturnType<typeof generateForensicKeyPair>>;
  let kid: string;
  let writableStore: ReceiptStore;

  beforeEach(async () => {
    tempDir = join(tmpdir(), `ar-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    dbPath = join(tempDir, "receipts.db");
    pubKeyPath = join(tempDir, "signing.key.pub");
    keys = generateKeyPair();
    writeFileSync(pubKeyPath, keys.publicKey);
    forensic = await generateForensicKeyPair();
    // kid = sha256: + lowercase hex SHA-256 of the raw 32-byte public key,
    // matching the fingerprint the daemon writes (see parameter-disclosure spec).
    kid = `sha256:${createHash("sha256").update(forensic.publicKey).digest("hex")}`;
    writableStore = openStore(dbPath);
  });

  afterEach(() => {
    writableStore.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  // Insert a receipt whose action carries an HPKE disclosure envelope encrypted
  // to the forensic public key — the shape the daemon writes when its
  // --parameter-disclosure mode fires. Returns the stored receipt hash.
  async function insertDisclosedReceipt(opts: {
    seq: number;
    chainId: string;
    timestamp: string;
    previousHash: string | null;
    params: Record<string, unknown>;
  }): Promise<string> {
    const envelope = await encryptDisclosure(opts.params, forensic.publicKey, kid);
    const unsigned = createReceipt({
      issuer: { id: "did:openclaw:test-agent" },
      principal: { id: "did:session:test-session" },
      action: {
        type: "system.command.execute",
        risk_level: "high",
        target: { system: "openclaw", resource: "run_command" },
        parameters_hash: "abc123",
        parameters_disclosure: envelope,
      },
      outcome: { status: "success" },
      chain: {
        sequence: opts.seq,
        previous_receipt_hash: opts.previousHash,
        chain_id: opts.chainId,
      },
      actionTimestamp: opts.timestamp,
    });
    const signed = signReceipt(unsigned, keys.privateKey, "did:openclaw:test-agent#key-1");
    const h = hashReceipt(signed);
    writableStore.insert(signed, h);
    return h;
  }

  it("flags disclosed receipts in ar_query_receipts and accepts the daemon envelope shape", async () => {
    await insertDisclosedReceipt({
      seq: 1,
      chainId: "chain-d",
      timestamp: "2024-01-01T10:00:00.000Z",
      previousHash: null,
      params: { command: "rm -rf /tmp/x", cwd: "/home/me" },
    });
    insertReceiptAt(writableStore, keys.privateKey, {
      seq: 2,
      chainId: "chain-d",
      timestamp: "2024-01-01T11:00:00.000Z",
      previousHash: "h1",
      actionType: "filesystem.file.read",
    });

    const tool = createQueryReceiptsTool({ daemonDbPath: dbPath, daemonPublicKeyPath: pubKeyPath });
    const result = await tool.execute("tc-q", {});
    const data = JSON.parse(result.content[0].text);

    const disclosedByAction = Object.fromEntries(
      data.results.map((r: { action: string; disclosed: boolean }) => [r.action, r.disclosed]),
    );
    expect(disclosedByAction["system.command.execute"]).toBe(true);
    expect(disclosedByAction["filesystem.file.read"]).toBe(false);
  });

  it("verifies a chain whose receipts carry HPKE disclosure envelopes", async () => {
    const h1 = await insertDisclosedReceipt({
      seq: 1,
      chainId: "chain-d",
      timestamp: "2024-01-01T10:00:00.000Z",
      previousHash: null,
      params: { command: "echo hi" },
    });
    await insertDisclosedReceipt({
      seq: 2,
      chainId: "chain-d",
      timestamp: "2024-01-01T11:00:00.000Z",
      previousHash: h1,
      params: { command: "cat secret" },
    });

    const tool = createVerifyChainTool({ daemonDbPath: dbPath, daemonPublicKeyPath: pubKeyPath });
    const result = await tool.execute("tc-v", { chain_id: "chain-d" });

    const data = JSON.parse(result.content[1].text);
    expect(data.valid).toBe(true);
    expect(data.length).toBe(2);
    for (const r of data.receipts) {
      expect(r.signature_valid).toBe(true);
      expect(r.hash_link_valid).toBe(true);
    }
  });

  it("keeps the disclosed parameters recoverable only with the forensic private key", async () => {
    const params = { command: "rm -rf /tmp/x", cwd: "/home/me" };
    await insertDisclosedReceipt({
      seq: 1,
      chainId: "chain-d",
      timestamp: "2024-01-01T10:00:00.000Z",
      previousHash: null,
      params,
    });

    const store = openDaemonStore(dbPath);
    try {
      const [receipt] = store.query({});
      expect(receipt).toBeDefined();
      const envelope = receipt.credentialSubject.action.parameters_disclosure;
      if (!envelope) throw new Error("expected a disclosure envelope on the stored receipt");
      // The forensic key holder (off-host) recovers the plaintext; the plugin
      // never performs this step.
      const recovered = await decryptDisclosure(envelope, forensic.privateKey);
      expect(recovered).toEqual(params);
    } finally {
      store.close();
    }
  });
});
