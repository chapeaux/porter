/**
 * BaseElement — base class for Porter's light-DOM custom elements.
 *
 * Standardises lifecycle so subclasses only override:
 *   init()               — one-time DOM setup (called once, on first connect)
 *   connected()          — runs every connectedCallback (wire events here)
 *   disconnected()       — cleanup (runs every disconnectedCallback)
 *   attributeChanged()   — deduped (skips oldVal === newVal), only fires after init
 */
class BaseElement extends HTMLElement {
  #initialized = false;

  connectedCallback() {
    if (!this.#initialized) {
      this.#initialized = true;
      this.init();
    }
    this.connected();
  }

  disconnectedCallback() {
    this.disconnected();
  }

  /** Override in subclass — one-time DOM build. */
  init() {}

  /** Override in subclass — runs every connect. */
  connected() {}

  /** Override in subclass — cleanup. */
  disconnected() {}

  /** Override in subclass — deduped attribute changes (only after init). */
  attributeChanged(_name, _oldVal, _newVal) {}

  attributeChangedCallback(name, oldVal, newVal) {
    if (oldVal === newVal) return;
    if (!this.#initialized) return;
    this.attributeChanged(name, oldVal, newVal);
  }

  /**
   * Clone a <template id="..."> into this element (light DOM).
   * Returns the first element child of the cloned fragment, or null.
   */
  useTemplate(id) {
    const tpl = document.getElementById(id);
    if (!tpl) {
      console.error(`[${this.localName}] template #${id} not found`);
      return null;
    }
    const clone = tpl.content.cloneNode(true);
    this.appendChild(clone);
    return this.firstElementChild;
  }

  /** Shorthand for this.querySelector. */
  $(selector) {
    return this.querySelector(selector);
  }
}
