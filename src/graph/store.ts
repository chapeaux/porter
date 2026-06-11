/**
 * GraphStore — thin wrapper around Oxigraph's WASM-based in-memory
 * SPARQL store.
 *
 * Provides a Porter-friendly API for loading, querying, and mutating
 * RDF graphs. Named-graph support maps directly to the GRAPHS
 * constants from vocabulary.ts.
 */

import oxigraph from "npm:oxigraph@^0.5";
import { GRAPHS, PREFIXES, XSD } from "./vocabulary.ts";

// Re-export the type so consumers don't need to import oxigraph directly.
type OxigraphStore = InstanceType<typeof oxigraph.Store>;

/** SPARQL prefix block injected into every query for convenience. */
const SPARQL_PREFIXES = Object.entries(PREFIXES)
  .map(([alias, iri]) => `PREFIX ${alias}: <${iri}>`)
  .join("\n") + "\n";

/**
 * Result of SHACL validation.
 * Phase 1 stub — always conforms. Real validation will land when
 * rdf-validate-shacl (or a SPARQL-based checker) is wired in.
 */
export interface ValidationResult {
  conforms: boolean;
  violations: { path: string; message: string; value?: string }[];
}

// ---------------------------------------------------------------------------
// GraphStore
// ---------------------------------------------------------------------------

export class GraphStore {
  private store: OxigraphStore;

  private constructor(store: OxigraphStore) {
    this.store = store;
  }

  /**
   * Create and initialise a GraphStore.
   *
   * Loads `shapes.ttl` (co-located with this module) into the shapes
   * named graph so it is available for future validation.
   */
  static async create(): Promise<GraphStore> {
    try {
      const store = new oxigraph.Store();
      const gs = new GraphStore(store);

      // Load SHACL shapes from disk into the shapes graph.
      try {
        const shapesPath = new URL("./shapes.ttl", import.meta.url);
        const shapesText = await Deno.readTextFile(shapesPath);
        gs.load(shapesText, GRAPHS.shapes);
      } catch {
        // shapes.ttl may not exist in test/CI environments — tolerate.
      }

      return gs;
    } catch (err) {
      // Oxigraph WASM may fail to initialise in some environments.
      throw new Error(
        `GraphStore: failed to initialise Oxigraph — ${(err as Error).message}`,
      );
    }
  }

  // -----------------------------------------------------------------------
  // SPARQL
  // -----------------------------------------------------------------------

  /**
   * Execute a SPARQL SELECT query.
   *
   * Returns an array of binding objects where each key is a variable
   * name (without the leading `?`) and each value is the string
   * representation of the bound term.
   */
  query(sparql: string): Record<string, string>[] {
    const fullQuery = SPARQL_PREFIXES + sparql;
    const raw = this.store.query(fullQuery, {
      use_default_graph_as_union: true,
    });

    // SELECT → Array<Map<string, Term>>
    if (Array.isArray(raw) && raw.length > 0 && raw[0] instanceof Map) {
      return (raw as Map<string, { value: string }>[]).map((binding) => {
        const row: Record<string, string> = {};
        for (const [key, term] of binding) {
          row[key] = term.value;
        }
        return row;
      });
    }

    // ASK → boolean — wrap in a single-row result
    if (typeof raw === "boolean") {
      return [{ result: String(raw) }];
    }

    // CONSTRUCT/DESCRIBE → quads — not mapped; return empty
    return [];
  }

  /** Execute a SPARQL UPDATE (INSERT DATA / DELETE / etc.). */
  update(sparql: string): void {
    this.store.update(SPARQL_PREFIXES + sparql);
  }

  // -----------------------------------------------------------------------
  // Load / Dump
  // -----------------------------------------------------------------------

  /**
   * Load a Turtle string into the store.
   *
   * @param turtle  Serialised Turtle/TriG content.
   * @param graph   Named graph IRI. Defaults to the default graph.
   */
  load(turtle: string, graph?: string): void {
    this.store.load(turtle, {
      format: "text/turtle",
      ...(graph ? { to_graph_name: oxigraph.namedNode(graph) } : {}),
    });
  }

