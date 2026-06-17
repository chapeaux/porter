/**
 * RDF vocabulary constants for Porter.
 *
 * Follows the same pattern as comidas.gratis/vocabulary.ts — plain
 * string constants for namespace URIs, no runtime RDF dependency.
 */

// --- Standard Vocabularies ---

export const RDF = {
  type: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
} as const;

export const RDFS = {
  label: "http://www.w3.org/2000/01/rdf-schema#label",
  comment: "http://www.w3.org/2000/01/rdf-schema#comment",
} as const;

export const XSD = {
  string: "http://www.w3.org/2001/XMLSchema#string",
  integer: "http://www.w3.org/2001/XMLSchema#integer",
  boolean: "http://www.w3.org/2001/XMLSchema#boolean",
  float: "http://www.w3.org/2001/XMLSchema#float",
  dateTime: "http://www.w3.org/2001/XMLSchema#dateTime",
} as const;

export const AS = {
  ns: "https://www.w3.org/ns/activitystreams#",
  // Activity types
  Offer: "https://www.w3.org/ns/activitystreams#Offer",
  Accept: "https://www.w3.org/ns/activitystreams#Accept",
  Reject: "https://www.w3.org/ns/activitystreams#Reject",
  Create: "https://www.w3.org/ns/activitystreams#Create",
  Update: "https://www.w3.org/ns/activitystreams#Update",
  Delete: "https://www.w3.org/ns/activitystreams#Delete",
  Announce: "https://www.w3.org/ns/activitystreams#Announce",
  Question: "https://www.w3.org/ns/activitystreams#Question",
  Follow: "https://www.w3.org/ns/activitystreams#Follow",
  Undo: "https://www.w3.org/ns/activitystreams#Undo",
  Like: "https://www.w3.org/ns/activitystreams#Like",
  // Object types
  Note: "https://www.w3.org/ns/activitystreams#Note",
  Document: "https://www.w3.org/ns/activitystreams#Document",
  Collection: "https://www.w3.org/ns/activitystreams#Collection",
  Application: "https://www.w3.org/ns/activitystreams#Application",
  Service: "https://www.w3.org/ns/activitystreams#Service",
  Person: "https://www.w3.org/ns/activitystreams#Person",
  OrderedCollection: "https://www.w3.org/ns/activitystreams#OrderedCollection",
  OrderedCollectionPage: "https://www.w3.org/ns/activitystreams#OrderedCollectionPage",
  // Properties
  actor: "https://www.w3.org/ns/activitystreams#actor",
  object: "https://www.w3.org/ns/activitystreams#object",
  target: "https://www.w3.org/ns/activitystreams#target",
  result: "https://www.w3.org/ns/activitystreams#result",
  context: "https://www.w3.org/ns/activitystreams#context",
  summary: "https://www.w3.org/ns/activitystreams#summary",
  content: "https://www.w3.org/ns/activitystreams#content",
  published: "https://www.w3.org/ns/activitystreams#published",
  inReplyTo: "https://www.w3.org/ns/activitystreams#inReplyTo",
  name: "https://www.w3.org/ns/activitystreams#name",
  url: "https://www.w3.org/ns/activitystreams#url",
  tag: "https://www.w3.org/ns/activitystreams#tag",
  inbox: "https://www.w3.org/ns/activitystreams#inbox",
  outbox: "https://www.w3.org/ns/activitystreams#outbox",
  followers: "https://www.w3.org/ns/activitystreams#followers",
  following: "https://www.w3.org/ns/activitystreams#following",
  preferredUsername: "https://www.w3.org/ns/activitystreams#preferredUsername",
  manuallyApprovesFollowers: "https://www.w3.org/ns/activitystreams#manuallyApprovesFollowers",
  publicKey: "https://www.w3.org/ns/activitystreams#publicKey",
  endpoints: "https://www.w3.org/ns/activitystreams#endpoints",
  sharedInbox: "https://www.w3.org/ns/activitystreams#sharedInbox",
} as const;

export const PROV = {
  Entity: "http://www.w3.org/ns/prov#Entity",
  generatedAtTime: "http://www.w3.org/ns/prov#generatedAtTime",
  wasGeneratedBy: "http://www.w3.org/ns/prov#wasGeneratedBy",
  wasAttributedTo: "http://www.w3.org/ns/prov#wasAttributedTo",
} as const;

// --- Porter Vocabulary ---

const NS = "https://porter.chapeaux.io/vocab#";

export const PORTER = {
  ns: NS,

  // Classes
  Session: `${NS}Session`,
  Team: `${NS}Team`,
  Agent: `${NS}Agent`,
  Model: `${NS}Model`,
  Provider: `${NS}Provider`,
  Tool: `${NS}Tool`,
  Observation: `${NS}Observation`,
  TaskThread: `${NS}TaskThread`,
  ErrorEvent: `${NS}ErrorEvent`,

  // Agent properties
  hasRole: `${NS}hasRole`,
  usesModel: `${NS}usesModel`,
  hasTool: `${NS}hasTool`,
  subscribes: `${NS}subscribes`,
  systemPrompt: `${NS}systemPrompt`,

  // Model properties
  providerType: `${NS}providerType`,
  baseUrl: `${NS}baseUrl`,
  apiKeyEnv: `${NS}apiKeyEnv`,
  authMethod: `${NS}authMethod`,
  region: `${NS}region`,
  apiVersion: `${NS}apiVersion`,
  contextWindow: `${NS}contextWindow`,
  maxTokens: `${NS}maxTokens`,
  toolCalling: `${NS}toolCalling`,
  reasoning: `${NS}reasoning`,
  vision: `${NS}vision`,
  jsonMode: `${NS}jsonMode`,
  pricingInputPerM: `${NS}pricingInputPerM`,
  pricingOutputPerM: `${NS}pricingOutputPerM`,

  // Session properties
  hasAgent: `${NS}hasAgent`,
  fromTeam: `${NS}fromTeam`,
  defaultModel: `${NS}defaultModel`,
  startedAt: `${NS}startedAt`,
  busPort: `${NS}busPort`,
  workingDir: `${NS}workingDir`,

  // Message properties
  channel: `${NS}channel`,
  from: `${NS}from`,
  acknowledged: `${NS}acknowledged`,

  // Observation (shared agent memory)
  about: `${NS}about`,
  finding: `${NS}finding`,
  discoveredBy: `${NS}discoveredBy`,
  severity: `${NS}severity`,

  // Metrics
  inputTokens: `${NS}inputTokens`,
  outputTokens: `${NS}outputTokens`,
  apiCalls: `${NS}apiCalls`,
  toolCalls: `${NS}toolCalls`,
  errorCount: `${NS}errorCount`,
  retryCount: `${NS}retryCount`,
} as const;

/** Standard namespace prefixes for Turtle serialization. */
export const PREFIXES = {
  porter: NS,
  as: AS.ns,
  prov: "http://www.w3.org/ns/prov#",
  rdf: "http://www.w3.org/1999/02/22-rdf-syntax-ns#",
  rdfs: "http://www.w3.org/2000/01/rdf-schema#",
  xsd: "http://www.w3.org/2001/XMLSchema#",
  sh: "http://www.w3.org/ns/shacl#",
} as const;

/** Named graph URIs used by Porter. */
export const GRAPHS = {
  config: `${NS}graph/config`,
  messages: `${NS}graph/messages`,
  memory: `${NS}graph/memory`,
  metrics: `${NS}graph/metrics`,
  shapes: `${NS}graph/shapes`,
} as const;
