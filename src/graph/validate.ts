/**
 * SHACL validation bridge for Porter configs.
 *
 * Converts a PorterConfig to RDF and runs it through the GraphStore's
 * SHACL validator. Returns a structured result — callers decide whether
 * to treat violations as fatal or advisory.
 */

import { GraphStore } from "./store.ts";
import { porterConfigToTriples } from "./converters.ts";
import { GRAPHS } from "./vocabulary.ts";
import type { PorterConfig } from "../core/config.ts";

export interface ValidationResult {
  conforms: boolean;
  violations: { path: string; message: string; value?: string }[];
}

/**
 * Validate a PorterConfig by converting to RDF and checking SHACL shapes.
 * Returns the validation result. Does not throw — callers decide how to
 * handle violations.
 */
export async function validateConfig(config: PorterConfig): Promise<ValidationResult> {
  try {
    const store = await GraphStore.create();
    porterConfigToTriples(config, store);
    return store.validate(GRAPHS.config);
  } catch (err) {
    return {
      conforms: false,
      violations: [{ path: "", message: `Validation error: ${(err as Error).message}` }],
    };
  }
}
