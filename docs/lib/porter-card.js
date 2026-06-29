/**
 * <porter-card> — reusable card component for dialog lists.
 *
 * Attributes: heading, meta, badge
 * Slots: default (body), "actions" (footer buttons)
 *
 * Uses light DOM so Porter's existing CSS applies directly.
 */
class PorterCard extends BaseElement {
  static get observedAttributes() {
    return ['heading', 'meta', 'badge'];
  }

  init() {
    this.useTemplate('tmpl-porter-card');
    this._headingEl = this.$('.card-heading');
    this._metaEl = this.$('.card-meta');
    this._badgeEl = this.$('.card-badge');

    // Apply initial attribute values
    this._sync('heading');
    this._sync('meta');
    this._sync('badge');
  }

  attributeChanged(name) {
    this._sync(name);
  }

  _sync(name) {
    const val = this.getAttribute(name) || '';
    switch (name) {
      case 'heading':
        if (this._headingEl) this._headingEl.textContent = val;
        break;
      case 'meta':
        if (this._metaEl) this._metaEl.textContent = val;
        break;
      case 'badge':
        if (this._badgeEl) {
          this._badgeEl.textContent = val;
          this._badgeEl.style.display = val ? '' : 'none';
        }
        break;
    }
  }
}

customElements.define('porter-card', PorterCard);
