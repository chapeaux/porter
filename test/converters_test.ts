/**
 * Tests for graph/converters.ts — JSON <-> RDF conversion.
 *
 * Regression coverage for a crash found while verifying the compiled-binary
 * WASM bundling fix: porterConfigToTriples() wrote config.model as an RDF
 * literal unconditionally, even though PorterConfig.model is only nominally
 * required — the actual /api/sessions/launch endpoint accepts arbitrary
 * JSON, and a team built entirely from models[] (or missing the field
 * outright) sends `model: undefined`, which threw deep inside the RDF
 * serializer and silently disabled the graph store for that session
 * ("Graph store init failed (continuing without)").
 */

import { assertEquals } from "@std/assert";
import { initGraphStore } from "../src/graph/store.ts";
import { porterConfigToTriples } from "../src/graph/converters.ts";
import type { PorterConfig } from "../src/core/config.ts";

function makeConfig(overrides: Partial<PorterConfig> = {}): PorterConfig {
  return {
    session: "test-team",
    model: "some-model",
    collaboration_pattern: "sequential",
    agents: [
      { name: "worker-1", role: "worker", system_prompt: "test", tools: ["read_file"] },
    ],
    ...overrides,
  } as PorterConfig;
}

Deno.test("porterConfigToTriples: does not throw when config.model is missing", async () => {
  const store = await initGraphStore();
  const config = makeConfig();
  delete (config as unknown as Record<string, unknown>).model;
  // Should not throw, matching real payloads from teams built via models[]
  // or per-agent model overrides rather than a top-level default model.
  porterConfigToTriples(config, store);
});

Deno.test("porterConfigToTriples: still records config.model when present", async () => {
  const store = await initGraphStore();
  const config = makeConfig({ model: "claude-sonnet-4-6" });
  porterConfigToTriples(config, store);

  const results = store.query(
    `SELECT ?model WHERE { GRAPH <https://porter.chapeaux.io/vocab#graph/config> {
       ?team porter:defaultModel ?model
     } }`,
  );

  assertEquals(results.some((r) => r.model === "claude-sonnet-4-6"), true);
});
