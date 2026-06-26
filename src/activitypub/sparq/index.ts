export {
  SparqStore,
  type RdfFormat,
  type SparqStoreOptions,
  type SerializeFormat,
  type SerializeOptions,
  type ValidationReport,
  type ValidationResult,
} from './store.ts';
// [OPUS-4.8] sq-lii76 (#981) — the RDF/JS `DatasetCore` entry the ESM `<script type=module>`
// snippet imports by name (`import { Dataset } from "..."`), lazily instantiating the wasm.
// [OPUS-4.8] sq-iwhl8 (#1116) — `datasetFactory` is the RDF/JS `DatasetCoreFactory` +
// `DatasetFactory` (a synchronous `dataset(quads?)` builder; the engine must already be up).
// [OPUS-4.8] sq-iwhl8 (#1116) — the RDF/JS Stream-spec surface: a quad `Stream` + a
// `Source`/`Sink`/`Store` adapter over a `SparqStore` (also reachable via `store.asSource()`).
export { Bindings } from './bindings.ts';
export { DataFactory, NamedNode, BlankNode, Literal, Variable, DefaultGraph, Quad } from './terms.ts';
export {
  termFromSparqlJson,
  termToNT,
  quadsToNQuads,
  parseNTriples,
  detectQueryForm,
  SparqlJsonRowsParser,
  type SparqlJsonTerm,
  type SparqlJsonResults,
  type QueryForm,
} from './sparql.ts';
export { init } from './wasm.ts';
export { decompress, decompressToString, sniffCodec, type CompressionCodec } from './decompress.ts';
export {
  SparqDictionaryClient,
  dictIdOf,
  verifyDictId,
  parseZstdDictId,
  SPARQ_DICTIONARY_HEADER,
  SPARQ_DICTIONARY_CURRENT_HEADER,
  type DictionaryDecoder,
  type DictionaryFetchResult,
  type SparqDictionaryClientOptions,
} from './dictionary.ts';
