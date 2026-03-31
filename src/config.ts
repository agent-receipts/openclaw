import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateKeyPair, type KeyPair } from "@attest-protocol/attest-ts";

export type AttestPluginConfig = {
  dbPath?: string;
  keyPath?: string;
  taxonomyPath?: string;
  enabled?: boolean;
};

const DEFAULTS = {
  dbPath: "~/.openclaw/attest/receipts.db",
  keyPath: "~/.openclaw/attest/keys.json",
};

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    return resolve(process.env.HOME ?? "/tmp", p.slice(2));
  }
  return p;
}

export function resolveConfig(pluginConfig?: Record<string, unknown>): {
  dbPath: string;
  keyPath: string;
  taxonomyPath: string | undefined;
  enabled: boolean;
} {
  const cfg = (pluginConfig ?? {}) as AttestPluginConfig;
  return {
    dbPath: expandHome(cfg.dbPath ?? DEFAULTS.dbPath),
    keyPath: expandHome(cfg.keyPath ?? DEFAULTS.keyPath),
    taxonomyPath: cfg.taxonomyPath ? expandHome(cfg.taxonomyPath) : undefined,
    enabled: cfg.enabled !== false,
  };
}

/**
 * Load or generate an Ed25519 key pair for receipt signing.
 * Keys are persisted as JSON so they survive restarts.
 */
export function loadOrCreateKeys(keyPath: string): KeyPair & { verificationMethod: string } {
  if (existsSync(keyPath)) {
    const raw = readFileSync(keyPath, "utf-8");
    const stored = JSON.parse(raw) as KeyPair & { verificationMethod?: string };
    return {
      ...stored,
      verificationMethod: stored.verificationMethod ?? "did:openclaw:agent#key-1",
    };
  }

  // Generate new key pair and persist
  const keys = generateKeyPair();
  const dir = dirname(keyPath);
  mkdirSync(dir, { recursive: true });

  const toStore = {
    ...keys,
    verificationMethod: "did:openclaw:agent#key-1",
  };
  writeFileSync(keyPath, JSON.stringify(toStore, null, 2), "utf-8");

  return toStore;
}
