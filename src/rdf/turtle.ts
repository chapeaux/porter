/**
 * RDF Turtle parser/writer using N3.js.
 *
 * Provides high-level converters between Turtle strings and Porter
 * resource types (agents, teams, models, MCP servers, patterns,
 * federation config). Also handles consolidated export/import as
 * JSON-LD @graph documents.
 *
 * Replaces the regex-based parsers in sync-helpers.js.
 */

import { Parser, Writer, DataFactory } from "n3";
import type { Quad, NamedNode, Literal } from "n3";
import type { SavedAgent, SavedTeam } from "../auth/user_store.ts";
import { PORTER } from "../graph/vocabulary.ts";

const { namedNode, literal, quad: makeQuad, defaultGraph } = DataFactory;

const PORTER_NS = "https://porter.chapeaux.io/vocab#";
const XSD_NS = "http://www.w3.org/2001/XMLSchema#";
const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";

const PREFIXES: Record<string, string> = {
  porter: PORTER_NS,
  xsd: XSD_NS,
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
};

// ---------------------------------------------------------------------------
// Low-level parse/write
// ---------------------------------------------------------------------------

/** Parse a Turtle string into an array of Quads. */
export function parseTurtle(turtle: string): Quad[] {
  const parser = new Parser();
  return parser.parse(turtle);
}

