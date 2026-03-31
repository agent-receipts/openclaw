import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig, loadOrCreateKeys } from "./config.js";

describe("resolveConfig", () => {
  it("returns defaults when no config provided", () => {
    const cfg = resolveConfig();

    expect(cfg.dbPath).toContain(".openclaw/attest/receipts.db");
    expect(cfg.keyPath).toContain(".openclaw/attest/keys.json");
    expect(cfg.taxonomyPath).toBeUndefined();
    expect(cfg.enabled).toBe(true);
  });

  it("respects explicit values", () => {
    const cfg = resolveConfig({
      dbPath: "/custom/path/db.sqlite",
      keyPath: "/custom/keys.json",
      taxonomyPath: "/custom/taxonomy.json",
    });

    expect(cfg.dbPath).toBe("/custom/path/db.sqlite");
    expect(cfg.keyPath).toBe("/custom/keys.json");
    expect(cfg.taxonomyPath).toBe("/custom/taxonomy.json");
  });

  it("expands ~ in paths", () => {
    const cfg = resolveConfig({ dbPath: "~/my/db.sqlite" });

    expect(cfg.dbPath).not.toContain("~");
    expect(cfg.dbPath).toContain("my/db.sqlite");
  });

  it("treats missing enabled as true", () => {
    const cfg = resolveConfig({});
    expect(cfg.enabled).toBe(true);
  });

  it("respects enabled: false", () => {
    const cfg = resolveConfig({ enabled: false });
    expect(cfg.enabled).toBe(false);
  });

  it("throws when HOME is unset and path uses ~/", () => {
    const originalHome = process.env.HOME;
    try {
      delete process.env.HOME;
      expect(() => resolveConfig({ dbPath: "~/test/db.sqlite" })).toThrow("HOME");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });
});

describe("loadOrCreateKeys", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("generates and persists keys when file does not exist", () => {
    tempDir = join(tmpdir(), `attest-test-${randomUUID()}`);
    const keyPath = join(tempDir, "keys.json");

    const keys = loadOrCreateKeys(keyPath);

    expect(keys.publicKey).toBeDefined();
    expect(keys.privateKey).toBeDefined();
    expect(keys.verificationMethod).toBe("did:openclaw:agent#key-1");

    // File was persisted
    const stored = JSON.parse(readFileSync(keyPath, "utf-8"));
    expect(stored.publicKey).toBe(keys.publicKey);
    expect(stored.privateKey).toBe(keys.privateKey);
  });

  it("loads existing keys from file", () => {
    tempDir = join(tmpdir(), `attest-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    const keyPath = join(tempDir, "keys.json");

    const original = {
      publicKey: "test-pub",
      privateKey: "test-priv",
      verificationMethod: "did:custom:method#key-2",
    };
    writeFileSync(keyPath, JSON.stringify(original));

    const keys = loadOrCreateKeys(keyPath);

    expect(keys.publicKey).toBe("test-pub");
    expect(keys.privateKey).toBe("test-priv");
    expect(keys.verificationMethod).toBe("did:custom:method#key-2");
  });

  it("adds default verificationMethod if missing from stored file", () => {
    tempDir = join(tmpdir(), `attest-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    const keyPath = join(tempDir, "keys.json");

    writeFileSync(keyPath, JSON.stringify({ publicKey: "pub", privateKey: "priv" }));

    const keys = loadOrCreateKeys(keyPath);

    expect(keys.verificationMethod).toBe("did:openclaw:agent#key-1");
  });

  it("writes key file with restrictive permissions (owner-only)", () => {
    tempDir = join(tmpdir(), `attest-test-${randomUUID()}`);
    const keyPath = join(tempDir, "keys.json");

    loadOrCreateKeys(keyPath);

    const stats = statSync(keyPath);
    const mode = stats.mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("tightens permissions on existing key files with insecure mode", () => {
    tempDir = join(tmpdir(), `attest-test-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    const keyPath = join(tempDir, "keys.json");

    // Simulate an old key file with world-readable permissions
    writeFileSync(keyPath, JSON.stringify({ publicKey: "pub", privateKey: "priv" }), { mode: 0o644 });
    expect(statSync(keyPath).mode & 0o777).toBe(0o644);

    loadOrCreateKeys(keyPath);

    // Should have been tightened to 0o600
    const mode = statSync(keyPath).mode & 0o777;
    expect(mode).toBe(0o600);
  });
});
