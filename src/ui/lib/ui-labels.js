/**
 * UiLabels — resolve human-readable labels from an RDF dataset by language.
 *
 * Works with any iterable of RDF/JS-shaped quads:
 *   { subject: { value }, predicate: { value }, object: { value, language } }
 */

const RDFS_LABEL   = 'http://www.w3.org/2000/01/rdf-schema#label';
const RDFS_COMMENT = 'http://www.w3.org/2000/01/rdf-schema#comment';

class UiLabels {
  /** @type {Iterable} */  #dataset;
  /** @type {string}   */  #lang;

  /**
   * @param {Iterable} dataset  An N3.Store, array of quads, or any iterable of RDF/JS quads.
   * @param {string}   [lang]   Two-letter language code (defaults to browser language or 'en').
   */
  constructor(dataset, lang = (typeof navigator !== 'undefined' && navigator.language?.slice(0, 2)) || 'en') {
    this.#dataset = dataset;
    this.#lang    = lang;
  }

  /**
   * Return the rdfs:label for `termUri` in the preferred language,
   * falling back to 'en', then to the URI local name.
   * @param {string} termUri
   * @returns {string}
   */
  label(termUri) {
    return this.#resolve(termUri, RDFS_LABEL) ?? localName(termUri);
  }

  /**
   * Return the rdfs:comment for `termUri` in the preferred language,
   * falling back to 'en', then to ''.
   * @param {string} termUri
   * @returns {string}
   */
  description(termUri) {
    return this.#resolve(termUri, RDFS_COMMENT) ?? '';
  }

  /**
   * Look up a predicate value with language negotiation:
   *   1. exact match on #lang
   *   2. fallback to 'en'
   *   3. any literal without a language tag
   * @param {string} subjectUri
   * @param {string} predicateUri
   * @returns {string|null}
   */
  #resolve(subjectUri, predicateUri) {
    let enValue  = null;
    let anyValue = null;

    for (const q of this.#dataset) {
      if (q.subject.value !== subjectUri)   continue;
      if (q.predicate.value !== predicateUri) continue;

      const lang = q.object.language ?? '';
      if (lang === this.#lang) return q.object.value;
      if (lang === 'en')       enValue  = q.object.value;
      if (!lang)               anyValue = q.object.value;
    }

    return enValue ?? anyValue;
  }
}

/** Extract the fragment or last path segment from a URI. */
function localName(uri) {
  const h = uri.lastIndexOf('#');
  if (h >= 0) return uri.slice(h + 1);
  const s = uri.lastIndexOf('/');
  return s >= 0 ? uri.slice(s + 1) : uri;
}

export default UiLabels;