/** Write Quads to a Turtle string with Porter prefixes. */
export function writeTurtle(quads: Quad[]): string {
  const writer = new Writer({ prefixes: PREFIXES });
  for (const q of quads) writer.addQuad(q);
  let result = "";
  writer.end((_err: Error | null, output: string) => { result = output; });
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getValues(quads: Quad[], subject: string, predicate: string): string[] {
  return quads
    .filter(q => q.subject.value === subject && q.predicate.value === predicate)
    .map(q => q.object.value);
}

function getValue(quads: Quad[], subject: string, predicate: string): string | undefined {
  return getValues(quads, subject, predicate)[0];
}

function getType(quads: Quad[], subject: string): string | undefined {
  return getValue(quads, subject, RDF_TYPE);
}

function findSubjectByType(quads: Quad[], type: string): string | undefined {
  const q = quads.find(q => q.predicate.value === RDF_TYPE && q.object.value === type);
  return q?.subject.value;
}

function litQuad(subject: string, predicate: string, value: string | number | boolean): Quad {
  let obj;
  if (typeof value === "boolean") {
    obj = literal(String(value), namedNode(`${XSD_NS}boolean`));
  } else if (typeof value === "number") {
    obj = literal(String(value), namedNode(Number.isInteger(value) ? `${XSD_NS}integer` : `${XSD_NS}float`));
  } else {
    obj = literal(value);
  }
  return makeQuad(namedNode(subject), namedNode(predicate), obj) as unknown as Quad;
}

function iriQuad(subject: string, predicate: string, object: string): Quad {
  return makeQuad(namedNode(subject), namedNode(predicate), namedNode(object)) as unknown as Quad;
}

// ---------------------------------------------------------------------------
// Agent converters
// ---------------------------------------------------------------------------

export function turtleToAgent(turtle: string): SavedAgent | null {
  const quads = parseTurtle(turtle);
  const subject = findSubjectByType(quads, `${PORTER_NS}Agent`);
  if (!subject) return null;

  const name = getValue(quads, subject, `${PORTER_NS}name`);
  if (!name) return null;

  return {
    name,
    role: getValue(quads, subject, `${PORTER_NS}assignedRole`) ?? "worker",
    model: getValue(quads, subject, `${PORTER_NS}usesModel`),
    system_prompt: getValue(quads, subject, `${PORTER_NS}agentExpertise`) ?? "",
    tools: getValues(quads, subject, `${PORTER_NS}hasTool`),
    channels: getValues(quads, subject, `${PORTER_NS}subscribesTo`),
    mcp_tools: getValues(quads, subject, `${PORTER_NS}hasMcpTool`),
    max_tokens: parseInt(getValue(quads, subject, `${PORTER_NS}maxTokens`) ?? "8192"),
    max_turns: parseInt(getValue(quads, subject, `${PORTER_NS}maxTurns`) ?? "") || undefined,
    max_context_tokens: parseInt(getValue(quads, subject, `${PORTER_NS}maxContextTokens`) ?? "") || undefined,
    reasoning: getValue(quads, subject, `${PORTER_NS}reasoning`) === "true",
    visibility: (getValue(quads, subject, `${PORTER_NS}visibility`) as "private" | "shared" | "linked") ?? "private",
    created_at: getValue(quads, subject, `${PORTER_NS}createdAt`) ?? new Date().toISOString(),
    updated_at: getValue(quads, subject, `${PORTER_NS}updatedAt`) ?? new Date().toISOString(),
  };
}

export function agentToTurtle(agent: SavedAgent, uri: string): string {
  const quads: Quad[] = [
    iriQuad(uri, RDF_TYPE, `${PORTER_NS}Agent`),
    litQuad(uri, `${PORTER_NS}name`, agent.name),
    litQuad(uri, `${PORTER_NS}assignedRole`, agent.role ?? "worker"),
  ];

  if (agent.system_prompt) {
    quads.push(litQuad(uri, `${PORTER_NS}agentExpertise`, agent.system_prompt));
  }
  for (const t of agent.tools ?? []) {
    quads.push(litQuad(uri, `${PORTER_NS}hasTool`, t));
  }
  for (const t of agent.mcp_tools ?? []) {
    quads.push(litQuad(uri, `${PORTER_NS}hasMcpTool`, t));
  }
  for (const ch of agent.channels ?? []) {
    quads.push(litQuad(uri, `${PORTER_NS}subscribesTo`, ch));
  }
  if (agent.model) quads.push(litQuad(uri, `${PORTER_NS}usesModel`, agent.model));
  if (agent.max_tokens) quads.push(litQuad(uri, `${PORTER_NS}maxTokens`, agent.max_tokens));
  if (agent.max_turns) quads.push(litQuad(uri, `${PORTER_NS}maxTurns`, agent.max_turns));
  if (agent.max_context_tokens) quads.push(litQuad(uri, `${PORTER_NS}maxContextTokens`, agent.max_context_tokens));
  if (agent.reasoning) quads.push(litQuad(uri, `${PORTER_NS}reasoning`, true));
  if (agent.visibility && agent.visibility !== "private") {
    quads.push(litQuad(uri, `${PORTER_NS}visibility`, agent.visibility));
  }

  return writeTurtle(quads);
}

// ---------------------------------------------------------------------------
// Team converters
// ---------------------------------------------------------------------------

export function turtleToTeam(turtle: string): SavedTeam | null {
  const quads = parseTurtle(turtle);
  const subject = findSubjectByType(quads, `${PORTER_NS}Team`);
  if (!subject) return null;

  const name = getValue(quads, subject, `${PORTER_NS}name`);
  if (!name) return null;

  // Backwards compat: check for legacy configJson
  const configJson = getValue(quads, subject, `${PORTER_NS}configJson`);
  if (configJson) {
    try {
      const config = JSON.parse(configJson);
      return { name, config, created_at: "", updated_at: "" };
    } catch { /* fall through to RDF parsing */ }
  }

  // Parse all fields from RDF
  const pattern = getValue(quads, subject, `${PORTER_NS}teamPattern`);
  const model = getValue(quads, subject, `${PORTER_NS}usesModel`) ?? "";
  const apiKeyEnv = getValue(quads, subject, `${PORTER_NS}apiKeyEnv`) ?? "ANTHROPIC_API_KEY";
  const workingDir = getValue(quads, subject, `${PORTER_NS}workingDir`) ?? ".";
  const maxRounds = parseInt(getValue(quads, subject, `${PORTER_NS}maxDeliberationRounds`) ?? "") || undefined;

  // Parse agent slots (blank nodes linked via hasAgentSlot)
  const agentSlotIds = getValues(quads, subject, `${PORTER_NS}hasAgentSlot`);
  const agents = agentSlotIds.map((slotId) => {
    const agent: Record<string, unknown> = {
      name: getValue(quads, slotId, `${PORTER_NS}agentRef`) ?? "",
      ref: getValue(quads, slotId, `${PORTER_NS}agentRef`) ?? "",
      role: getValue(quads, slotId, `${PORTER_NS}assignedRole`) ?? "worker",
      model: getValue(quads, slotId, `${PORTER_NS}usesModel`) ?? undefined,
      system_prompt: getValue(quads, slotId, `${PORTER_NS}agentExpertise`) ?? "",
      tools: getValues(quads, slotId, `${PORTER_NS}hasTool`),
      mcp_tools: getValues(quads, slotId, `${PORTER_NS}hasMcpTool`),
      max_tokens: parseInt(getValue(quads, slotId, `${PORTER_NS}maxTokens`) ?? "") || 8192,
      max_turns: parseInt(getValue(quads, slotId, `${PORTER_NS}maxTurns`) ?? "") || undefined,
      max_context_tokens: parseInt(getValue(quads, slotId, `${PORTER_NS}maxContextTokens`) ?? "") || undefined,
      reasoning: getValue(quads, slotId, `${PORTER_NS}reasoning`) === "true",
    };
    return agent;
  });

  // Parse MCP servers (blank nodes linked via hasMcpServer)
  const mcpIds = getValues(quads, subject, `${PORTER_NS}hasMcpServer`);
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const mcpId of mcpIds) {
    const mcpName = getValue(quads, mcpId, `${PORTER_NS}name`) ?? "";
    if (!mcpName) continue;
    const cfg: Record<string, unknown> = {
      transport: getValue(quads, mcpId, `${PORTER_NS}transport`) ?? "stdio",
    };
    const url = getValue(quads, mcpId, `${PORTER_NS}mcpUrl`);
    if (url) cfg.url = url;
    const cmd = getValue(quads, mcpId, `${PORTER_NS}mcpCommand`);
    if (cmd) cfg.command = cmd;
    const authType = getValue(quads, mcpId, `${PORTER_NS}authType`);
    if (authType) {
      cfg.auth = { type: authType } as Record<string, string>;
      const tokenEnv = getValue(quads, mcpId, `${PORTER_NS}tokenEnv`);
      if (tokenEnv) (cfg.auth as Record<string, string>).token_env = tokenEnv;
      const issuerUrl = getValue(quads, mcpId, `${PORTER_NS}mcpIssuerUrl`);
      if (issuerUrl) (cfg.auth as Record<string, string>).issuer_url = issuerUrl;
    }
    const args = getValues(quads, mcpId, `${PORTER_NS}mcpArgs`);
    if (args.length > 0) cfg.args = args;
    mcpServers[mcpName] = cfg;
  }

  // Session env
  const envStrings = getValues(quads, subject, `${PORTER_NS}sessionEnv`);
  const env: Record<string, string> = {};
  for (const s of envStrings) {
    const eq = s.indexOf("=");
    if (eq > 0) env[s.slice(0, eq)] = s.slice(eq + 1);
  }

  // Runtime tools
  const runtimeTools = getValues(quads, subject, `${PORTER_NS}runtimeTool`);

  return {
    name,
    config: {
      session: name,
      model,
      api_key_env: apiKeyEnv,
      pattern: pattern as import("../core/config.ts").CollaborationPattern | undefined,
      max_deliberation_rounds: maxRounds,
      working_dir: workingDir,
      agents: agents as unknown as import("../core/config.ts").AgentConfig[],
      mcp_servers: Object.keys(mcpServers).length > 0 ? mcpServers as unknown as Record<string, import("../mcp/mcp_client.ts").McpServerConfig> : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      runtime_tools: runtimeTools.length > 0 ? runtimeTools : undefined,
    },
    created_at: "",
    updated_at: "",
  };
}

