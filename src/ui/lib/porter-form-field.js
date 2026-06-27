/**
 * <porter-form-field> — labeled form field wrapper.
 *
 * Attributes: label, hint, error
 * Slot: default (for input / select / textarea)
 *
 * Uses light DOM — styled by porter.css classes.
 */
class PorterFormField extends BaseElement {
  static get observedAttributes() {
    return ['label', 'hint', 'error'];
  }

  init() {
    this.useTemplate('tmpl-porter-form-field');
    this._labelEl = this.$('label.form-field-label');
    this._hintEl = this.$('.field-hint');
    this._errorEl = this.$('.field-error');

    this._sync('label');
    this._sync('hint');
    this._sync('error');
  }

  attributeChanged(name) {
    this._sync(name);
  }

  /** Get the value of the first slotted input / select / textarea. */
  get value() {
    const input = this._getInput();
    return input ? input.value : '';
  }

  /** Set the value of the first slotted input / select / textarea. */
  set value(val) {
    const input = this._getInput();
    if (input) input.value = val;
  }

  _getInput() {
    return this.querySelector('input, select, textarea');
  }

  _sync(name) {
    const val = this.getAttribute(name) || '';
    switch (name) {
      case 'label':
        if (this._labelEl) this._labelEl.textContent = val;
        break;
      case 'hint':
        if (this._hintEl) {
          this._hintEl.textContent = val;
          this._hintEl.style.display = val ? '' : 'none';
        }
        break;
      case 'error':
        if (this._errorEl) {
          this._errorEl.textContent = val;
          this._errorEl.style.display = val ? '' : 'none';
        }
        // Toggle error class on the slotted input
        const input = this._getInput();
        if (input) {
          input.classList.toggle('form-field-input-error', !!val);
        }
        break;
    }
  }
}

customElements.define('porter-form-field', PorterFormField);
