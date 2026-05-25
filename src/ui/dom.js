/**
 * Safe DOM construction helpers — replaces innerHTML with createElement-based building.
 */

/**
 * Create an element with attributes and children.
 *
 *   h('div', { class: 'card', id: 'x' }, 'text', h('span', null, 'inner'))
 *   h('input', { type: 'checkbox', checked: true })
 */
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === false || v == null) continue;
      if (k === 'class' || k === 'className') el.className = v;
      else if (k === 'style' && typeof v === 'string') el.style.cssText = v;
      else if (k === 'checked' || k === 'disabled' || k === 'selected' || k === 'readOnly') el[k] = !!v;
      else if (k === 'value') el.value = v;
      else el.setAttribute(k, String(v));
    }
  }
  appendChildren(el, children);
  return el;
}

/**
 * Create a text node.
 */
export function text(str) {
  return document.createTextNode(str);
}

/**
 * Append mixed children (strings become text nodes, null/false are skipped).
 */
export function appendChildren(parent, children) {
  for (const child of children) {
    if (child == null || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      parent.appendChild(document.createTextNode(String(child)));
    } else if (Array.isArray(child)) {
      appendChildren(parent, child);
    } else {
      parent.appendChild(child);
    }
  }
}

/**
 * Clear an element and replace its children.
 */
export function replaceContent(el, ...children) {
  el.replaceChildren();
  appendChildren(el, children);
}
