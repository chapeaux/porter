/**
 * Pattern registry — loads, registers, and validates collaboration pattern definitions.
 *
 * Built-in patterns are bundled as JSON-LD files in src/orchestration/patterns/.
 * Custom patterns are stored per-user via UserStore.
 */

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
  // Prefer .jsonld, fall back to .json
  const baseName = filename.replace(/\.json$/, "");
  let text: string;
  try {
    text = Deno.readTextFileSync(new URL(`${baseName}.jsonld`, dir));
  } catch {
    text = Deno.readTextFileSync(new URL(`${baseName}.json`, dir));
  }
  const raw = JSON.parse(text) as Record<string, unknown>;
  return jsonLdToPattern(raw);
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

// ---------------------------------------------------------------------------
// JSON-LD conversion helpers
// ---------------------------------------------------------------------------

/** Inline @context used in pattern .jsonld files. */
const PATTERN_JSONLD_CONTEXT = {
  "porter": "https://porter.chapeaux.io/vocab#",
  "xsd": "http://www.w3.org/2001/XMLSchema#",
  "id": "@id",
  "type": "@type",
  "name": "porter:name",
  "description": "porter:description",
  "bus_flow": "porter:busFlow",
  "builtin": { "@id": "porter:isBuiltin", "@type": "xsd:boolean" },
  "max_rounds": { "@id": "porter:maxRounds", "@type": "xsd:integer" },
  "roles": { "@id": "porter:hasRole", "@container": "@set" },
  "min": { "@id": "porter:minCount", "@type": "xsd:integer" },
  "max": { "@id": "porter:maxCount", "@type": "xsd:integer" },
  "system_prompt_suffix": "porter:systemPromptSuffix",
  "auto_tools": { "@id": "porter:autoTool", "@container": "@set" },
  "subscribe": { "@id": "porter:subscribesTo", "@container": "@set" },
  "subscribe_dynamic": "porter:subscribeDynamic",
  "default_tools": { "@id": "porter:defaultTool", "@container": "@set" },
  "Pattern": "porter:Pattern",
  "PatternRole": "porter:PatternRole",
} as const;

/**
 * Convert a PatternDefinition to a JSON-LD document.
 * Adds @context, @type, @id and annotates roles with PatternRole type.
 */
export function patternToJsonLd(
  pattern: PatternDefinition,
): Record<string, unknown> {
  return {
    "@context": { ...PATTERN_JSONLD_CONTEXT },
    "@id": `porter:pattern/${pattern.id}`,
    "@type": "Pattern",
    id: pattern.id,
    name: pattern.name,
    description: pattern.description,
    bus_flow: pattern.bus_flow,
    builtin: pattern.builtin,
    ...(pattern.max_rounds !== undefined ? { max_rounds: pattern.max_rounds } : {}),
    roles: pattern.roles.map((r) => ({
      "@type": "PatternRole",
      id: r.id,
      name: r.name,
      description: r.description,
      min: r.min,
      max: r.max,
      system_prompt_suffix: r.system_prompt_suffix,
      auto_tools: r.auto_tools,
      subscribe: r.subscribe,
      ...(r.subscribe_dynamic ? { subscribe_dynamic: r.subscribe_dynamic } : {}),
      default_tools: r.default_tools,
    })),
  };
}

/**
 * Parse a JSON-LD pattern document back to the internal PatternDefinition type.
 * Strips @context, @type, @id and maps hasRole back to roles if present.
 */
export function jsonLdToPattern(
  doc: Record<string, unknown>,
): PatternDefinition {
  // deno-lint-ignore no-explicit-any
  const d = doc as any;

  // Roles may appear as "roles" (inline context maps it) or "hasRole" (external context)
  const rawRoles: unknown[] = d.roles ?? d.hasRole ?? [];
  const roles: PatternRole[] = (rawRoles as Record<string, unknown>[]).map(
    (r) => ({
      id: (r.roleId ?? r.id) as string,
      name: r.name as string,
      description: (r.description ?? "") as string,
      min: (r.minCount ?? r.min ?? 0) as number,
      max: (r.maxCount ?? r.max ?? 1) as number,
      system_prompt_suffix: (r.systemPromptSuffix ?? r.system_prompt_suffix ?? "") as string,
      auto_tools: (r.autoTool ?? r.auto_tools ?? []) as string[],
      subscribe: (r.subscribesTo ?? r.subscribe ?? []) as string[],
      ...(r.subscribe_dynamic || r.subscribeDynamic
        ? { subscribe_dynamic: (r.subscribeDynamic ?? r.subscribe_dynamic) as string }
        : {}),
      default_tools: (r.defaultTool ?? r.default_tools ?? []) as string[],
    }),
  );

  return {
    id: d.id as string,
    name: d.name as string,
    description: (d.description ?? "") as string,
    bus_flow: (d.busFlow ?? d.bus_flow ?? "") as string,
    builtin: (d.isBuiltin ?? d.builtin ?? false) as boolean,
    roles,
    ...(d.max_rounds !== undefined || d.maxRounds !== undefined
      ? { max_rounds: (d.maxRounds ?? d.max_rounds) as number }
      : {}),
  };
}

/** Reset registry to built-ins only. Used in tests. */
export function resetPatternRegistry(): void {
  registry.clear();
  _initialized = false;
}
