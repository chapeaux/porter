/**
 * Shared constants for the Porter UI.
 */

/** True when running as a static site with no backend (GitHub Pages, etc.) */
export const BROWSER_MODE = document.querySelector('meta[name="porter-mode"]')?.content === 'browser';

/** The API base URL — empty string for same-origin, or a full URL for connected mode */
export const API_BASE = document.querySelector('meta[name="porter-api"]')?.content || '';

export const CHANNEL_COLORS = {
  task: '#c9a84c',
  log: '#5b8c6b',
  control: '#7b6ba8',
  activity: '#b87333',
};

export const ROLE_COLORS = {
  admin: '#c9a84c',
  worker: '#b87333',
  reviewer: '#5b8c6b',
  unknown: '#6b5e50',
};

export const STATUS_COLORS = {
  active: '#5b8c6b',
  retrying: '#c9a84c',
  done: '#6b5e50',
  error: '#8b3a3a',
};

export const AS2_TYPES = new Set([
  'Offer', 'Accept', 'Reject', 'Create', 'Update', 'Delete',
  'Announce', 'Question', 'Note', 'Invoke', 'Read', 'Remember', 'Recall',
]);

export const AS2_COLORS = {
  Offer: 'var(--accent-gold)', Accept: 'var(--status-ok, #5b8c6b)',
  Reject: 'var(--status-error, #8b3a3a)', Create: 'var(--status-ok, #5b8c6b)',
  Update: 'var(--accent-copper, #b87333)', Delete: 'var(--status-error, #8b3a3a)',
  Announce: 'var(--text-secondary)', Question: 'var(--accent-gold)',
  Note: 'var(--text-secondary)',
  Invoke: 'var(--accent-copper, #b87333)', Read: 'var(--channel-log, #5b8c6b)',
  Remember: 'var(--channel-control, #7b6ba8)', Recall: 'var(--channel-control, #7b6ba8)',
};

export const AS2_ICONS = {
  Invoke: '▶', Create: '📄', Update: '✏️', Delete: '🗑',
  Read: '📂', Offer: '📨', Accept: '✅', Reject: '❌',
  Announce: '📢', Question: '❓', Note: '📝',
  Remember: '🧠', Recall: '🧠',
};

export const RECONNECT_DELAYS = [1000, 2000, 4000, 8000, 16000];

export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

export function debounce(fn, ms) {
  let timer = null;
  return () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
}

export function formatAge(timestamp) {
  if (!timestamp) return '';
  const secs = Math.floor((Date.now() - timestamp) / 1000);
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  return `${Math.floor(secs / 3600)}h ago`;
}

export function summarizeParams(params) {
  if (!params) return '';
  const parts = [];
  for (const [key, val] of Object.entries(params)) {
    const s = typeof val === 'string' ? val : JSON.stringify(val);
    if (s.length > 40) {
      parts.push(`${key}: "${s.slice(0, 37)}..."`);
    } else {
      parts.push(`${key}: ${s}`);
    }
  }
  return parts.join(', ');
}

export function contextBadge(ctx) {
  if (!ctx || ctx === 'any') return '';
  return `<span class="context-badge ${ctx}">${ctx}</span>`;
}

export function getEnvironment() {
  const h = location.hostname;
  return (h === 'localhost' || h === '127.0.0.1') ? 'local' : 'remote';
}

export function classifyMcpContext(cfg) {
  if (cfg.transport === 'stdio') return 'local';
  if (cfg.url && /localhost|127\.0\.0\.1/i.test(cfg.url)) return 'local';
  return 'any';
}

export function classifyModelContext(model) {
  if (model.base_url && /localhost|127\.0\.0\.1/i.test(model.base_url)) return 'local';
  return 'any';
}

export function isContextCompatible(itemContext) {
  if (!itemContext || itemContext === 'any') return true;
  return itemContext === getEnvironment();
}
