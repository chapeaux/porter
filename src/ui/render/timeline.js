/**
 * Timeline / message feed rendering — extracted from app.js
 */

import {
  AS2_TYPES, AS2_COLORS, AS2_ICONS,
  CHANNEL_COLORS,
} from '../constants.js';
import { h } from '../dom.js';

// TODO: showDialog is defined in app.js (dialog helpers section).
// Once dialog helpers are extracted to their own module, import from there.
// For now we keep a module-level reference that app.js will supply.
let _showDialog = null;

/** Allow app.js to inject the showDialog dependency. */
export function setShowDialog(fn) {
  _showDialog = fn;
}

export function tryParseAS2(content) {
  if (!content || content[0] !== '{') return null;
  try {
    const obj = JSON.parse(content);
    if (obj && typeof obj.type === 'string' && AS2_TYPES.has(obj.type)) return obj;
  } catch {}
  return null;
}

export function renderAS2Files(obj) {
  if (!obj) return null;
  if (obj.type === 'Document' && obj.url) {
    const label = obj.summary ? `${obj.url} — ${obj.summary}` : obj.url;
    return h('span', { class: 'as2-file' }, label);
  }
  if (obj.type === 'Collection' && Array.isArray(obj.items)) {
    const children = obj.items.map(renderAS2Files).filter(Boolean);
    return children.length > 0 ? children : null;
  }
  return null;
}

export function renderAS2Message(as2) {
  const icon = AS2_ICONS[as2.type] || '';
  const color = AS2_COLORS[as2.type] || 'var(--text-secondary)';

  const bodyChildren = [];
  if (as2.summary) {
    bodyChildren.push(h('span', { class: 'as2-summary' }, as2.summary));
  }

  const filesEl = renderAS2Files(as2.object);
  if (filesEl) {
    bodyChildren.push(h('div', { class: 'as2-files' }, ...(Array.isArray(filesEl) ? filesEl : [filesEl])));
  }

  const noteContent = as2.object?.type === 'Note' && as2.object?.content;
  if (noteContent) {
    const truncated = noteContent.length > 200 ? noteContent.slice(0, 197) + '...' : noteContent;
    bodyChildren.push(h('div', { class: 'as2-note' }, truncated));
  }

  if (as2.result) {
    const resultFiles = renderAS2Files(as2.result);
    if (resultFiles) {
      bodyChildren.push(h('div', { class: 'as2-files' }, ...(Array.isArray(resultFiles) ? resultFiles : [resultFiles])));
    }
  }

  const msgChildren = [
    h('span', { class: 'as2-badge', style: `background:${color}` }, `${icon} ${as2.type}`),
    as2.context ? h('span', { class: 'as2-context' }, as2.context.replace('urn:porter:task:', '#')) : null,
    as2.target ? h('span', { class: 'as2-target' }, `→ ${as2.target}`) : null,
    ...(Array.isArray(as2.tag) ? as2.tag.map(t => h('span', { class: 'as2-tag' }, t)) : []),
    h('div', { class: 'as2-body' }, ...bodyChildren),
  ];

  return h('div', { class: 'as2-message' }, ...msgChildren);
}

export function getFeedLimit() {
  const el = document.getElementById('feed-limit');
  return el ? parseInt(el.value) || 50 : 50;
}

export function renderTimeline() {
  const store = document.getElementById('messages');
  const { messages, filter } = store.state;
  const timeline = document.getElementById('timeline');
  if (!timeline) return;
  const limit = getFeedLimit();

  const activeFilters = store.state.activeFilters;
  const filtered = (filter === 'all' || !activeFilters)
    ? messages
    : filter === 'toggle'
      ? messages.filter(m => activeFilters.has(m.channel) || activeFilters.has(m.channel.split(':')[0]))
      : messages.filter(m => m.channel === filter || m.channel.startsWith(filter + ':'));

  const visible = filtered.slice(-limit).reverse();

  timeline.replaceChildren();

  if (visible.length === 0) {
    timeline.replaceChildren(h('div', { id: 'empty-state' }, 'Waiting for messages...'));
    return;
  }

  for (const msg of visible) {
    const el = document.createElement('div');
    el.className = 'message';

    const color = CHANNEL_COLORS[msg.channel] || '#6b5e50';
    el.style.borderLeftColor = color;

    const time = new Date(msg.timestamp).toLocaleTimeString();
    const as2 = tryParseAS2(msg.content);

    if (as2) {
      el.style.borderLeftColor = AS2_COLORS[as2.type] || color;
      const actorName = typeof as2.actor === 'object' ? (as2.actor?.name || as2.actor?.id || msg.from) : (as2.actor || msg.from);
      const expandBtn = h('span', { class: 'message-expand' }, 'raw');
      const header = h('div', { class: 'message-header' },
        h('span', { class: 'message-channel', style: `color:${AS2_COLORS[as2.type] || color}` }, msg.channel),
        h('span', { class: 'message-from' }, actorName),
        h('span', { class: 'message-time' }, time),
        expandBtn
      );
      el.replaceChildren(header, renderAS2Message(as2));
      expandBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (_showDialog) {
          _showDialog(`${msg.channel} -- ${msg.from} -- ${time}`, JSON.stringify(as2, null, 2));
        }
      });
    } else {
      const isTruncated = msg.content.length > 300;
      const preview = isTruncated
        ? msg.content.slice(0, 297) + '...'
        : msg.content;

      const expandBtn = isTruncated ? h('span', { class: 'message-expand' }, 'expand') : null;
      const header = h('div', { class: 'message-header' },
        h('span', { class: 'message-channel', style: `color:${color}` }, msg.channel),
        h('span', { class: 'message-from' }, msg.from),
        h('span', { class: 'message-time' }, time),
        expandBtn
      );
      const content = h('div', { class: 'message-content' }, preview);
      el.replaceChildren(header, content);

      if (isTruncated) {
        expandBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          if (_showDialog) {
            _showDialog(`${msg.channel} -- ${msg.from} -- ${time}`, msg.content);
          }
        });
      }
    }

    timeline.appendChild(el);
  }

  timeline.scrollTop = 0;
}
