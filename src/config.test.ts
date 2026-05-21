import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { resolveConfig, defaultDaemonDbPath, defaultDaemonPublicKeyPath } from "./config.js";

// ---- defaultDaemonDbPath ----

describe("defaultDaemonDbPath", () => {
  it("AGENTRECEIPTS_DB overrides all other resolution", () => {
    const saved = process.env.AGENTRECEIPTS_DB;
    process.env.AGENTRECEIPTS_DB = "/custom/path/receipts.db";
    try {
      expect(defaultDaemonDbPath()).toBe("/custom/path/receipts.db");
    } finally {
      if (saved === undefined) delete process.env.AGENTRECEIPTS_DB;
      else process.env.AGENTRECEIPTS_DB = saved;
    }
  });

  it("XDG_DATA_HOME affects the path when AGENTRECEIPTS_DB is unset", () => {
    const savedDb = process.env.AGENTRECEIPTS_DB;
    const savedXdg = process.env.XDG_DATA_HOME;
    delete process.env.AGENTRECEIPTS_DB;
    process.env.XDG_DATA_HOME = "/custom/data";
    try {
      expect(defaultDaemonDbPath()).toBe("/custom/data/agent-receipts/receipts.db");
    } finally {
      if (savedDb === undefined) delete process.env.AGENTRECEIPTS_DB;
      else process.env.AGENTRECEIPTS_DB = savedDb;
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
    }
  });

  it("falls back to ~/.local/share/agent-receipts/receipts.db when no env vars set", () => {
    const savedDb = process.env.AGENTRECEIPTS_DB;
    const savedXdg = process.env.XDG_DATA_HOME;
    const savedHome = process.env.HOME;
    delete process.env.AGENTRECEIPTS_DB;
    delete process.env.XDG_DATA_HOME;
    process.env.HOME = "/home/testuser";
    try {
      expect(defaultDaemonDbPath()).toBe("/home/testuser/.local/share/agent-receipts/receipts.db");
    } finally {
      if (savedDb === undefined) delete process.env.AGENTRECEIPTS_DB;
      else process.env.AGENTRECEIPTS_DB = savedDb;
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});

// ---- defaultDaemonPublicKeyPath ----

describe("defaultDaemonPublicKeyPath", () => {
  it("AGENTRECEIPTS_KEY + '.pub' overrides all other resolution", () => {
    const saved = process.env.AGENTRECEIPTS_KEY;
    process.env.AGENTRECEIPTS_KEY = "/custom/signing.key";
    try {
      expect(defaultDaemonPublicKeyPath()).toBe("/custom/signing.key.pub");
    } finally {
      if (saved === undefined) delete process.env.AGENTRECEIPTS_KEY;
      else process.env.AGENTRECEIPTS_KEY = saved;
    }
  });

  it("XDG_DATA_HOME affects the path when AGENTRECEIPTS_KEY is unset", () => {
    const savedKey = process.env.AGENTRECEIPTS_KEY;
    const savedXdg = process.env.XDG_DATA_HOME;
    delete process.env.AGENTRECEIPTS_KEY;
    process.env.XDG_DATA_HOME = "/custom/data";
    try {
      expect(defaultDaemonPublicKeyPath()).toBe("/custom/data/agent-receipts/signing.key.pub");
    } finally {
      if (savedKey === undefined) delete process.env.AGENTRECEIPTS_KEY;
      else process.env.AGENTRECEIPTS_KEY = savedKey;
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
    }
  });

  it("falls back to ~/.local/share/agent-receipts/signing.key.pub", () => {
    const savedKey = process.env.AGENTRECEIPTS_KEY;
    const savedXdg = process.env.XDG_DATA_HOME;
    const savedHome = process.env.HOME;
    delete process.env.AGENTRECEIPTS_KEY;
    delete process.env.XDG_DATA_HOME;
    process.env.HOME = "/home/testuser";
    try {
      expect(defaultDaemonPublicKeyPath()).toBe("/home/testuser/.local/share/agent-receipts/signing.key.pub");
    } finally {
      if (savedKey === undefined) delete process.env.AGENTRECEIPTS_KEY;
      else process.env.AGENTRECEIPTS_KEY = savedKey;
      if (savedXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = savedXdg;
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});

// ---- resolveConfig ----

describe("resolveConfig", () => {
  let tempDir = "";

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("returns defaults when no config provided", () => {
    const cfg = resolveConfig();

    expect(cfg.daemonDbPath).toBeTruthy();
    expect(cfg.daemonDbPath).toContain("agent-receipts");
    expect(cfg.daemonPublicKeyPath).toBeTruthy();
    expect(cfg.daemonPublicKeyPath).toContain("signing.key.pub");
    expect(cfg.taxonomyPath).toBeUndefined();
    expect(cfg.enabled).toBe(true);
    expect(cfg.parameterDisclosure).toBe(false);
  });

  it("respects explicit daemonDbPath", () => {
    const cfg = resolveConfig({ daemonDbPath: "/custom/daemon.db" });
    expect(cfg.daemonDbPath).toBe("/custom/daemon.db");
  });

  it("respects explicit daemonPublicKeyPath", () => {
    const cfg = resolveConfig({ daemonPublicKeyPath: "/custom/signing.key.pub" });
    expect(cfg.daemonPublicKeyPath).toBe("/custom/signing.key.pub");
  });

  it("expands ~ in daemonDbPath", () => {
    const cfg = resolveConfig({ daemonDbPath: "~/my/receipts.db" });
    expect(cfg.daemonDbPath).not.toContain("~");
    expect(cfg.daemonDbPath).toContain("my/receipts.db");
  });

  it("expands ~ in daemonPublicKeyPath", () => {
    const cfg = resolveConfig({ daemonPublicKeyPath: "~/my/signing.key.pub" });
    expect(cfg.daemonPublicKeyPath).not.toContain("~");
    expect(cfg.daemonPublicKeyPath).toContain("my/signing.key.pub");
  });

  it("treats missing enabled as true", () => {
    const cfg = resolveConfig({});
    expect(cfg.enabled).toBe(true);
  });

  it("respects enabled: false", () => {
    const cfg = resolveConfig({ enabled: false });
    expect(cfg.enabled).toBe(false);
  });

  it("taxonomyPath is resolved from config", () => {
    const cfg = resolveConfig({ taxonomyPath: "/custom/taxonomy.json" });
    expect(cfg.taxonomyPath).toBe("/custom/taxonomy.json");
  });

  it("taxonomyPath is undefined by default", () => {
    const cfg = resolveConfig();
    expect(cfg.taxonomyPath).toBeUndefined();
  });

  it("parameterDisclosure defaults to false", () => {
    expect(resolveConfig().parameterDisclosure).toBe(false);
    expect(resolveConfig({}).parameterDisclosure).toBe(false);
  });

  it("parameterDisclosure accepts explicit values", () => {
    expect(resolveConfig({ parameterDisclosure: true }).parameterDisclosure).toBe(true);
    expect(resolveConfig({ parameterDisclosure: "high" }).parameterDisclosure).toBe("high");
    expect(resolveConfig({ parameterDisclosure: ["system.command.execute"] }).parameterDisclosure).toEqual(["system.command.execute"]);
  });

  it("throws when HOME is unset and path uses ~/", () => {
    const originalHome = process.env.HOME;
    try {
      delete process.env.HOME;
      expect(() => resolveConfig({ daemonDbPath: "~/test/db.sqlite" })).toThrow("HOME");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("daemonDbPath uses AGENTRECEIPTS_DB env var as default", () => {
    const saved = process.env.AGENTRECEIPTS_DB;
    const fakePath = join(tmpdir(), `ar-test-${randomUUID()}`, "receipts.db`");
    process.env.AGENTRECEIPTS_DB = fakePath;
    try {
      const cfg = resolveConfig();
      expect(cfg.daemonDbPath).toBe(fakePath);
    } finally {
      if (saved === undefined) delete process.env.AGENTRECEIPTS_DB;
      else process.env.AGENTRECEIPTS_DB = saved;
    }
  });
});
