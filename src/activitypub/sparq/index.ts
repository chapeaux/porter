export {
  SparqStore,
  type RdfFormat,
  type SparqStoreOptions,
  type ValidationReport,
  type ValidationResult,
} from './store.ts';
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