export function teamToTurtle(team: SavedTeam, uri: string): string {
  const quads: Quad[] = [
    iriQuad(uri, RDF_TYPE, `${PORTER_NS}Team`),
    litQuad(uri, `${PORTER_NS}name`, team.name),
  ];
  const c = team.config;

  if (c.pattern) quads.push(litQuad(uri, `${PORTER_NS}teamPattern`, c.pattern));
  if (c.model) quads.push(litQuad(uri, `${PORTER_NS}usesModel`, c.model));
  if (c.api_key_env) quads.push(litQuad(uri, `${PORTER_NS}apiKeyEnv`, c.api_key_env));
  if (c.working_dir && c.working_dir !== ".") quads.push(litQuad(uri, `${PORTER_NS}workingDir`, c.working_dir));
  if (c.max_deliberation_rounds) quads.push(litQuad(uri, `${PORTER_NS}maxDeliberationRounds`, c.max_deliberation_rounds));

  // Agents as blank node slots with full inline data
  for (const a of c.agents ?? []) {
    const bn = `_:agent_${crypto.randomUUID().slice(0, 8)}`;
    quads.push(makeQuad(namedNode(uri), namedNode(`${PORTER_NS}hasAgentSlot`), namedNode(bn)) as unknown as Quad);
    quads.push(litQuad(bn, `${PORTER_NS}agentRef`, (a as unknown as Record<string, string>).ref ?? a.name));
    quads.push(litQuad(bn, `${PORTER_NS}assignedRole`, a.role ?? "worker"));
    if (a.model) quads.push(litQuad(bn, `${PORTER_NS}usesModel`, a.model));
    if (a.system_prompt) quads.push(litQuad(bn, `${PORTER_NS}agentExpertise`, a.system_prompt));
    for (const t of a.tools ?? []) quads.push(litQuad(bn, `${PORTER_NS}hasTool`, t));
    for (const t of a.mcp_tools ?? []) quads.push(litQuad(bn, `${PORTER_NS}hasMcpTool`, t));
    if (a.max_tokens) quads.push(litQuad(bn, `${PORTER_NS}maxTokens`, a.max_tokens));
    if (a.max_turns) quads.push(litQuad(bn, `${PORTER_NS}maxTurns`, a.max_turns));
    if (a.max_context_tokens) quads.push(litQuad(bn, `${PORTER_NS}maxContextTokens`, a.max_context_tokens));
    if (a.reasoning) quads.push(litQuad(bn, `${PORTER_NS}reasoning`, true));
  }

  // MCP servers as blank nodes
  if (c.mcp_servers) {
    for (const [mcpName, cfg] of Object.entries(c.mcp_servers)) {
      const bn = `_:mcp_${crypto.randomUUID().slice(0, 8)}`;
      const mcpCfg = cfg as unknown as Record<string, unknown>;
      quads.push(makeQuad(namedNode(uri), namedNode(`${PORTER_NS}hasMcpServer`), namedNode(bn)) as unknown as Quad);
      quads.push(litQuad(bn, `${PORTER_NS}name`, mcpName));
      quads.push(litQuad(bn, `${PORTER_NS}transport`, (mcpCfg.transport as string) ?? "stdio"));
      if (mcpCfg.url) quads.push(litQuad(bn, `${PORTER_NS}mcpUrl`, mcpCfg.url as string));
      if (mcpCfg.command) quads.push(litQuad(bn, `${PORTER_NS}mcpCommand`, mcpCfg.command as string));
      const auth = mcpCfg.auth as Record<string, string> | undefined;
      if (auth?.type) quads.push(litQuad(bn, `${PORTER_NS}authType`, auth.type));
      if (auth?.token_env) quads.push(litQuad(bn, `${PORTER_NS}tokenEnv`, auth.token_env));
      if (auth?.issuer_url) quads.push(litQuad(bn, `${PORTER_NS}mcpIssuerUrl`, auth.issuer_url));
    }
  }

  // Session env as repeated KEY=VALUE strings
  if (c.env) {
    for (const [k, v] of Object.entries(c.env)) {
      quads.push(litQuad(uri, `${PORTER_NS}sessionEnv`, `${k}=${v}`));
    }
  }

  // Runtime tools
  if (c.runtime_tools) {
    for (const t of c.runtime_tools) {
      const toolName = typeof t === "string" ? t : (t as { name: string }).name;
      quads.push(litQuad(uri, `${PORTER_NS}runtimeTool`, toolName));
    }
  }

  return writeTurtle(quads);
}

