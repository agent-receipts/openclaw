import { readFileSync } from "node:fs";
import {
  classifyToolCall,
  type ClassificationResult,
  type TaxonomyMapping,
} from "@attest-protocol/attest-ts/taxonomy";

// Default mappings bundled with the plugin
import defaultMappings from "../taxonomy.json" with { type: "json" };

export { type TaxonomyMapping } from "@attest-protocol/attest-ts/taxonomy";

/** The bundled default mappings, exported for use when no custom taxonomy is configured. */
export const DEFAULT_MAPPINGS: TaxonomyMapping[] = defaultMappings.mappings;

/**
 * Load custom taxonomy mappings from a JSON file, merging with defaults.
 * Custom mappings take precedence (matched by tool_name).
 *
 * Pure function — returns the merged mappings without side effects.
 */
export function loadCustomMappings(filePath: string): TaxonomyMapping[] {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as { mappings: TaxonomyMapping[] };

  const customByName = new Map(
    parsed.mappings.map((m) => [m.tool_name, m]),
  );

  // Merge: custom overrides defaults
  return [
    ...parsed.mappings,
    ...defaultMappings.mappings.filter((m: TaxonomyMapping) => !customByName.has(m.tool_name)),
  ];
}

/**
 * Classify an OpenClaw tool call into an attest-ts action type and risk level.
 */
export function classify(toolName: string, mappings: TaxonomyMapping[]): ClassificationResult {
  return classifyToolCall(toolName, mappings);
}
