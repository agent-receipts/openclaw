import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { generateKeyPair, type KeyPair } from "@agnt-rcpt/sdk-ts";

export type ParameterDisclosureConfig =
  | boolean    // true = all actions, false = disabled (default)
  | "high"     // high-risk and critical actions only
  | string[];  // specific action type strings e.g. ["system.command.execute"]

/**
 * Daemon-forwarding config (ADR-0010). Sends a copy of every tool call to a
 * local agent-receipts daemon over AF_UNIX. Off by default: enabling this
 * forwards raw `input` and `output` JSON across a process boundary so the
 * daemon can canonicalise (RFC 8785) and hash the call. The daemon does not
 * persist the raw values — only their SHA-256 hashes appear in receipts —
 * but the bytes are observable on the socket and in daemon memory while the
 * frame is in flight. This is a stricter trust boundary than the in-process
 * `parameterDisclosure` contract, so it is opt-in.
 */
export type DaemonForwardingConfig = boolean | { enabled?: boolean };

export type AttestPluginConfig = {
  dbPath?: string;
  keyPath?: string;
  taxonomyPath?: string;
  enabled?: boolean;
  parameterDisclosure?: ParameterDisclosureConfig;
  daemonForwarding?: DaemonForwardingConfig;
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
  daemonForwarding: { enabled: boolean };
} {
  const cfg = (pluginConfig ?? {}) as AttestPluginConfig;
  return {
    dbPath: expandHome(cfg.dbPath ?? DEFAULTS.dbPath),
    keyPath: expandHome(cfg.keyPath ?? DEFAULTS.keyPath),
    taxonomyPath: cfg.taxonomyPath ? expandHome(cfg.taxonomyPath) : undefined,
    enabled: cfg.enabled !== false,
    parameterDisclosure: cfg.parameterDisclosure ?? false,
    daemonForwarding: resolveDaemonForwarding(cfg.daemonForwarding),
  };
}

function resolveDaemonForwarding(
  cfg: DaemonForwardingConfig | undefined,
): { enabled: boolean } {
  if (cfg === true) return { enabled: true };
  if (cfg === false || cfg === undefined) return { enabled: false };
  return { enabled: cfg.enabled === true };
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
