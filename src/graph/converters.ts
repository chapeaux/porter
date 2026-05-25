/**
 * Bidirectional JSON <-> RDF converters.
 *
 * Translates between Porter's JSON domain objects and RDF triples
 * stored in the GraphStore.
 */

import type { ModelConfig } from "../auth/model_store.ts";
import type { AgentConfig, PorterConfig } from "../core/config.ts";
import type { BusMessage } from "../runtime/bus.ts";
import type { GraphStore } from "./store.ts";
import { AS, GRAPHS, PORTER, PROV, RDF, RDFS, XSD } from "./vocabulary.ts";

// ---------------------------------------------------------------------------
// URI helpers
// ---------------------------------------------------------------------------

function modelUri(id: string): string {
  return `${PORTER.ns}model/${encodeURIComponent(id)}`;
}

function agentUri(name: string): string {
  return `${PORTER.ns}agent/${encodeURIComponent(name)}`;
}

function teamUri(session: string): string {
  return `${PORTER.ns}team/${encodeURIComponent(session)}`;
}

function msgUri(uuid: string): string {
  return `${PORTER.ns}msg/${uuid}`;
}

function obsUri(uuid: string): string {
  return `${PORTER.ns}obs/${uuid}`;
}

// ---------------------------------------------------------------------------
// Model conversion
// ---------------------------------------------------------------------------

/**
 * Serialise a ModelConfig into RDF triples in the config graph.
 */
export function modelConfigToTriples(
  model: ModelConfig,
  store: GraphStore,
): void {
  const uri = modelUri(model.id);
  const g = GRAPHS.config;

  store.addTriple(uri, RDF.type, PORTER.Model, g);
  store.addLiteral(uri, RDFS.label, model.display_name, g);
  store.addLiteral(uri, PORTER.providerType, model.provider_type, g);
  store.addLiteral(uri, PORTER.baseUrl, model.base_url, g);
  store.addLiteral(uri, PORTER.authMethod, model.auth, g);
  store.addLiteral(uri, PORTER.contextWindow, model.context_window, g);
  store.addLiteral(uri, PORTER.maxTokens, model.max_tokens, g);

  if (model.api_key_env) {
    store.addLiteral(uri, PORTER.apiKeyEnv, model.api_key_env, g);
  }
  if (model.region) {
    store.addLiteral(uri, PORTER.region, model.region, g);
  }
  if (model.api_version) {
    store.addLiteral(uri, PORTER.apiVersion, model.api_version, g);
  }

  // Capabilities
  store.addLiteral(uri, PORTER.toolCalling, model.capabilities.tool_calling, g);
  store.addLiteral(uri, PORTER.reasoning, model.capabilities.reasoning, g);
  store.addLiteral(uri, PORTER.vision, model.capabilities.vision, g);
  store.addLiteral(uri, PORTER.jsonMode, model.capabilities.json_mode, g);

  // Pricing
  if (model.pricing) {
    store.addLiteral(uri, PORTER.pricingInputPerM, model.pricing.input_1m, g);
    store.addLiteral(uri, PORTER.pricingOutputPerM, model.pricing.output_1m, g);
  }
}

/**
 * Read a ModelConfig back from the config graph.
 */
