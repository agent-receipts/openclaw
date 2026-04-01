import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  parseCliArgs,
  helpText,
  formatReceiptsTable,
  formatVerifyResult,
  run,
} from "./cli.js";

// ---------------------------------------------------------------------------
// parseCliArgs
// ---------------------------------------------------------------------------

describe("parseCliArgs", () => {
  it("defaults to receipts command with no args", () => {
    const args = parseCliArgs([]);
    expect(args.command).toBe("receipts");
    expect(args.limit).toBe(20);
    expect(args.json).toBe(false);
  });

  it("parses receipts command with all flags", () => {
    const args = parseCliArgs([
      "receipts",
      "--risk", "high",
      "--action", "filesystem.file.read",
      "--status", "success",
      "--limit", "10",
      "--db", "/tmp/test.db",
      "--json",
    ]);

    expect(args.command).toBe("receipts");
    expect(args.risk).toBe("high");
    expect(args.action).toBe("filesystem.file.read");
    expect(args.status).toBe("success");
    expect(args.limit).toBe(10);
    expect(args.db).toBe("/tmp/test.db");
    expect(args.json).toBe(true);
  });

  it("parses verify command with chain flag", () => {
    const args = parseCliArgs(["verify", "--chain", "chain_abc", "--json"]);

    expect(args.command).toBe("verify");
    expect(args.chain).toBe("chain_abc");
    expect(args.json).toBe(true);
  });

  it("parses --help flag", () => {
    const args = parseCliArgs(["--help"]);
    expect(args.command).toBe("help");
  });

  it("parses --version flag", () => {
    const args = parseCliArgs(["--version"]);
    expect(args.command).toBe("version");
  });

  it("throws on unknown command", () => {
    expect(() => parseCliArgs(["unknown"])).toThrow('Unknown command: "unknown"');
  });

  it("throws on invalid --risk value", () => {
    expect(() => parseCliArgs(["receipts", "--risk", "extreme"])).toThrow(
      'Invalid --risk value: "extreme"',
    );
  });

  it("throws on invalid --status value", () => {
    expect(() => parseCliArgs(["receipts", "--status", "maybe"])).toThrow(
      'Invalid --status value: "maybe"',
    );
  });

  it("throws on invalid --limit value", () => {
    expect(() => parseCliArgs(["receipts", "--limit", "abc"])).toThrow(
      'Invalid --limit value: "abc"',
    );
  });

  it("throws on zero --limit", () => {
    expect(() => parseCliArgs(["receipts", "--limit", "0"])).toThrow(
      'Invalid --limit value: "0"',
    );
  });

  it("floors fractional limit values", () => {
    const args = parseCliArgs(["receipts", "--limit", "5.7"]);
    expect(args.limit).toBe(5);
  });

  it("accepts all valid risk levels", () => {
    for (const level of ["low", "medium", "high", "critical"]) {
      const args = parseCliArgs(["receipts", "--risk", level]);
      expect(args.risk).toBe(level);
    }
  });

  it("accepts all valid statuses", () => {
    for (const status of ["success", "failure", "pending"]) {
      const args = parseCliArgs(["receipts", "--status", status]);
      expect(args.status).toBe(status);
    }
  });

  it("uses default db path when not specified", () => {
    const args = parseCliArgs(["receipts"]);
    expect(args.db).toContain("receipts.db");
  });
});

// ---------------------------------------------------------------------------
// helpText
// ---------------------------------------------------------------------------

describe("helpText", () => {
  it("includes usage information", () => {
    const text = helpText();
    expect(text).toContain("openclaw-attest");
    expect(text).toContain("receipts");
    expect(text).toContain("verify");
    expect(text).toContain("--risk");
    expect(text).toContain("--action");
    expect(text).toContain("--status");
    expect(text).toContain("--limit");
    expect(text).toContain("--db");
    expect(text).toContain("--json");
    expect(text).toContain("--chain");
    expect(text).toContain("--help");
    expect(text).toContain("--version");
  });
});

// ---------------------------------------------------------------------------
// formatReceiptsTable
// ---------------------------------------------------------------------------

