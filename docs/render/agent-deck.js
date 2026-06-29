/**
 * Agent deck rendering — extracted from app.js
 */

import {
  ROLE_COLORS, STATUS_COLORS,
  formatAge, summarizeParams,
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

// Track which agent card is expanded
let expandedAgent = null;

export function renderAgentDeck() {
  const agents = document.getElementById('agents').state.agents;
  const deck = document.getElementById('agent-deck');

  for (const [name, info] of Object.entries(agents)) {
    let card = deck.querySelector(`[data-agent="${name}"]`);

    if (!card) {
      card = document.createElement('div');
      card.className = 'agent-card';
      card.dataset.agent = name;
      const header = h('div', { class: 'agent-header', title: 'Click to view activity' },
        h('div', { class: 'agent-name' }),
        h('div', { class: 'agent-status-dot' })
      );
      const role = h('div', { class: 'agent-role' });
      const state = h('div', { class: 'agent-state' });
      const stats = h('div', { class: 'agent-stats' },
        h('span', { class: 'agent-messages' }),
        h('span', { class: 'agent-activity-age' })
      );
      const action = h('div', { class: 'agent-current-action' });
      const restartBtn = h('button', { class: 'agent-restart-btn', title: 'Restart this agent' }, '↻');
      restartBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        restartAgent(name);
      });
      card.replaceChildren(header, role, state, stats, action, restartBtn);
      header.addEventListener('click', () => {
        showAgentDialog(name);
      });
      deck.appendChild(card);
    }

    const roleColor = ROLE_COLORS[info.role] || ROLE_COLORS.unknown;
    const statusColor = STATUS_COLORS[info.status] || STATUS_COLORS.active;
    card.style.borderTopColor = roleColor;

    card.querySelector('.agent-name').textContent = name;
    card.querySelector('.agent-status-dot').style.background = statusColor;

    const roleBadge = card.querySelector('.agent-role');
    roleBadge.textContent = info.role + (info.model ? ` / ${info.model.split('-').slice(-1)[0]}` : '');
    roleBadge.style.color = roleColor;

    card.querySelector('.agent-messages').textContent = `${info.messageCount} events`;
    card.querySelector('.agent-activity-age').textContent = formatAge(info.lastActivity);

    // Show agent state
    const stateEl = card.querySelector('.agent-state');
    const stateLabel = deriveAgentState(info);
    stateEl.textContent = stateLabel;
    stateEl.className = `agent-state agent-state-${stateLabel}`;

    // Show the most recent action
    const currentAction = card.querySelector('.agent-current-action');
    const lastEntry = (info.activity || []).slice(-1)[0];
    if (lastEntry) {
      currentAction.textContent = formatActivityEntry(lastEntry);
      currentAction.className = 'agent-current-action ' + (lastEntry.type === 'error' ? 'error' : lastEntry.type === 'retrying' ? 'retrying' : '');
    }
  }
}

export function showAgentDialog(name) {
  const agents = document.getElementById('agents').state.agents;
  const info = agents[name];
  if (!info) return;

  const entries = (info.activity || []).slice(-50).reverse();
  const lines = entries.map((entry) => {
    const time = new Date(entry.time).toLocaleTimeString();
    return `[${time}] ${formatActivityEntry(entry)}`;
  });

  const stateLabel = deriveAgentState(info);
  const header = `${name} (${info.role}) -- ${stateLabel} -- ${info.messageCount} events`;

  if (_showDialog) {
    _showDialog(header, lines.join('\n') || 'No activity yet.');
  }
}

async function restartAgent(name) {
  const session = document.getElementById('projects')?.state?.activeSession;
  if (!session) return;
  const btn = document.querySelector(`[data-agent="${name}"] .agent-restart-btn`);
  if (btn) { btn.disabled = true; btn.textContent = '...'; }
  try {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(session)}/agents/${encodeURIComponent(name)}/restart`, { method: 'POST' });
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({}));
      console.error(`[porter] Restart failed: ${data.error || resp.statusText}`);
    }
  } catch (err) {
    console.error(`[porter] Restart failed: ${err.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '↻'; }
  }
}

export function deriveAgentState(info) {
  if (info.status === 'done') return 'done';
  if (info.status === 'error') return 'error';
  if (info.status === 'retrying') return 'retrying';

  // Infer working vs idle from recent activity
  const lastEntry = (info.activity || []).slice(-1)[0];
  if (!lastEntry) return 'idle';

  const ageSecs = (Date.now() - lastEntry.time) / 1000;
  if (lastEntry.type === 'done') return 'done';
  if (lastEntry.type === 'error') return 'error';
  if (ageSecs < 120) return 'working';
  return 'idle';
}

export function formatActivityEntry(entry) {
  switch (entry.type) {
    case 'text':
      return entry.text.length > 120 ? entry.text.slice(0, 117) + '...' : entry.text;
    case 'tool_call':
      return `> ${entry.tool}(${summarizeParams(entry.params)})`;
    case 'tool_result':
      return entry.ok
        ? `  OK: ${(entry.output || '').slice(0, 80)}`
        : `  ERR: ${(entry.output || '').slice(0, 80)}`;
    case 'retrying':
      return `RETRYING (${entry.attempt}): ${entry.message}`;
    case 'error':
      return `ERROR: ${entry.message}`;
    case 'done':
      return '--- finished ---';
    default:
      return JSON.stringify(entry);
  }
}

// Update agent activity ages every 10s
setInterval(() => {
  const deck = document.getElementById('agent-deck');
  const agents = document.getElementById('agents').state.agents;
  for (const [name, info] of Object.entries(agents)) {
    const card = deck.querySelector(`[data-agent="${name}"]`);
    if (card) {
      card.querySelector('.agent-activity-age').textContent = formatAge(info.lastActivity);
    }
  }
}, 10000);
