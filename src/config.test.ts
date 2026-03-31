import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
});