export function triplesToModelConfig(
  modelIri: string,
  store: GraphStore,
): ModelConfig {
  const rows = store.query(
    `SELECT ?p ?o WHERE { GRAPH <${GRAPHS.config}> { <${modelIri}> ?p ?o } }`,
  );

  const props = new Map<string, string>();
  for (const row of rows) {
    props.set(row.p, row.o);
  }

  const get = (key: string, fallback = ""): string =>
    props.get(key) ?? fallback;
  const getBool = (key: string): boolean => get(key) === "true";
  const getNum = (key: string, fallback = 0): number => {
    const v = props.get(key);
    return v !== undefined ? Number(v) : fallback;
  };

  // Extract the model id from the URI (last path segment, decoded).
  const idSegment = modelIri.split("/").pop() ?? modelIri;
  const id = decodeURIComponent(idSegment);

  return {
    id,
    display_name: get(RDFS.label),
    provider_type: get(PORTER.providerType) as ModelConfig["provider_type"],
    base_url: get(PORTER.baseUrl),
    api_key_env: props.get(PORTER.apiKeyEnv),
    region: props.get(PORTER.region),
    api_version: props.get(PORTER.apiVersion),
    auth: get(PORTER.authMethod) as ModelConfig["auth"],
    context_window: getNum(PORTER.contextWindow),
    max_tokens: getNum(PORTER.maxTokens),
    capabilities: {
      tool_calling: getBool(PORTER.toolCalling),
      reasoning: getBool(PORTER.reasoning),
      vision: getBool(PORTER.vision),
      json_mode: getBool(PORTER.jsonMode),
    },
    pricing: props.has(PORTER.pricingInputPerM)
      ? {
          input_1m: getNum(PORTER.pricingInputPerM),
          output_1m: getNum(PORTER.pricingOutputPerM),
        }
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Agent conversion
// ---------------------------------------------------------------------------

/**
 * Serialise an AgentConfig into the config graph, linking it to a team.
 */
export function agentConfigToTriples(
  agent: AgentConfig,
  teamIri: string,
  store: GraphStore,
): void {
  const uri = agentUri(agent.name);
  const g = GRAPHS.config;

  store.addTriple(uri, RDF.type, PORTER.Agent, g);
  store.addLiteral(uri, AS.name, agent.name, g);
  store.addLiteral(uri, PORTER.hasRole, agent.role, g);
  store.addLiteral(uri, PORTER.systemPrompt, agent.system_prompt, g);

  if (agent.model) {
    store.addLiteral(uri, PORTER.usesModel, agent.model, g);
  }
  if (agent.max_tokens !== undefined) {
    store.addLiteral(uri, PORTER.maxTokens, agent.max_tokens, g);
  }

  for (const tool of agent.tools) {
    store.addLiteral(uri, PORTER.hasTool, tool, g);
  }

  if (agent.subscribe) {
    for (const ch of agent.subscribe) {
      store.addLiteral(uri, PORTER.subscribes, ch, g);
    }
  }

  // Link agent to team
  store.addTriple(teamIri, PORTER.hasAgent, uri, g);
}

// ---------------------------------------------------------------------------
// Team / session conversion
// ---------------------------------------------------------------------------

/**
 * Serialise an entire PorterConfig into the config graph.
 *
 * Creates a Team node and links all agents to it.
 */
export function porterConfigToTriples(
  config: PorterConfig,
  store: GraphStore,
): void {
  const tUri = teamUri(config.session);
  const g = GRAPHS.config;

  store.addTriple(tUri, RDF.type, PORTER.Team, g);
  store.addLiteral(tUri, AS.name, config.session, g);
  store.addLiteral(tUri, PORTER.defaultModel, config.model, g);

  if (config.working_dir) {
    store.addLiteral(tUri, PORTER.workingDir, config.working_dir, g);
  }

  // Materialise each agent
  for (const agent of config.agents) {
    agentConfigToTriples(agent, tUri, store);
  }

  // Materialise model configs if present
  if (config.models) {
    for (const model of config.models) {
      modelConfigToTriples(model, store);
    }
  }
}

// ---------------------------------------------------------------------------
// BusMessage conversion (ActivityStreams 2.0 mapping)
// ---------------------------------------------------------------------------

/**
 * Serialise a BusMessage as an AS2 Note in the messages graph.
 */
export function busMessageToTriples(
  msg: BusMessage,
  messageUri: string,
  store: GraphStore,
): void {
  const g = GRAPHS.messages;

  store.addTriple(messageUri, RDF.type, AS.Note, g);
  store.addLiteral(messageUri, AS.content, msg.content, g);
  store.addLiteral(messageUri, PORTER.channel, msg.channel, g);
  store.addLiteral(messageUri, PORTER.from, msg.from, g);
  store.addLiteral(
    messageUri,
    AS.published,
    new Date(msg.timestamp).toISOString(),
    g,
  );
}

/**
 * Read a BusMessage back from the messages graph.
 * Returns null if the URI does not exist.
 */
export function triplesToBusMessage(
  messageUri: string,
  store: GraphStore,
): BusMessage | null {
  const rows = store.query(
    `SELECT ?p ?o WHERE { GRAPH <${GRAPHS.messages}> { <${messageUri}> ?p ?o } }`,
  );

  if (rows.length === 0) return null;

  const props = new Map<string, string>();
  for (const row of rows) {
    props.set(row.p, row.o);
  }

  const published = props.get(AS.published);
  const timestamp = published ? new Date(published).getTime() : 0;

  return {
    channel: props.get(PORTER.channel) ?? "",
    from: props.get(PORTER.from) ?? "",
    content: props.get(AS.content) ?? "",
    timestamp,
  };
}

// ---------------------------------------------------------------------------
// Observation (shared agent memory)
// ---------------------------------------------------------------------------

/**
 * Serialise an observation into the memory graph.
 *
 * @returns The generated observation URI.
 */
export function observationToTriples(
  obs: {
    about: string;
    finding: string;
    discoveredBy: string;
    severity?: string;
  },
  store: GraphStore,
): string {
  const id = crypto.randomUUID();
  const uri = obsUri(id);
  const g = GRAPHS.memory;

  store.addTriple(uri, RDF.type, PORTER.Observation, g);
  store.addLiteral(uri, PORTER.about, obs.about, g);
  store.addLiteral(uri, PORTER.finding, obs.finding, g);
  store.addTriple(uri, PORTER.discoveredBy, agentUri(obs.discoveredBy), g);
  store.addLiteral(
    uri,
    PROV.generatedAtTime,
    new Date().toISOString(),
    g,
  );

  if (obs.severity) {
    store.addLiteral(uri, PORTER.severity, obs.severity, g);
  }

  return uri;
}

/**
 * Seed the memory graph with team roster observations so agents can
 * discover teammates and the porter-ui identity via the standard
 * observation query pattern (porter:about / porter:finding).
 *
 * Note: porterConfigToTriples() also stores agent config in the config
 * graph using structural predicates (as:name, porter:hasRole, etc.).
 * These serve different purposes — config graph for system queries
 * and SHACL validation, memory graph for agent-facing discovery.
 */
export function seedTeamMemory(
  agents: Array<{ name: string; role: string; tools?: string[] }>,
  store: GraphStore,
): void {
  for (const agent of agents) {
    const tools = agent.tools?.length ? ` Tools: ${agent.tools.join(", ")}.` : "";
    observationToTriples(
      {
        about: `team:${agent.name}`,
        finding: `Agent "${agent.name}" has role "${agent.role}".${tools}`,
        discoveredBy: "porter",
      },
      store,
    );
  }

  observationToTriples(
    {
      about: "team:porter-ui",
      finding:
        'Messages from "porter-ui" come from the human user operating the dashboard. ' +
        "They give instructions to agents. Do not delegate tasks back to porter-ui.",
      discoveredBy: "porter",
    },
    store,
  );
}
