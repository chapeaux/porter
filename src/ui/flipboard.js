class FlipboardCell extends HTMLElement {
  static get observedAttributes() { return ['status', 'label-chars', 'value-chars']; }

  constructor() {
    super();
    this._labelChars = 9;
    this._valueChars = 12;
    this._observer = null;
    this.attachShadow({ mode: 'open' });
  }

  connectedCallback() {
    const style = document.createElement('style');
    style.textContent = `
        :host {
          --status-ok: #9ecfff;
          display: inline-flex;
        }
        :host(:last-of-type) { border-right: none; }

        .cell {
          display: flex;
          align-items: center;
          gap: 0.75rem;
          padding: 0.35rem 0.75rem;
        }

        .label-display, .value-display {
          display: inline-flex;
          gap: 1px;
        }

        .label-display:after {
          content: ':';
          padding: 0.2rem 0 .1rem;
        }

        .fb-ch {
          display: inline-block;
          width: 1.75ch;
          text-align: center;
          font-family: var(--font-mono, "Courier New", Courier, monospace);
          font-size: 1.25rem;
          font-weight: bold;
          text-transform: uppercase;
          background: rgba(0,0,0,0.5);
          border: 1px solid rgba(201, 168, 76, 0.18);
          padding: 0.2rem 0 .1rem;
          box-sizing: border-box;
        }

        .label-display .fb-ch { color: var(--text-primary, #c9a84c); }
        .value-display .fb-ch { color: var(--text-primary, #f0e6d2); }

        :host([clickable]) { cursor: pointer; }
        :host([clickable]:hover) .value-display .fb-ch {
          color: var(--accent-gold, #c9a84c);
          border-color: var(--accent-gold, #c9a84c);
        }

        :host([status="ok"]) .value-display .fb-ch    { color: var(--status-ok, #6aad74); }
        :host([status="warn"]) .value-display .fb-ch   { color: var(--status-warn, #d4b85c); }
        :host([status="error"]) .value-display .fb-ch  { color: var(--status-error, #b87333); }

        @container flipboard (max-width: 700px) {
          .cell {
            align-items: center;
            gap: 0.15rem;
            padding: 0.25rem 0.5rem;
          }
        }
    `;

    const cell = document.createElement('div');
    cell.className = 'cell';
    cell.setAttribute('part', 'cell');

    const labelDisplay = document.createElement('div');
    labelDisplay.className = 'label-display';
    labelDisplay.setAttribute('part', 'label');

    const valueDisplay = document.createElement('div');
    valueDisplay.className = 'value-display';
    valueDisplay.setAttribute('part', 'value');

    const iconSlot = document.createElement('slot');
    iconSlot.name = 'icon';
    iconSlot.textContent = ' ';

    cell.append(labelDisplay, valueDisplay, iconSlot);

    this.shadowRoot.append(style, cell);

    const labelSlot = document.createElement('slot');
    labelSlot.name = 'label';
    labelSlot.style.display = 'none';
    const valueSlot = document.createElement('slot');
    valueSlot.name = 'value';
    valueSlot.style.display = 'none';
    this.shadowRoot.appendChild(labelSlot);
    this.shadowRoot.appendChild(valueSlot);

    labelSlot.addEventListener('slotchange', () => this._render());
    valueSlot.addEventListener('slotchange', () => this._render());

    this._observer = new MutationObserver(() => this._render());
    this._observeSlots();
    this._readAttrs();
    this._render();
  }

  disconnectedCallback() {
    if (this._observer) { this._observer.disconnect(); this._observer = null; }
  }

  attributeChangedCallback(name) {
    if (name === 'label-chars' || name === 'value-chars') this._readAttrs();
    this._render();
  }

  _readAttrs() {
    this._labelChars = parseInt(this.getAttribute('label-chars')) || 9;
    this._valueChars = parseInt(this.getAttribute('value-chars')) || 12;
  }

  _observeSlots() {
    if (!this._observer) return;
    this._observer.disconnect();
    for (const el of this.querySelectorAll('[slot]')) {
      this._observer.observe(el, { characterData: true, childList: true, subtree: true });
    }
  }

  _render() {
    const labelDisplay = this.shadowRoot?.querySelector('.label-display');
    const valueDisplay = this.shadowRoot?.querySelector('.value-display');
    if (!labelDisplay || !valueDisplay) return;

    const rawLabel = (this.querySelector('[slot="label"]')?.textContent || '').trim().toUpperCase();
    const rawValue = (this.querySelector('[slot="value"]')?.textContent || '').trim().toUpperCase();

    this._fillChars(labelDisplay, rawLabel.padEnd(this._labelChars).slice(0, this._labelChars));
    this._fillChars(valueDisplay, rawValue.padEnd(this._valueChars).slice(0, this._valueChars));

    this._observeSlots();
  }

  _fillChars(container, text) {
    container.replaceChildren();
    for (const ch of text) {
      const span = document.createElement('span');
      span.className = 'fb-ch';
      span.textContent = ch;
      container.appendChild(span);
    }
  }
}


class FlipboardBar extends HTMLElement {
  static get observedAttributes() { return ['label-width', 'value-width']; }

  constructor() {
    super();
    this.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
        :host {
          display: grid;
          grid-template-columns: 1fr 1fr 1fr;
          justify-items: center;
          max-width: 1200px;
          container-type: inline-size;
          container-name: flipboard;
        }
        @media (max-width: 1600px) {
          :host {
            grid-template-columns: 1fr 1fr;
          }
        }
        @media (max-width: 1200px) {
          :host {
            grid-template-columns: 1fr;
          }
        }
    `;

    const defaultSlot = document.createElement('slot');
    const actionsSlot = document.createElement('slot');
    actionsSlot.name = 'actions';

    this.shadowRoot.append(style, defaultSlot, actionsSlot);
  }

  connectedCallback() {
    this._updateWidths();
    this.shadowRoot.querySelector('slot:not([name])')
      .addEventListener('slotchange', () => this._updateWidths());
  }

  attributeChangedCallback() {
    this._updateWidths();
  }

  _updateWidths() {
    const lw = parseInt(this.getAttribute('label-width')) || 9;
    const vw = parseInt(this.getAttribute('value-width')) || 12;

    const cells = this.querySelectorAll('flipboard-cell');
    let maxLabel = lw, maxValue = vw;

    for (const cell of cells) {
      const labelEl = cell.querySelector('[slot="label"]');
      const valueEl = cell.querySelector('[slot="value"]');
      maxLabel = Math.max(maxLabel, (labelEl?.textContent?.trim() || '').length);
      maxValue = Math.max(maxValue, (valueEl?.textContent?.trim() || '').length);
    }

    for (const cell of cells) {
      cell.setAttribute('label-chars', maxLabel);
      cell.setAttribute('value-chars', maxValue);
    }
  }
}

customElements.define('flipboard-cell', FlipboardCell);
customElements.define('flipboard-bar', FlipboardBar);
