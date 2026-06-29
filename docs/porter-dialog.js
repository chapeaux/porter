/**
 * <porter-dialog> — single reusable dialog component.
 *
 * One instance in the DOM, reused for every dialog by loading content
 * from <template> elements or dynamic HTML.
 *
 * Usage (template):
 *   dialog.openTemplate('tpl-team-builder', { title: 'Team Builder' });
 *
 * Usage (dynamic — DOM nodes):
 *   dialog.openContent({
 *     title: 'Confirm',
 *     bodyEl: h('p', null, 'Are you sure?'),
 *     footerEl: h('button', { class: 'team-btn primary' }, 'Yes'),
 *   });
 *
 * Usage (dynamic — plain strings become textContent):
 *   dialog.openContent({
 *     title: 'Detail',
 *     body: 'Some plain text',
 *   });
 *
 * The component fires 'porter-dialog-close' when closed.
 * Call dialog.close() or click the X / backdrop / Escape to close.
 */

class PorterDialog extends HTMLElement {
  constructor() {
    super();
    this._currentId = null;
    this._onCloseCallbacks = [];
  }

  connectedCallback() {
    this.attachShadow({ mode: 'open' });

    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'porter.css';

    const style = document.createElement('style');
    style.textContent = `
        :host { display: contents; }
        dialog:not([open]) { display: none; }
        dialog[open] {
          display: flex;
          flex-direction: column;
          background: var(--bg-card, #003);
          color: var(--text-primary, #f0e6d2);
          border: 1px solid var(--border, #004488);
          border-radius: 8px;
          padding: 0;
          width: min(90vw, 700px);
          max-height: 85vh;
          font-family: inherit;
          box-shadow: 0 8px 32px rgba(0,0,0,0.5);
        }
        dialog::backdrop {
          background: rgba(0,0,0,0.6);
        }
        .pd-header {
          display: flex;
          align-items: center;
          gap: 0.5rem;
          padding: 0.75rem 1rem;
          border-bottom: 1px solid var(--border, #004488);
          background: var(--bg-secondary, #336699);
        }
        .pd-title {
          flex: 1;
          font-size: 1rem;
          font-weight: bold;
          margin: 0;
          font-family: inherit;
        }
        .pd-header-extra {
          display: contents;
        }
        .pd-close {
          background: none;
          border: none;
          color: var(--text-dim, #d4c4a8);
          font-size: 1.4rem;
          cursor: pointer;
          padding: 0 0.3rem 0.3rem;
          line-height: 1;
        }
        .pd-close:hover { color: var(--text-primary, #f0e6d2); }
        .pd-body {
          padding: 1rem;
          overflow-y: auto;
          flex: 1;
          min-height: 0;
        }
        .pd-footer {
          display: flex;
          gap: 0.5rem;
          justify-content: flex-end;
          padding: 0.75rem 1rem;
          border-top: 1px solid var(--border, #004488);
        }
        .pd-footer:empty, .pd-footer.hidden { display: none; }
    `;

    const dialog = document.createElement('dialog');

    const header = document.createElement('div');
    header.className = 'pd-header';

    const title = document.createElement('h2');
    title.className = 'pd-title';

    const headerExtra = document.createElement('div');
    headerExtra.className = 'pd-header-extra';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'pd-close';
    closeBtn.title = 'Close';
    closeBtn.textContent = '×';

    header.append(title, headerExtra, closeBtn);

    const body = document.createElement('div');
    body.className = 'pd-body';

    const footer = document.createElement('div');
    footer.className = 'pd-footer';

    dialog.append(header, body, footer);

    this.shadowRoot.append(link, style, dialog);

    this._dialog = this.shadowRoot.querySelector('dialog');
    this._titleEl = this.shadowRoot.querySelector('.pd-title');
    this._headerExtra = this.shadowRoot.querySelector('.pd-header-extra');
    this._bodyEl = this.shadowRoot.querySelector('.pd-body');
    this._footerEl = this.shadowRoot.querySelector('.pd-footer');
    this._closeBtn = this.shadowRoot.querySelector('.pd-close');

    this._closeBtn.addEventListener('click', () => this.close());
    this._dialog.addEventListener('click', (e) => {
      if (e.target === this._dialog) this.close();
    });
    this._dialog.addEventListener('close', () => {
      this._fireClose();
    });
  }