  /**
   * Dump the contents of a named graph (or the default graph) as Turtle.
   */
  dump(graph?: string): string {
    return this.store.dump({
      format: "text/turtle",
      from_graph_name: graph
        ? oxigraph.namedNode(graph)
        : oxigraph.defaultGraph(),
    }) as string;
  }

  // -----------------------------------------------------------------------
  // Convenience triple writers
  // -----------------------------------------------------------------------

  /**
   * Add a single triple (all terms are IRIs) to the store.
   */
  addTriple(
    subject: string,
    predicate: string,
    object: string,
    graph?: string,
  ): void {
    const s = oxigraph.namedNode(subject);
    const p = oxigraph.namedNode(predicate);
    const o = oxigraph.namedNode(object);
    const g = graph
      ? oxigraph.namedNode(graph)
      : oxigraph.defaultGraph();
    this.store.add(oxigraph.quad(s, p, o, g));
  }

  /**
   * Add a triple whose object is a typed literal.
   *
   * Automatically selects the XSD datatype from the JS value type:
   * - `string`  → xsd:string
   * - `number`  → xsd:integer (if integer) or xsd:float
   * - `boolean` → xsd:boolean
   */
  addLiteral(
    subject: string,
    predicate: string,
    value: string | number | boolean,
    graph?: string,
  ): void {
    const s = oxigraph.namedNode(subject);
    const p = oxigraph.namedNode(predicate);

    let o;
    if (typeof value === "boolean") {
      o = oxigraph.literal(
        String(value),
        oxigraph.namedNode(XSD.boolean),
      );
    } else if (typeof value === "number") {
      const dt = Number.isInteger(value) ? XSD.integer : XSD.float;
      o = oxigraph.literal(String(value), oxigraph.namedNode(dt));
    } else {
      o = oxigraph.literal(value);
    }

    const g = graph
      ? oxigraph.namedNode(graph)
      : oxigraph.defaultGraph();
    this.store.add(oxigraph.quad(s, p, o, g));
  }

  // -----------------------------------------------------------------------
  // SHACL validation (Phase 1 stub)
  // -----------------------------------------------------------------------

  /**
   * Validate the data in `dataGraph` against the loaded SHACL shapes.
   *
   * TODO: Wire up rdf-validate-shacl or implement SPARQL-based SHACL
   *       checking. For now this always returns `{ conforms: true }`.
   */
  validate(_dataGraph?: string): ValidationResult {
    return { conforms: true, violations: [] };
  }

  // -----------------------------------------------------------------------
  // Describe
  // -----------------------------------------------------------------------

  /**
   * Return all predicate/object pairs for a given subject, across all
   * graphs (or a specific graph).
   *
   * Single-valued predicates are returned as plain strings; predicates
   * that appear more than once are returned as string arrays.
   */
  describe(
    subject: string,
    graph?: string,
  ): Record<string, string | string[]> {
    const graphFilter = graph
      ? `GRAPH <${graph}> { <${subject}> ?p ?o }`
      : `<${subject}> ?p ?o`;
    const sparql = `SELECT ?p ?o WHERE { ${graphFilter} }`;
    const rows = this.query(sparql);

    const result: Record<string, string | string[]> = {};
    for (const row of rows) {
      const p = row.p;
      const o = row.o;
      const existing = result[p];
      if (existing === undefined) {
        result[p] = o;
      } else if (Array.isArray(existing)) {
        existing.push(o);
      } else {
        result[p] = [existing, o];
      }
    }
    return result;
  }
}

let _graphStore: GraphStore | null = null;

export function getGraphStore(): GraphStore | null {
  return _graphStore;
}

export function setGraphStore(store: GraphStore): void {
  _graphStore = store;
}

export async function initGraphStore(): Promise<GraphStore> {
  if (_graphStore) return _graphStore;
  _graphStore = await GraphStore.create();
  return _graphStore;
}
