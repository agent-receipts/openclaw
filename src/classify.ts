import { readFileSync } from "node:fs";
import {
  classifyToolCall,
  resolveActionType,
  type ClassificationResult,
  type TaxonomyMapping,
} from "@agnt-rcpt/sdk-ts/taxonomy";

// Default mappings bundled with the plugin
import defaultTaxonomy from "../taxonomy.json" with { type: "json" };

export { type TaxonomyMapping } from "@agnt-rcpt/sdk-ts/taxonomy";

export interface TaxonomyPattern {
  prefix: string;
  action_type: string;
}

/** Extends the SDK's TaxonomyMapping with optional disclosure field names. */
export interface ExtendedTaxonomyMapping extends TaxonomyMapping {
  disclosure_fields?: string[];
}

/** Extends ClassificationResult with disclosure field names from the matched mapping. */
export interface ExtendedClassificationResult extends ClassificationResult {
  disclosure_fields?: string[];
}

/** The bundled default mappings, exported for use when no custom taxonomy is configured. */
export const DEFAULT_MAPPINGS: ExtendedTaxonomyMapping[] = defaultTaxonomy.mappings;

/** The bundled default patterns, exported for use when no custom taxonomy is configured. */
export const DEFAULT_PATTERNS: TaxonomyPattern[] = defaultTaxonomy.patterns;

/**
 * Load custom taxonomy mappings and patterns from a JSON file, merging with defaults.
 * Custom entries take precedence (matched by tool_name for mappings, by prefix for patterns).
 *
 * Pure function — returns the merged result without side effects.
 */
export function loadCustomMappings(filePath: string): { mappings: ExtendedTaxonomyMapping[]; patterns: TaxonomyPattern[] } {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as { mappings?: ExtendedTaxonomyMapping[]; patterns?: TaxonomyPattern[] };

  const customMappings = parsed.mappings ?? [];
  const customByName = new Map(
    customMappings.map((m) => [m.tool_name, m]),
  );

  // Merge mappings: custom overrides defaults
  const mappings: ExtendedTaxonomyMapping[] = [
    ...customMappings,
    ...defaultTaxonomy.mappings.filter((m: ExtendedTaxonomyMapping) => !customByName.has(m.tool_name)),
  ];

  // Merge patterns: custom overrides defaults by prefix
  const customPatterns = parsed.patterns ?? [];
  const customPrefixes = new Set(customPatterns.map((p) => p.prefix));
  const patterns = [
    ...customPatterns,
    ...defaultTaxonomy.patterns.filter((p: TaxonomyPattern) => !customPrefixes.has(p.prefix)),
  ];

  return { mappings, patterns };
}

/**
 * Classify an OpenClaw tool call into an sdk-ts action type and risk level.
 * Returns disclosure_fields from the matched mapping entry if present.
 *
 * Lookup order: exact match → prefix pattern → unknown.
 */
export function classify(
  toolName: string,
  mappings: ExtendedTaxonomyMapping[],
  patterns: TaxonomyPattern[] = [],
): ExtendedClassificationResult {
  // 1. Try exact match
  const exact = classifyToolCall(toolName, mappings);
  if (exact.action_type !== "unknown") {
    const matched = mappings.find((m) => m.tool_name === toolName);
    return { ...exact, disclosure_fields: matched?.disclosure_fields };
  }

  // 2. Try prefix patterns (first match wins, order matters)
  for (const p of patterns) {
    if (toolName.startsWith(p.prefix)) {
      const entry = resolveActionType(p.action_type);
      return {
        action_type: entry.type,
        risk_level: entry.risk_level,
      };
    }
  }

  // 3. Fall back to unknown
  return exact;
}
