import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateKeyPair, type KeyPair } from "@agnt-rcpt/sdk-ts";

export type ParameterDisclosureConfig =
  | boolean    // true = all actions, false = disabled (default)
  | "high"     // high-risk and critical actions only
  | string[];  // specific action type strings e.g. ["system.command.execute"]

export type AttestPluginConfig = {
  dbPath?: string;
  keyPath?: string;
  taxonomyPath?: string;
  enabled?: boolean;
  parameterDisclosure?: ParameterDisclosureConfig;
};

const DEFAULTS = {
  dbPath: "~/.openclaw/agent-receipts/receipts.db",
  keyPath: "~/.openclaw/agent-receipts/keys.json",
};

function expandHome(p: string): string {
  if (p.startsWith("~/")) {
    const home = process.env.HOME;
    if (!home) {
      throw new Error(
        "Cannot expand ~/ path: HOME environment variable is not set. " +
        "Set HOME or use an absolute path in plugin config.",
      );
    }
    return resolve(home, p.slice(2));
  }
  return p;
}

export function resolveConfig(pluginConfig?: Record<string, unknown>): {
  dbPath: string;
  keyPath: string;
  taxonomyPath: string | undefined;
  enabled: boolean;
  parameterDisclosure: ParameterDisclosureConfig;
} {
  const cfg = (pluginConfig ?? {}) as AttestPluginConfig;
  return {
    dbPath: expandHome(cfg.dbPath ?? DEFAULTS.dbPath),
    keyPath: expandHome(cfg.keyPath ?? DEFAULTS.keyPath),
    taxonomyPath: cfg.taxonomyPath ? expandHome(cfg.taxonomyPath) : undefined,
    enabled: cfg.enabled !== false,
    parameterDisclosure: cfg.parameterDisclosure ?? false,
  };
}

/**
 * Load or generate an Ed25519 key pair for receipt signing.
 * Keys are persisted as JSON so they survive restarts.
 */
export function loadOrCreateKeys(keyPath: string): KeyPair & { verificationMethod: string } {
  if (existsSync(keyPath)) {
    // Tighten permissions on existing key files from older versions
    const currentMode = statSync(keyPath).mode & 0o777;
    if (currentMode !== 0o600) {
      chmodSync(keyPath, 0o600);
    }

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
  writeFileSync(keyPath, JSON.stringify(toStore, null, 2), { encoding: "utf-8", mode: 0o600 });

  return toStore;
}
