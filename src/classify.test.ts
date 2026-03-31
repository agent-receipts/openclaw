import { describe, expect, it } from "vitest";
import { classify } from "./classify.js";

describe("classify", () => {
  it("maps read_file to filesystem.file.read with low risk", () => {
    const result = classify("read_file");

    expect(result.action_type).toBe("filesystem.file.read");
    expect(result.risk_level).toBe("low");
  });

  it("maps edit_file to filesystem.file.modify with medium risk", () => {
    const result = classify("edit_file");

    expect(result.action_type).toBe("filesystem.file.modify");
    expect(result.risk_level).toBe("medium");
  });

  it("maps delete_file to filesystem.file.delete with high risk", () => {
    const result = classify("delete_file");

    expect(result.action_type).toBe("filesystem.file.delete");
    expect(result.risk_level).toBe("high");
  });

  it("maps run_command to system.command.execute with high risk", () => {
    const result = classify("run_command");

    expect(result.action_type).toBe("system.command.execute");
    expect(result.risk_level).toBe("high");
  });

  it("maps browser_navigate to system.browser.navigate with low risk", () => {
    const result = classify("browser_navigate");

    expect(result.action_type).toBe("system.browser.navigate");
    expect(result.risk_level).toBe("low");
  });

  it("falls back to unknown for unmapped tools", () => {
    const result = classify("some_custom_tool_xyz");

    expect(result.action_type).toBe("unknown");
    expect(result.risk_level).toBe("medium");
  });
});
