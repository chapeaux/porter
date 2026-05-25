/**
 * Tests for model_registry.ts — dynamic model registry.
 */

import {
  assertEquals,
  assertExists,
} from "@std/assert";
import { ModelRegistry } from "../src/core/model_registry.ts";
import type { ModelConfig } from "../src/auth/model_store.ts";
import type { ProviderConfig } from "../src/providers/types.ts";

function makeModel(overrides: Partial<ModelConfig> & { id: string }): ModelConfig {
  return {
    display_name: overrides.id,
    provider_type: "openai_compat",
    base_url: "https://api.example.com",
    auth: "bearer",
    context_window: 128000,
    max_tokens: 4096,
    capabilities: { tool_calling: true, reasoning: false, vision: false, json_mode: false },
    ...overrides,
  };
}

Deno.test("ModelRegistry: register and lookup", () => {
  const registry = new ModelRegistry();
  const model = makeModel({ id: "gpt-4o", display_name: "GPT-4o" });
  registry.register(model);

  const found = registry.lookup("gpt-4o");
  assertExists(found);
  assertEquals(found!.display_name, "GPT-4o");
});

Deno.test("ModelRegistry: lookup unknown returns undefined", () => {
  const registry = new ModelRegistry();
  assertEquals(registry.lookup("unknown"), undefined);
});

Deno.test("ModelRegistry: unregister removes model", () => {
  const registry = new ModelRegistry();
  registry.register(makeModel({ id: "test-model" }));
  assertEquals(registry.size(), 1);

  const removed = registry.unregister("test-model");
  assertEquals(removed, true);
  assertEquals(registry.size(), 0);
  assertEquals(registry.lookup("test-model"), undefined);
});

Deno.test("ModelRegistry: unregister missing returns false", () => {
  const registry = new ModelRegistry();
  assertEquals(registry.unregister("nonexistent"), false);
});

Deno.test("ModelRegistry: list returns all models", () => {
  const registry = new ModelRegistry();
  registry.register(makeModel({ id: "model-a" }));
  registry.register(makeModel({ id: "model-b" }));
  registry.register(makeModel({ id: "model-c" }));

  const all = registry.list();
  assertEquals(all.length, 3);
  assertEquals(all.map(m => m.id).sort(), ["model-a", "model-b", "model-c"]);
});

Deno.test("ModelRegistry: listAgentModels returns all models", () => {
  const registry = new ModelRegistry();
  registry.register(makeModel({ id: "agent-model" }));
  const agents = registry.listAgentModels();
  assertEquals(agents.length, 1);
  assertEquals(agents[0].id, "agent-model");
});

Deno.test("ModelRegistry: fromModels creates populated registry", () => {
  const models = [
    makeModel({ id: "m1" }),
    makeModel({ id: "m2" }),
  ];
  const registry = ModelRegistry.fromModels(models);
  assertEquals(registry.size(), 2);
  assertExists(registry.lookup("m1"));
  assertExists(registry.lookup("m2"));
});

Deno.test("ModelRegistry: merge combines registries", () => {
  const base = ModelRegistry.fromModels([makeModel({ id: "base-model" })]);
  const overlay = ModelRegistry.fromModels([makeModel({ id: "overlay-model" })]);

  const merged = ModelRegistry.merge(base, overlay);
  assertEquals(merged.size(), 2);
  assertExists(merged.lookup("base-model"));
  assertExists(merged.lookup("overlay-model"));
});

Deno.test("ModelRegistry: merge overlay overwrites base", () => {
  const base = ModelRegistry.fromModels([
    makeModel({ id: "shared", display_name: "Original" }),
  ]);
  const overlay = ModelRegistry.fromModels([
    makeModel({ id: "shared", display_name: "Updated" }),
  ]);

  const merged = ModelRegistry.merge(base, overlay);
  assertEquals(merged.size(), 1);
  assertEquals(merged.lookup("shared")!.display_name, "Updated");
});

Deno.test("ModelRegistry: resolveProvider matches by provider_type", () => {
  const registry = ModelRegistry.fromModels([
    makeModel({ id: "claude-4", provider_type: "anthropic" }),
  ]);

  const providers: ProviderConfig[] = [
    { type: "openai_compat", base_url: "https://openai.example.com" },
    { type: "anthropic", base_url: "https://anthropic.example.com" },
  ];

  const result = registry.resolveProvider("claude-4", providers);
  assertExists(result);
  assertEquals(result!.type, "anthropic");
  assertEquals(result!.base_url, "https://anthropic.example.com");
});

Deno.test("ModelRegistry: resolveProvider builds config from model when no matching provider", () => {
  const registry = ModelRegistry.fromModels([
    makeModel({ id: "local-llama", provider_type: "ollama", base_url: "http://localhost:11434" }),
  ]);

  const providers: ProviderConfig[] = [
    { type: "openai_compat", base_url: "https://other.example.com" },
  ];

  const result = registry.resolveProvider("local-llama", providers);
  assertExists(result);
  assertEquals(result!.type, "ollama");
  assertEquals(result!.base_url, "http://localhost:11434");
});

Deno.test("ModelRegistry: resolveProvider returns first provider for unknown model", () => {
  const registry = new ModelRegistry();
  const providers: ProviderConfig[] = [
    { type: "openai_compat", base_url: "https://fallback.example.com" },
  ];

  const result = registry.resolveProvider("unknown-model", providers);
  assertExists(result);
  assertEquals(result!.base_url, "https://fallback.example.com");
});

Deno.test("ModelRegistry: register replaces existing model", () => {
  const registry = new ModelRegistry();
  registry.register(makeModel({ id: "m1", display_name: "V1" }));
  registry.register(makeModel({ id: "m1", display_name: "V2" }));
  assertEquals(registry.size(), 1);
  assertEquals(registry.lookup("m1")!.display_name, "V2");
});

Deno.test("ModelRegistry: empty registry has size 0", () => {
  const registry = new ModelRegistry();
  assertEquals(registry.size(), 0);
  assertEquals(registry.list().length, 0);
  assertEquals(registry.listAgentModels().length, 0);
});
