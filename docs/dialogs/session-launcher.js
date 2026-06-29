/**
 * Session launcher — view, switch, stop, and launch sessions.
 */

import { h, replaceContent } from '../dom.js';
import { getDlg } from './dialog-helpers.js';
import { openTeamBuilder } from './team-builder.js';
import { startMetricsPolling } from '../features/metrics.js';
import { restoreMemoryFromPod } from '../sync/sync-helpers.js';

// TODO: connectWebSocket and renderTimeline are in app.js — passed via
// setSessionLauncherCallbacks to avoid circular dependency
let _connectWebSocket = null;
let _renderTimeline = null;

export function setSessionLauncherCallbacks({ connectWebSocket, renderTimeline }) {
  _connectWebSocket = connectWebSocket;
  _renderTimeline = renderTimeline;
}

export function showSessionLauncher() {
  const dlg = getDlg();
  const projectStore = document.getElementById('projects');

  dlg.openTemplate('tpl-detail', {
    title: 'Sessions',
    onOpen: async () => {
      const body = dlg.bodyEl.querySelector('#dialog-body');
      replaceContent(body, h('p', { style: 'color:var(--text-dim)' }, 'Loading...'));

      await projectStore.refresh();
      const sessions = projectStore.state.sessions;
      const active = projectStore.state.activeSession;

      let sessionListContent;
      if (sessions.length === 0) {
        sessionListContent = [h('p', { style: 'color:var(--text-dim);margin:0.5rem 0' }, 'No running sessions')];
      } else {
        sessionListContent = sessions.map(s =>
          h('div', { class: `session-card ${s.session === active ? 'active' : ''}`, 'data-session': s.session },
            h('span', { class: `session-card-status ${s.status || 'running'}` }),
            h('span', { class: 'session-card-name' }, s.session),
            h('span', { class: 'session-card-meta' }, `${s.agentCount || '?'} agents`),
            h('button', { class: 'mcp-action-btn session-card-stop', 'data-stop': s.session, title: 'Stop' }, 'Stop'),
          )
        );
      }

      const launchNewBtn = h('button', { class: 'team-btn primary', id: 'session-launch-new' }, 'Launch New Session');

      replaceContent(body,
        h('div', { class: 'session-list' }, ...sessionListContent),
        h('div', { style: 'margin-top:0.75rem;border-top:1px solid var(--border);padding-top:0.75rem' },
          launchNewBtn
        )
      );

      body.querySelectorAll('.session-card[data-session]').forEach(el => {
        el.addEventListener('click', (e) => {
          if (e.target.closest('.session-card-stop')) return;
          dlg.close();
          switchToSession(el.dataset.session);
        });
      });

      body.querySelectorAll('.session-card-stop').forEach(btn => {
        btn.addEventListener('click', async (e) => {
          e.stopPropagation();
          btn.textContent = '...';
          btn.disabled = true;
          await projectStore.stopSession(btn.dataset.stop);
          await projectStore.refresh();
          showSessionLauncher();
        });
      });

      launchNewBtn.addEventListener('click', () => {
        dlg.close();
        openTeamBuilder(0, 'Launch Session');
      });
    },
  });
}

export async function switchToSession(sessionName) {
  const projectStore = document.getElementById('projects');

  projectStore.setActive(sessionName);
  startMetricsPolling();

  // Always route through the /ws proxy — the bus port is internal and
  // unreachable from the browser in cloud deployments. The proxy resolves
  // the correct backend bus port server-side via the ?session= param.
  const busUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?session=${encodeURIComponent(sessionName)}`;

  // Clear agent deck and message feed
  const agentStore = document.getElementById('agents');
  const msgStore = document.getElementById('messages');
  if (agentStore) {
    agentStore._isInternalChange = true;
    agentStore.state.agents = {};
    agentStore._isInternalChange = false;
    const deck = document.getElementById('agent-deck');
    if (deck) deck.replaceChildren();
  }
  if (msgStore) {
    msgStore._isInternalChange = true;
    msgStore.state.messages = [];
    msgStore._isInternalChange = false;
  }

  // Load persisted message history before connecting WebSocket
  try {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/messages?limit=200`);
    if (resp.ok) {
      const data = await resp.json();
      if (data.messages?.length && msgStore) {
        for (const m of data.messages) {
          if (m.channel === 'activity') continue;
          if (m.channel === 'control') {
            try { const c = JSON.parse(m.content); if (c.action === 'add_tool' || c.action === 'remove_tool') continue; } catch {}
          }
          if (typeof m.from === 'object') m.from = m.from?.name || m.from?.id || 'unknown';
          msgStore.add(m);
        }
      }
    }
  } catch { /* history not available — will populate from live WebSocket */ }

  restoreMemoryFromPod(sessionName);

  _renderTimeline?.();

  // Dispatch event — handled by the DOMContentLoaded listener which
  // tears down the existing WebSocket and calls connectWebSocket(busUrl)
  window.dispatchEvent(new CustomEvent('porter-switch-session', {
    detail: { busUrl, session: sessionName },
  }));
}
