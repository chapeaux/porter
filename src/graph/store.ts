/**
 * GraphStore — SPARQL graph store backed by Sparq WASM.
 *
 * Provides a Porter-friendly API for loading, querying, and mutating
 * RDF graphs. Named-graph support maps directly to the GRAPHS
 * constants from vocabulary.ts.
 *
 * This replaces the previous Oxigraph-based implementation with the
 * same public API so all consumers (tools, orchestrator, converters)
 * work unchanged.
 */

import { GRAPHS, PREFIXES, XSD } from "./vocabulary.ts";
import {
  SparqStore,
  DataFactory,
  type Quad,
  parseNTriples,
  init as initSparq,
} from "../activitypub/sparq/index.ts";

const { namedNode, literal, quad, defaultGraph } = DataFactory;

/** SPARQL prefix block injected into every query for convenience. */
const SPARQL_PREFIXES = Object.entries(PREFIXES)
  .map(([alias, iri]) => `PREFIX ${alias}: <${iri}>`)
  .join("\n") + "\n";

/**
 * Result of SHACL validation.
 */
export interface ValidationResult {
  conforms: boolean;
  violations: { path: string; message: string; value?: string }[];
}

// ---------------------------------------------------------------------------
// GraphStore
// ---------------------------------------------------------------------------

export class GraphStore {
  private store: SparqStore;

  private constructor(store: SparqStore) {
    this.store = store;
  }

  /**
   * Create and initialise a GraphStore.
   *
   * Loads `shapes.ttl` (co-located with this module) into the shapes
   * named graph so it is available for future validation.
   */
  static async create(): Promise<GraphStore> {
    await initSparq();
    const store = await SparqStore.fromString("", "ntriples");
    const gs = new GraphStore(store);

    try {
      const shapesPath = new URL("./shapes.ttl", import.meta.url);
      const shapesText = await Deno.readTextFile(shapesPath);
      await gs.loadAsync(shapesText, GRAPHS.shapes);
    } catch {
      // shapes.ttl may not exist in test/CI environments — tolerate.
    }

    return gs;
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
    const result = this.store.query(fullQuery);

    if (typeof result === "boolean") {
      return [{ result: String(result) }];
    }

    if (Array.isArray(result)) {
      return result.map((binding) => {
        const row: Record<string, string> = {};
        for (const [variable, term] of binding) {
          row[variable.value] = term.value;
        }
        return row;
      });
    }

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
   * Uses SPARQL INSERT DATA with the prefix block and optional GRAPH clause.
   */
  load(turtle: string, graph?: string): void {
    if (!turtle.trim()) return;

    try {
      const graphClause = graph ? `GRAPH <${graph}>` : "";
      this.store.update(
        `${SPARQL_PREFIXES}\nINSERT DATA { ${graphClause} { ${turtle} } }`
      );
    } catch (err) {
      console.error(`[graph] Failed to load turtle: ${(err as Error).message}`);
    }
  }

  /**
   * Load a Turtle string asynchronously (parses via temporary store).
   * Use when INSERT DATA doesn't work with complex Turtle syntax.
   */
  async loadAsync(turtle: string, graph?: string): Promise<void> {
    if (!turtle.trim()) return;

    try {
      const tmp = await SparqStore.fromString(turtle, "turtle");
      const quads = tmp.match();
      const graphNode = graph ? namedNode(graph) : defaultGraph();
      // deno-lint-ignore no-explicit-any
      const reGraphed = quads.map((q: any) =>
        quad(q.subject as any, q.predicate as any, q.object as any, graphNode as any)
      );
      this.store.addQuads(reGraphed as unknown as Quad[]);
    } catch (err) {
      console.error(`[graph] Failed to loadAsync turtle: ${(err as Error).message}`);
    }
  }

  /**
   * Dump the contents of a named graph (or the default graph) as
   * N-Triples.
   */
  dump(graph?: string): string {
    const graphClause = graph
      ? `GRAPH <${graph}> { ?s ?p ?o }`
      : `{ ?s ?p ?o }`;
    try {
      return this.store.queryQuadsString(
        `${SPARQL_PREFIXES}\nCONSTRUCT { ?s ?p ?o } WHERE { ${graphClause} }`
      );
    } catch {
      return "";
    }
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
    const q = quad(
      namedNode(subject),
      namedNode(predicate),
      namedNode(object),
      graph ? namedNode(graph) : defaultGraph(),
    );
    this.store.addQuads([q as unknown as Quad]);
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
    let obj;
    if (typeof value === "boolean") {
      obj = literal(String(value), namedNode(XSD.boolean));
    } else if (typeof value === "number") {
      const dt = Number.isInteger(value) ? XSD.integer : XSD.float;
      obj = literal(String(value), namedNode(dt));
    } else {
      obj = literal(value);
    }

    const q = quad(
      namedNode(subject),
      namedNode(predicate),
      obj as any,
      graph ? namedNode(graph) : defaultGraph(),
    );
    this.store.addQuads([q as unknown as Quad]);
  }

  // -----------------------------------------------------------------------
  // SHACL validation
  // -----------------------------------------------------------------------

  /**
   * Validate the data in `dataGraph` against the loaded SHACL shapes.
   */
  validate(dataGraph?: string): ValidationResult {
    if (!dataGraph) return { conforms: true, violations: [] };

    try {
      const shapesNt = this.dump(GRAPHS.shapes);
      const dataNt = this.dump(dataGraph);
      if (!shapesNt.trim() || !dataNt.trim()) {
        return { conforms: true, violations: [] };
      }
      const report = this.store.validate(dataNt, shapesNt, "ntriples");
      return {
        conforms: report.conforms,
        // deno-lint-ignore no-explicit-any
        violations: report.results.map((r: any) => ({
          path: r.path ?? "",
          message: r.message ?? "Validation failed",
          value: r.value ?? undefined,
        })),
      };
    } catch {
      return { conforms: true, violations: [] };
    }
  }

  // -----------------------------------------------------------------------
  // Describe
  // -----------------------------------------------------------------------

  /**
   * Return all predicate/object pairs for a given subject, across all
   * graphs (or a specific graph).
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
