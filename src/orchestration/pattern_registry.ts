/**
 * Pattern registry — loads, registers, and validates collaboration pattern definitions.
 *
 * Built-in patterns are bundled as JSON files in src/orchestration/patterns/.
 * Custom patterns are stored per-user via UserStore.
 */

import { join } from "@std/path";

export interface PatternRole {
  id: string;
  name: string;
  description: string;
  min: number;
  max: number;
  system_prompt_suffix: string;
  auto_tools: string[];
  subscribe: string[];
  subscribe_dynamic?: string;
  default_tools: string[];
}

export interface PatternDefinition {
  id: string;
  name: string;
  description: string;
  bus_flow: string;
  builtin: boolean;
  roles: PatternRole[];
  max_rounds?: number;
}

export interface CompositionError {
  roleId: string;
  roleName: string;
  message: string;
}

export interface CompositionResult {
  valid: boolean;
  errors: CompositionError[];
}

const registry = new Map<string, PatternDefinition>();

function loadBuiltinJson(filename: string): PatternDefinition {
  const dir = new URL("./patterns/", import.meta.url);
  const text = Deno.readTextFileSync(new URL(filename, dir));
  return JSON.parse(text) as PatternDefinition;
}

let _initialized = false;

function ensureInitialized(): void {
  if (_initialized) return;
  _initialized = true;

  const builtins = ["sequential.json", "mixture.json", "deliberation.json", "distillation.json"];
  for (const file of builtins) {
    try {
      const pattern = loadBuiltinJson(file);
      pattern.builtin = true;
      registry.set(pattern.id, pattern);
    } catch (err) {
      console.error(`[patterns] Failed to load built-in pattern ${file}: ${(err as Error).message}`);
    }
  }
}

/** Get a pattern definition by ID. */
export function getPattern(id: string): PatternDefinition | null {
  ensureInitialized();
  return registry.get(id) ?? null;
}

/** List all registered patterns (built-in + custom). */
export function listPatterns(): PatternDefinition[] {
  ensureInitialized();
  return [...registry.values()];
}

/** Register a custom pattern definition. */
export function registerCustomPattern(pattern: PatternDefinition): void {
  ensureInitialized();
  pattern.builtin = false;
  registry.set(pattern.id, pattern);
}

/** Remove a custom pattern. Built-in patterns cannot be removed. */
export function removePattern(id: string): boolean {
  ensureInitialized();
  const pattern = registry.get(id);
  if (!pattern || pattern.builtin) return false;
  return registry.delete(id);
}

/**
 * Validate a team's agent composition against a pattern definition.
 * Checks that each role's min/max requirements are satisfied.
 */
export function validateTeamComposition(
  pattern: PatternDefinition,
  agents: Array<{ role: string }>,
): CompositionResult {
  const errors: CompositionError[] = [];

  for (const role of pattern.roles) {
    const count = agents.filter((a) => a.role === role.id).length;

    if (count < role.min) {
      errors.push({
        roleId: role.id,
        roleName: role.name,
        message: role.min === 1
          ? `Requires a ${role.name}`
          : `Requires at least ${role.min} ${role.name}s (have ${count})`,
      });
    }

    if (count > role.max) {
      errors.push({
        roleId: role.id,
        roleName: role.name,
        message: `Maximum ${role.max} ${role.name}${role.max > 1 ? "s" : ""} allowed (have ${count})`,
      });
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Get the role definition for an agent within a pattern.
 */
export function getRole(
  patternId: string,
  roleId: string,
): PatternRole | null {
  const pattern = getPattern(patternId);
  if (!pattern) return null;
  return pattern.roles.find((r) => r.id === roleId) ?? null;
}

/**
 * Get a human-readable summary of a pattern's composition requirements.
 */
export function getCompositionSummary(pattern: PatternDefinition): string {
  return pattern.roles
    .map((r) => {
      if (r.min === r.max) return `${r.min} ${r.name}${r.min > 1 ? "s" : ""}`;
      if (r.min === 0) return `up to ${r.max} ${r.name}${r.max > 1 ? "s" : ""} (optional)`;
      return `${r.min}-${r.max} ${r.name}${r.max > 1 ? "s" : ""}`;
    })
    .join(" + ");
}

/** Reset registry to built-ins only. Used in tests. */
export function resetPatternRegistry(): void {
  registry.clear();
  _initialized = false;
}
