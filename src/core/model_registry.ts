/**
 * Dynamic model registry — replaces the hardcoded catalog.
 *
 * Models are registered from porter.json (config.models) and/or the
 * per-user ModelStore. The registry provides lookup, listing, and
 * provider resolution for agent model selection.
 */

import type { ModelConfig, ProviderType } from "../auth/model_store.ts";
import type { ProviderConfig } from "../providers/types.ts";

export type { ModelConfig, ProviderType } from "../auth/model_store.ts";

export class ModelRegistry {
  private models = new Map<string, ModelConfig>();

  register(model: ModelConfig): void {
    this.models.set(model.id, model);
  }

  unregister(modelId: string): boolean {
    return this.models.delete(modelId);
  }

  lookup(modelId: string): ModelConfig | undefined {
    return this.models.get(modelId);
  }

  list(): ModelConfig[] {
    return [...this.models.values()];
  }

  listAgentModels(): ModelConfig[] {
    return this.list();
  }

  size(): number {
    return this.models.size;
  }

  resolveProvider(modelId: string, providers: ProviderConfig[]): ProviderConfig | null {
    const model = this.lookup(modelId);
    if (!model) return providers[0] ?? null;

    for (const p of providers) {
      if (p.type === model.provider_type) return p;
    }

    return {
      type: model.provider_type as ProviderConfig["type"],
      base_url: model.base_url,
      api_key_env: model.api_key_env,
      auth: model.auth === "adc" ? "adc" : "bearer",
    };
  }

  static fromModels(models: ModelConfig[]): ModelRegistry {
    const registry = new ModelRegistry();
    for (const m of models) {
      registry.register(m);
    }
    return registry;
  }

  static merge(base: ModelRegistry, overlay: ModelRegistry): ModelRegistry {
    const merged = new ModelRegistry();
    for (const m of base.list()) merged.register(m);
    for (const m of overlay.list()) merged.register(m);
    return merged;
  }
}