// ---------------------------------------------------------------------------
// Model config converters
// ---------------------------------------------------------------------------

export interface ModelConfig {
  id: string;
  display_name?: string;
  provider_type: string;
  base_url: string;
  auth: string;
  context_window?: number;
  max_tokens?: number;
  capabilities?: Record<string, boolean>;
}

export function turtleToModel(turtle: string): ModelConfig | null {
  const quads = parseTurtle(turtle);
  const subject = findSubjectByType(quads, `${PORTER_NS}Model`);
  if (!subject) return null;

  const name = getValue(quads, subject, `${PORTER_NS}name`);
  if (!name) return null;

  return {
    id: name,
    display_name: getValue(quads, subject, `${PORTER_NS}displayName`),
    provider_type: getValue(quads, subject, `${PORTER_NS}providerType`) ?? "openai_compat",
    base_url: getValue(quads, subject, `${PORTER_NS}baseUrl`) ?? "",
    auth: getValue(quads, subject, `${PORTER_NS}authMethod`) ?? "bearer",
    context_window: parseInt(getValue(quads, subject, `${PORTER_NS}contextWindow`) ?? "") || undefined,
    max_tokens: parseInt(getValue(quads, subject, `${PORTER_NS}maxTokens`) ?? "") || undefined,
    capabilities: {
      tool_calling: getValue(quads, subject, `${PORTER_NS}toolCalling`) === "true",
      reasoning: getValue(quads, subject, `${PORTER_NS}reasoning`) === "true",
      vision: getValue(quads, subject, `${PORTER_NS}vision`) === "true",
      json_mode: getValue(quads, subject, `${PORTER_NS}jsonMode`) === "true",
    },
  };
}

