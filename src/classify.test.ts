import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { classify, loadCustomMappings, DEFAULT_MAPPINGS } from "./classify.js";

describe("classify", () => {
  it("maps read_file to filesystem.file.read with low risk", () => {
    const result = classify("read_file", DEFAULT_MAPPINGS);

    expect(result.action_type).toBe("filesystem.file.read");
    expect(result.risk_level).toBe("low");
  });

  it("maps edit_file to filesystem.file.modify with medium risk", () => {
    const result = classify("edit_file", DEFAULT_MAPPINGS);

    expect(result.action_type).toBe("filesystem.file.modify");
    expect(result.risk_level).toBe("medium");
  });

  it("maps delete_file to filesystem.file.delete with high risk", () => {
    const result = classify("delete_file", DEFAULT_MAPPINGS);

    expect(result.action_type).toBe("filesystem.file.delete");
    expect(result.risk_level).toBe("high");
  });

  it("maps run_command to system.command.execute with high risk", () => {
    const result = classify("run_command", DEFAULT_MAPPINGS);

    expect(result.action_type).toBe("system.command.execute");
    expect(result.risk_level).toBe("high");
  });

  it("maps browser_navigate to system.browser.navigate with low risk", () => {
    const result = classify("browser_navigate", DEFAULT_MAPPINGS);

    expect(result.action_type).toBe("system.browser.navigate");
    expect(result.risk_level).toBe("low");
  });

  it("falls back to unknown for unmapped tools", () => {
    const result = classify("some_custom_tool_xyz", DEFAULT_MAPPINGS);

    expect(result.action_type).toBe("unknown");
    expect(result.risk_level).toBe("medium");
  });

  // OpenClaw built-in tools (short names used by the openclaw runtime)
  it("maps exec to system.command.execute with high risk", () => {
    const result = classify("exec", DEFAULT_MAPPINGS);
    expect(result.action_type).toBe("system.command.execute");
    expect(result.risk_level).toBe("high");
  });

  it("maps read to filesystem.file.read with low risk", () => {
    const result = classify("read", DEFAULT_MAPPINGS);
    expect(result.action_type).toBe("filesystem.file.read");
    expect(result.risk_level).toBe("low");
  });

  it("maps write to filesystem.file.create with low risk", () => {
    const result = classify("write", DEFAULT_MAPPINGS);
    expect(result.action_type).toBe("filesystem.file.create");
    expect(result.risk_level).toBe("low");
  });

  it("maps edit to filesystem.file.modify with medium risk", () => {
    const result = classify("edit", DEFAULT_MAPPINGS);
    expect(result.action_type).toBe("filesystem.file.modify");
    expect(result.risk_level).toBe("medium");
  });

  it("maps apply_patch to filesystem.file.modify with medium risk", () => {
    const result = classify("apply_patch", DEFAULT_MAPPINGS);
    expect(result.action_type).toBe("filesystem.file.modify");
    expect(result.risk_level).toBe("medium");
  });

  it("maps web_fetch to system.browser.navigate with low risk", () => {
    const result = classify("web_fetch", DEFAULT_MAPPINGS);
    expect(result.action_type).toBe("system.browser.navigate");
    expect(result.risk_level).toBe("low");
  });

  it("maps web_search to system.browser.navigate with low risk", () => {
    const result = classify("web_search", DEFAULT_MAPPINGS);
    expect(result.action_type).toBe("system.browser.navigate");
    expect(result.risk_level).toBe("low");
  });

  it("maps sessions_spawn to system.application.launch with low risk", () => {
    const result = classify("sessions_spawn", DEFAULT_MAPPINGS);
    expect(result.action_type).toBe("system.application.launch");
    expect(result.risk_level).toBe("low");
  });

  it("maps process to system.command.execute with high risk", () => {
    const result = classify("process", DEFAULT_MAPPINGS);
    expect(result.action_type).toBe("system.command.execute");
    expect(result.risk_level).toBe("high");
  });
});

describe("loadCustomMappings", () => {
  let tempDir: string;

  afterEach(() => {
    if (tempDir) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it("overrides default mappings with custom ones", () => {
    tempDir = join(tmpdir(), `attest-taxonomy-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    const taxPath = join(tempDir, "taxonomy.json");

    // Remap read_file to a different canonical action type
    writeFileSync(taxPath, JSON.stringify({
      mappings: [
        { tool_name: "read_file", action_type: "filesystem.file.delete" },
      ],
    }));

    const merged = loadCustomMappings(taxPath);

    const result = classify("read_file", merged);
    expect(result.action_type).toBe("filesystem.file.delete");
    expect(result.risk_level).toBe("high"); // delete is high risk
  });

  it("preserves default mappings for tools not in custom file", () => {
    tempDir = join(tmpdir(), `attest-taxonomy-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    const taxPath = join(tempDir, "taxonomy.json");

    // Add a new tool mapping using a canonical action type
    writeFileSync(taxPath, JSON.stringify({
      mappings: [
        { tool_name: "my_new_tool", action_type: "system.command.execute" },
      ],
    }));

    const merged = loadCustomMappings(taxPath);

    // Custom tool maps to the specified canonical action type
    const custom = classify("my_new_tool", merged);
    expect(custom.action_type).toBe("system.command.execute");

    // Default still works
    const defaultResult = classify("delete_file", merged);
    expect(defaultResult.action_type).toBe("filesystem.file.delete");
  });

  it("throws on missing file", () => {
    expect(() => loadCustomMappings("/nonexistent/taxonomy.json")).toThrow();
  });

  it("throws on malformed JSON", () => {
    tempDir = join(tmpdir(), `attest-taxonomy-${randomUUID()}`);
    mkdirSync(tempDir, { recursive: true });
    const taxPath = join(tempDir, "taxonomy.json");

    writeFileSync(taxPath, "not valid json {{{");

    expect(() => loadCustomMappings(taxPath)).toThrow();
  });
});
