import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type ParameterDisclosureConfig =
  | boolean    // true = all actions, false = disabled (default)
  | "high"     // high-risk and critical actions only
  | string[];  // specific action type strings e.g. ["system.command.execute"]

export type AttestPluginConfig = {
  taxonomyPath?: string;
  enabled?: boolean;
  /**
   * Kept for the OQ-C startup warning. Under daemon mode the daemon's own
   * --parameter-disclosure flag governs whether plaintext is stored; this
   * plugin-side setting is ignored and a warning is emitted if set.
   */
  parameterDisclosure?: ParameterDisclosureConfig;
  /**
   * Path to the daemon's SQLite receipt database. Defaults to the daemon's
   * platform default path (same resolution as AGENTRECEIPTS_DB env var or
   * ~/.local/share/agent-receipts/receipts.db on Linux/macOS).
   */
  daemonDbPath?: string;
  /**
   * Path to the daemon's Ed25519 public key (PEM, mode 0644). Used by
   * ar_verify_chain to check receipt signatures. Defaults to the daemon's
   * default signing.key.pub path.
   */
  daemonPublicKeyPath?: string;
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

/**
 * Resolve the daemon's default SQLite DB path. Mirrors the daemon's own
 * DefaultDBPath() resolution so both sides agree on the file location.
 *
 * Resolution order:
 * 1. AGENTRECEIPTS_DB environment variable (any platform)
 * 2. $XDG_DATA_HOME/agent-receipts/receipts.db (Linux/macOS)
 * 3. ~/.local/share/agent-receipts/receipts.db (fallback)
 */
export function defaultDaemonDbPath(): string {
  const envPath = process.env["AGENTRECEIPTS_DB"];
  if (envPath) return envPath;

  const xdgDataHome = process.env["XDG_DATA_HOME"];
  const dataHome =
    xdgDataHome && xdgDataHome !== ""
      ? xdgDataHome
      : join(homedir(), ".local", "share");
  return join(dataHome, "agent-receipts", "receipts.db");
}

/**
 * Resolve the daemon's default public key path. Mirrors the daemon's
 * DefaultPublicKeyPath() which appends ".pub" to DefaultKeyPath().
 *
 * Resolution order:
 * 1. AGENTRECEIPTS_KEY environment variable + ".pub" suffix
 * 2. $XDG_DATA_HOME/agent-receipts/signing.key.pub (Linux/macOS)
 * 3. ~/.local/share/agent-receipts/signing.key.pub (fallback)
 */
export function defaultDaemonPublicKeyPath(): string {
  const envKey = process.env["AGENTRECEIPTS_KEY"];
  if (envKey) return `${envKey}.pub`;

  const xdgDataHome = process.env["XDG_DATA_HOME"];
  const dataHome =
    xdgDataHome && xdgDataHome !== ""
      ? xdgDataHome
      : join(homedir(), ".local", "share");
  return join(dataHome, "agent-receipts", "signing.key.pub");
}

export function resolveConfig(pluginConfig?: Record<string, unknown>): {
  taxonomyPath: string | undefined;
  enabled: boolean;
  parameterDisclosure: ParameterDisclosureConfig;
  daemonDbPath: string;
  daemonPublicKeyPath: string;
} {
  const cfg = (pluginConfig ?? {}) as AttestPluginConfig;
  return {
    taxonomyPath: cfg.taxonomyPath ? expandHome(cfg.taxonomyPath) : undefined,
    enabled: cfg.enabled !== false,
    parameterDisclosure: cfg.parameterDisclosure ?? false,
    daemonDbPath: cfg.daemonDbPath
      ? expandHome(cfg.daemonDbPath)
      : defaultDaemonDbPath(),
    daemonPublicKeyPath: cfg.daemonPublicKeyPath
      ? expandHome(cfg.daemonPublicKeyPath)
      : defaultDaemonPublicKeyPath(),
  };
}

