import { readFileSync } from "node:fs";
import {
  classifyToolCall,
  type ClassificationResult,
  type TaxonomyMapping,
} from "@attest-protocol/attest-ts/taxonomy";

// Default mappings bundled with the plugin
import defaultMappings from "../taxonomy.json" with { type: "json" };

let activeMappings: TaxonomyMapping[] = defaultMappings.mappings;

/**
 * Load custom taxonomy mappings from a JSON file, merging with defaults.
 * Custom mappings take precedence (matched by tool_name).
 */
export function loadCustomMappings(filePath: string): void {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as { mappings: TaxonomyMapping[] };

  const customByName = new Map(
    parsed.mappings.map((m) => [m.tool_name, m]),
  );

  // Merge: custom overrides defaults
  activeMappings = [
    ...parsed.mappings,
    ...defaultMappings.mappings.filter((m: TaxonomyMapping) => !customByName.has(m.tool_name)),
  ];
}

/**
 * Classify an OpenClaw tool call into an attest-ts action type and risk level.
 */
export function classify(toolName: string): ClassificationResult {
  return classifyToolCall(toolName, activeMappings);
}