  /** Open a dialog by cloning a <template> element's content. */
  openTemplate(templateId, options = {}) {
    const tpl = document.getElementById(templateId);
    if (!tpl) {
      console.error(`[porter-dialog] Template #${templateId} not found`);
      return;
    }

    this._clear();
    this._currentId = options.id || templateId;

    if (options.title !== undefined) this._titleEl.textContent = options.title;
    if (options.noClose) this._closeBtn.style.display = 'none';
    else this._closeBtn.style.display = '';

    const clone = tpl.content.cloneNode(true);

    // Separate header-extra, body, and footer content from the template
    const headerExtra = clone.querySelector('[data-dialog-header]');
    const footer = clone.querySelector('[data-dialog-footer]');

    if (headerExtra) {
      headerExtra.remove();
      this._headerExtra.appendChild(headerExtra);
    }
    if (footer) {
      footer.remove();
      this._footerEl.appendChild(footer);
      this._footerEl.classList.remove('hidden');
    } else {
      this._footerEl.classList.add('hidden');
    }

    // Everything remaining goes into the body
    this._bodyEl.appendChild(clone);

    if (options.onClose) this._onCloseCallbacks.push(options.onClose);
    if (options.onOpen) options.onOpen(this);

    this._dialog.showModal();
  }

  /** Open a dialog with dynamic content (strings or DOM nodes). */
  openContent(options = {}) {
    this._clear();
    this._currentId = options.id || null;

    this._titleEl.textContent = options.title || '';

    if (options.noClose) this._closeBtn.style.display = 'none';
    else this._closeBtn.style.display = '';

    // Body
    if (options.bodyEl) {
      this._bodyEl.appendChild(options.bodyEl);
    } else if (options.body) {
      this._bodyEl.textContent = options.body;
    }

    // Header extra
    if (options.headerEl) {
      this._headerExtra.appendChild(options.headerEl);
    } else if (options.header) {
      this._headerExtra.textContent = options.header;
    }

    // Footer
    if (options.footerEl) {
      this._footerEl.appendChild(options.footerEl);
      this._footerEl.classList.remove('hidden');
    } else if (options.footer) {
      this._footerEl.textContent = options.footer;
      this._footerEl.classList.remove('hidden');
    } else {
      this._footerEl.classList.add('hidden');
    }

    if (options.onClose) this._onCloseCallbacks.push(options.onClose);
    if (options.onOpen) options.onOpen(this);

    this._dialog.showModal();
  }

  close() {
    if (this._dialog.open) this._dialog.close();
  }

  get isOpen() {
    return this._dialog?.open ?? false;
  }

  /** The current dialog's identifier (template ID or custom ID). */
  get currentId() {
    return this._currentId;
  }

  /** Direct access to the title element. */
  get titleEl() { return this._titleEl; }

  /** Direct access to the body container. */
  get bodyEl() { return this._bodyEl; }

  /** Direct access to the footer container. */
  get footerEl() { return this._footerEl; }

  /** Direct access to the header-extra container. */
  get headerExtra() { return this._headerExtra; }

  /** Set the title text. */
  set dialogTitle(val) { this._titleEl.textContent = val; }
  get dialogTitle() { return this._titleEl.textContent; }

  _clear() {
    this._bodyEl.replaceChildren();
    this._bodyEl.scrollTop = 0;
    this._footerEl.replaceChildren();
    this._footerEl.classList.add('hidden');
    this._headerExtra.replaceChildren();
    this._titleEl.textContent = '';
    this._closeBtn.style.display = '';
    this._currentId = null;
    this._onCloseCallbacks = [];
  }

  _fireClose() {
    const id = this._currentId;
    for (const cb of this._onCloseCallbacks) {
      try { cb(id); } catch { /* ignore */ }
    }
    this.dispatchEvent(new CustomEvent('porter-dialog-close', {
      bubbles: true,
      detail: { id },
    }));
  }
}

customElements.define('porter-dialog', PorterDialog);