export function modelToTurtle(model: ModelConfig, uri: string): string {
  const quads: Quad[] = [
    iriQuad(uri, RDF_TYPE, `${PORTER_NS}Model`),
    litQuad(uri, `${PORTER_NS}name`, model.id),
  ];

  if (model.display_name) quads.push(litQuad(uri, `${PORTER_NS}displayName`, model.display_name));
  quads.push(litQuad(uri, `${PORTER_NS}providerType`, model.provider_type));
  quads.push(litQuad(uri, `${PORTER_NS}baseUrl`, model.base_url));
  quads.push(litQuad(uri, `${PORTER_NS}authMethod`, model.auth));
  if (model.context_window) quads.push(litQuad(uri, `${PORTER_NS}contextWindow`, model.context_window));
  if (model.max_tokens) quads.push(litQuad(uri, `${PORTER_NS}maxTokens`, model.max_tokens));
  if (model.capabilities?.tool_calling) quads.push(litQuad(uri, `${PORTER_NS}toolCalling`, true));
  if (model.capabilities?.reasoning) quads.push(litQuad(uri, `${PORTER_NS}reasoning`, true));
  if (model.capabilities?.vision) quads.push(litQuad(uri, `${PORTER_NS}vision`, true));
  if (model.capabilities?.json_mode) quads.push(litQuad(uri, `${PORTER_NS}jsonMode`, true));

  return writeTurtle(quads);
}

// ---------------------------------------------------------------------------
// MCP server converters
// ---------------------------------------------------------------------------

export interface McpConfig {
  name: string;
  transport: string;
  url?: string;
  command?: string;
  args?: string[];
  auth?: { type: string; token_env?: string };
}

export function turtleToMcp(turtle: string): McpConfig | null {
  const quads = parseTurtle(turtle);
  const subject = findSubjectByType(quads, `${PORTER_NS}McpServer`);
  if (!subject) return null;

  const name = getValue(quads, subject, `${PORTER_NS}name`);
  if (!name) return null;

  return {
    name,
    transport: getValue(quads, subject, `${PORTER_NS}transport`) ?? "stdio",
    url: getValue(quads, subject, `${PORTER_NS}mcpUrl`),
    command: getValue(quads, subject, `${PORTER_NS}mcpCommand`),
    auth: {
      type: getValue(quads, subject, `${PORTER_NS}authType`) ?? "none",
      token_env: getValue(quads, subject, `${PORTER_NS}tokenEnv`),
    },
  };
}

export function mcpToTurtle(mcp: McpConfig, uri: string): string {
  const quads: Quad[] = [
    iriQuad(uri, RDF_TYPE, `${PORTER_NS}McpServer`),
    litQuad(uri, `${PORTER_NS}name`, mcp.name),
    litQuad(uri, `${PORTER_NS}transport`, mcp.transport),
  ];

  if (mcp.url) quads.push(litQuad(uri, `${PORTER_NS}mcpUrl`, mcp.url));
  if (mcp.command) quads.push(litQuad(uri, `${PORTER_NS}mcpCommand`, mcp.command));
  if (mcp.auth?.type) quads.push(litQuad(uri, `${PORTER_NS}authType`, mcp.auth.type));
  if (mcp.auth?.token_env) quads.push(litQuad(uri, `${PORTER_NS}tokenEnv`, mcp.auth.token_env));

  return writeTurtle(quads);
}

