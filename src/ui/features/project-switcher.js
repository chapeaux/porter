/**
 * Project switcher — session list in the sidebar with edit/stop/delete.
 */

import { showDialog } from '../dialogs/dialog-helpers.js';
import { h } from '../dom.js';
import { openTeamBuilder } from '../dialogs/team-builder.js';
import { switchToSession } from '../dialogs/session-launcher.js';

// TODO: connectWebSocket is in app.js — passed via setProjectSwitcherCallbacks
// to avoid circular dependency
let _connectWebSocket = null;

export function setProjectSwitcherCallbacks({ connectWebSocket }) {
  _connectWebSocket = connectWebSocket;
}

export function setupProjectSwitcher() {
  const projectStore = document.getElementById('projects');

  projectStore.addEventListener('change', (e) => {
    const { prop } = e.detail;
    if (prop === 'sessions') renderProjectList();
    if (prop === 'activeSession') {
      const active = projectStore.state.activeSession;
      const cell = document.getElementById('fb-session');
      const val = document.getElementById('fb-session-val');
      if (cell && val) {
        val.textContent = active || 'NO SESSION';
        cell.setAttribute('status', active ? 'ok' : 'warn');
      }
    }
  });

  projectStore.refresh();

  setInterval(() => projectStore.refresh(), 15000);
}

export function renderProjectList() {
  const projectStore = document.getElementById('projects');
  const list = document.getElementById('project-list');
  if (!list) return;

  const sessions = projectStore.state.sessions;
  const active = projectStore.state.activeSession;

  if (sessions.length === 0) {
    list.replaceChildren(h('div', { class: 'project-item', style: 'color:var(--text-dim)' }, 'No sessions found'));
    return;
  }

  /** Helper: clean up UI and reconnect to lobby after stop/delete */
  function returnToLobby(sessionName) {
    if (projectStore.state.activeSession === sessionName ||
        projectStore.state.sessions.length === 0) {
      projectStore.setActive(null);

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

      _connectWebSocket?.(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws`);
    }
  }

  const items = sessions.map(s => {
    const editBtn = h('button', { class: 'session-edit-btn', title: 'Edit team' }, '✏️');
    const stopBtn = h('button', { class: 'session-stop-btn', title: 'Stop session' }, '⏹');
    const deleteBtn = h('button', { class: 'session-delete-btn', title: 'Delete session' }, '🗑');

    const item = h('div', {
      class: `project-item ${s.session === active ? 'active' : ''}`,
      'data-session': s.session,
    },
      h('span', { class: `project-status ${s.status}` }),
      h('span', null, s.session),
      h('span', { style: 'margin-left:auto;color:var(--text-dim);font-size:0.75rem' }, `${s.agentCount} agents`),
      editBtn,
      stopBtn,
      deleteBtn
    );

    // Session switching
    item.addEventListener('click', (e) => {
      if (e.target.closest('.session-edit-btn, .session-stop-btn, .session-delete-btn')) return;
      switchToSession(s.session);
      document.getElementById('project-dropdown')?.classList.add('hidden');
    });

    // Edit handler
    editBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      try {
        const resp = await fetch(`/api/sessions/${encodeURIComponent(s.session)}/config`);
        if (!resp.ok) { alert('Failed to load session config'); return; }
        const data = await resp.json();
        const configStore = document.getElementById('config');
        configStore.fromJSON(data.config);
        configStore.setState({ editingSession: s.session });
        document.getElementById('project-dropdown')?.classList.add('hidden');
        openTeamBuilder(configStore.state.step);
      } catch (err) {
        alert('Error loading session: ' + err.message);
      }
    });

    // Stop handler
    stopBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Stop session "${s.session}"? A snapshot will be saved.`)) return;
      try {
        await projectStore.stopSession(s.session);
        await projectStore.refresh();
        returnToLobby(s.session);
      } catch (err) {
        console.error('Failed to stop session:', err);
      }
    });

    // Delete handler
    deleteBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!confirm(`Delete session "${s.session}"? This will stop the session and remove its snapshot. This cannot be undone.`)) return;
      try {
        const resp = await fetch(`/api/sessions/${encodeURIComponent(s.session)}`, { method: 'DELETE' });
        if (resp.ok) {
          await projectStore.refresh();
          returnToLobby(s.session);
        }
      } catch (err) {
        console.error('Failed to delete session:', err);
      }
    });

    return item;
  });

  list.replaceChildren(...items);
}
