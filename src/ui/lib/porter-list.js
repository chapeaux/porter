/**
 * <porter-list> — list container with empty-state and loading support.
 *
 * Attributes: empty-text, loading
 * Slot: default (list items)
 *
 * Uses light DOM — styled by porter.css classes.
 */
class PorterList extends BaseElement {
  static get observedAttributes() {
    return ['empty-text', 'loading'];
  }

  init() {
    this.useTemplate('tmpl-porter-list');
    this._emptyEl = this.$('.list-empty');
    this._loadingEl = this.$('.list-loading');
    this._itemsEl = this.$('.list-items');

    this._sync();

    // Watch for children changing to toggle empty state
    this._observer = new MutationObserver(() => this._sync());
    this._observer.observe(this._itemsEl, { childList: true });
  }

  disconnected() {
    if (this._observer) {
      this._observer.disconnect();
      this._observer = null;
    }
  }

  attributeChanged() {
    this._sync();
  }

  /** Number of slotted item children. */
  get count() {
    return this._itemsEl ? this._itemsEl.children.length : 0;
  }

  /** The container where items should be appended. */
  get itemsEl() {
    return this._itemsEl;
  }

  _sync() {
    const isLoading = this.hasAttribute('loading');
    const emptyText = this.getAttribute('empty-text') || 'No items';
    const hasItems = this.count > 0;

    if (this._loadingEl) {
      this._loadingEl.style.display = isLoading ? '' : 'none';
    }
    if (this._emptyEl) {
      this._emptyEl.textContent = emptyText;
      this._emptyEl.style.display = (!isLoading && !hasItems) ? '' : 'none';
    }
    if (this._itemsEl) {
      this._itemsEl.style.display = isLoading ? 'none' : '';
    }
  }
}

customElements.define('porter-list', PorterList);