// ---------------------------------------------------------------------------
// Consolidated export/import
// ---------------------------------------------------------------------------

export interface PorterResources {
  agents: SavedAgent[];
  teams: SavedTeam[];
  models: ModelConfig[];
  mcp: McpConfig[];
}

/** Export all resources as a single JSON-LD document with @graph. */
export function exportAllAsJsonLd(resources: PorterResources): Record<string, unknown> {
  const graph: Record<string, unknown>[] = [];

  for (const agent of resources.agents) {
    graph.push({
      "@type": "Agent",
      name: agent.name,
      role: agent.role,
      expertise: agent.system_prompt,
      tools: agent.tools,
      model: agent.model,
      maxTokens: agent.max_tokens,
      reasoning: agent.reasoning,
    });
  }

  for (const team of resources.teams) {
    graph.push({
      "@type": "Team",
      name: team.name,
      config: team.config,
    });
  }

  for (const model of resources.models) {
    graph.push({
      "@type": "Model",
      ...model,
    });
  }

  for (const mcp of resources.mcp) {
    graph.push({
      "@type": "McpServer",
      ...mcp,
    });
  }

  return {
    "@context": {
      porter: PORTER_NS,
      Agent: `${PORTER_NS}Agent`,
      Team: `${PORTER_NS}Team`,
      Model: `${PORTER_NS}Model`,
      McpServer: `${PORTER_NS}McpServer`,
    },
    "@graph": graph,
  };
}

/** Import a consolidated config. Accepts JSON-LD (@graph) or parsed JSON. */
export function importConsolidatedJsonLd(data: Record<string, unknown>): PorterResources {
  const graph = (data["@graph"] ?? []) as Record<string, unknown>[];
  const resources: PorterResources = { agents: [], teams: [], models: [], mcp: [] };

  for (const item of graph) {
    const type = (item["@type"] ?? item.type) as string;
    switch (type) {
      case "Agent":
      case "porter:Agent":
        resources.agents.push({
          name: item.name as string,
          role: (item.role ?? "worker") as string,
          system_prompt: (item.expertise ?? item.system_prompt ?? "") as string,
          tools: (item.tools ?? []) as string[],
          channels: [],
          mcp_tools: (item.mcp_tools ?? []) as string[],
          max_tokens: (item.maxTokens ?? item.max_tokens ?? 8192) as number,
          reasoning: (item.reasoning ?? false) as boolean,
          model: item.model as string | undefined,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        break;
      case "Team":
      case "porter:Team":
        resources.teams.push({
          name: item.name as string,
          config: item.config as import("../core/config.ts").PorterConfig,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        });
        break;
      case "Model":
      case "porter:Model":
        resources.models.push(item as unknown as ModelConfig);
        break;
      case "McpServer":
      case "porter:McpServer":
        resources.mcp.push(item as unknown as McpConfig);
        break;
    }
  }

  return resources;
}

/** Import consolidated Turtle — parse all quads, group by subject, convert each. */
export function importConsolidatedTurtle(turtle: string): PorterResources {
  const allQuads = parseTurtle(turtle);
  const resources: PorterResources = { agents: [], teams: [], models: [], mcp: [] };

  // Group quads by subject
  const bySubject = new Map<string, Quad[]>();
  for (const q of allQuads) {
    const subj = q.subject.value;
    if (!bySubject.has(subj)) bySubject.set(subj, []);
    bySubject.get(subj)!.push(q);
  }

  for (const [_subject, quads] of bySubject) {
    const type = quads.find(q => q.predicate.value === RDF_TYPE)?.object.value;
    const miniTurtle = writeTurtle(quads);
    switch (type) {
      case `${PORTER_NS}Agent`: {
        const agent = turtleToAgent(miniTurtle);
        if (agent) resources.agents.push(agent);
        break;
      }
      case `${PORTER_NS}Team`: {
        const team = turtleToTeam(miniTurtle);
        if (team) resources.teams.push(team);
        break;
      }
      case `${PORTER_NS}Model`: {
        const model = turtleToModel(miniTurtle);
        if (model) resources.models.push(model);
        break;
      }
      case `${PORTER_NS}McpServer`: {
        const mcp = turtleToMcp(miniTurtle);
        if (mcp) resources.mcp.push(mcp);
        break;
      }
    }
  }

  return resources;
}