describe("formatReceiptsTable", () => {
  it("shows no-results message for empty list", () => {
    const output = formatReceiptsTable([], {
      total: 0,
      chains: 0,
      byRisk: [],
      byStatus: [],
      byAction: [],
    });

    expect(output).toContain("No receipts found");
    expect(output).toContain("Total receipts: 0");
  });

  it("formats stats and table headers", () => {
    const output = formatReceiptsTable([], {
      total: 5,
      chains: 2,
      byRisk: [{ risk_level: "low", count: 3 }, { risk_level: "high", count: 2 }],
      byStatus: [{ status: "success", count: 4 }, { status: "failure", count: 1 }],
      byAction: [],
    });

    expect(output).toContain("Total receipts: 5");
    expect(output).toContain("Chains: 2");
    expect(output).toContain("low: 3");
    expect(output).toContain("high: 2");
    expect(output).toContain("success: 4");
  });

  it("formats receipt rows", () => {
    const receipt = {
      "@context": ["https://www.w3.org/ns/credentials/v2", "https://attest.sh/v1"] as const,
      id: "urn:receipt:test-1",
      type: ["VerifiableCredential", "AIActionReceipt"] as const,
      version: "0.1.0",
      issuer: { id: "did:openclaw:agent" },
      issuanceDate: "2025-01-01T00:00:00Z",
      credentialSubject: {
        principal: { id: "did:session:test" },
        action: {
          id: "act-1",
          type: "filesystem.file.read",
          risk_level: "low" as const,
          target: { system: "openclaw", resource: "read_file" },
          timestamp: "2025-01-01T00:00:00Z",
        },
        outcome: { status: "success" as const },
        chain: { sequence: 1, previous_receipt_hash: null, chain_id: "chain_test" },
      },
      proof: { type: "Ed25519Signature2020", proofValue: "abc" },
    };

    const output = formatReceiptsTable([receipt], {
      total: 1,
      chains: 1,
      byRisk: [{ risk_level: "low", count: 1 }],
      byStatus: [{ status: "success", count: 1 }],
      byAction: [{ action_type: "filesystem.file.read", count: 1 }],
    });

    expect(output).toContain("filesystem.file.read");
    expect(output).toContain("low");
    expect(output).toContain("success");
    expect(output).toContain("read_file");
    expect(output).toContain("Showing 1 of 1 receipts");
  });
});

// ---------------------------------------------------------------------------
// formatVerifyResult
// ---------------------------------------------------------------------------

describe("formatVerifyResult", () => {
  it("formats valid chain", () => {
    const output = formatVerifyResult("chain_test", {
      valid: true,
      length: 3,
      brokenAt: -1,
      receipts: [],
    });

    expect(output).toContain("VALID");
    expect(output).toContain("3 receipts");
    expect(output).toContain("signatures and hash links verified");
  });

  it("formats broken chain", () => {
    const output = formatVerifyResult("chain_test", {
      valid: false,
      length: 3,
      brokenAt: 2,
      receipts: [
        { index: 0, receiptId: "r-0", signatureValid: true, hashLinkValid: true, sequenceValid: true },
        { index: 1, receiptId: "r-1", signatureValid: true, hashLinkValid: true, sequenceValid: true },
        { index: 2, receiptId: "r-2", signatureValid: false, hashLinkValid: false, sequenceValid: true },
      ],
    });

    expect(output).toContain("BROKEN at position 2");
    expect(output).toContain("Tamper detected");
    expect(output).toContain("r-2");
    expect(output).toContain("signature");
    expect(output).toContain("hash link");
  });
});

// ---------------------------------------------------------------------------
// run (integration with mocked stdout)
// ---------------------------------------------------------------------------

describe("run", () => {
  let stdoutData: string;
  let originalWrite: typeof process.stdout.write;
  let originalErrWrite: typeof process.stderr.write;

  beforeEach(() => {
    stdoutData = "";
    originalWrite = process.stdout.write;
    originalErrWrite = process.stderr.write;
    process.stdout.write = ((chunk: string) => {
      stdoutData += chunk;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((_chunk: string) => {
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
    process.stderr.write = originalErrWrite;
  });

  it("outputs help text with --help", () => {
    run(["--help"]);
    expect(stdoutData).toContain("openclaw-attest");
    expect(stdoutData).toContain("receipts");
    expect(stdoutData).toContain("verify");
  });

  it("outputs version with --version", () => {
    run(["--version"]);
    expect(stdoutData).toContain("openclaw-attest v");
  });

  it("throws on unknown command", () => {
    expect(() => run(["badcmd"])).toThrow('Unknown command: "badcmd"');
  });

  it("throws on invalid risk level", () => {
    expect(() => run(["receipts", "--risk", "extreme"])).toThrow("Invalid --risk value");
  });
});
