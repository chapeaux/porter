/**
 * Agent library — browse, create, edit, delete saved agents.
 */

import { isContextCompatible } from '../constants.js';
import { h, text, replaceContent } from '../dom.js';
import { getDlg } from './dialog-helpers.js';
import { parsePromptSections, ROLE_CHANNEL_DEFAULTS } from '../stores/config-store.js';
import { openAgentEditor } from './agent-editor.js';
import { openTeamBuilder } from './team-builder.js';
import { updateSetupBar } from '../features/flipboard-setup.js';

function convertSavedAgent(raw) {
  return {
    name: raw.name,
    role: raw.role,
    model: raw.model || '',
    systemPrompt: raw.system_prompt || raw.systemPrompt || '',
    promptSections: raw.prompt_sections || raw.promptSections || parsePromptSections(raw.system_prompt || raw.systemPrompt || '', raw.role),
    tools: raw.tools || [],
    channels: raw.channels || raw.subscribe || ROLE_CHANNEL_DEFAULTS[raw.role] || [],
    maxTokens: raw.max_tokens || raw.maxTokens || 8192,
    reasoning: raw.reasoning || false,
    mcpTools: raw.mcp_tools || raw.mcpTools || [],
  };
}

export function showAgentLibrary() {
  const dlg = getDlg();
  dlg.openTemplate('tpl-detail', {
    title: 'Agent Library',
    onOpen: async () => {
      const body = dlg.bodyEl.querySelector('#dialog-body');
      replaceContent(body, h('p', { style: 'color:var(--text-dim)' }, 'Loading...'));

      let agents = [];
      try {
        const resp = await fetch('/api/agents');
        if (resp.ok) {
          const data = await resp.json();
          agents = data.agents || [];
        }
      } catch { /* ignore */ }

      const newAgentBtn = h('button', { class: 'team-btn primary', id: 'lib-new-agent' }, '+ New Agent');

      const selected = new Set();
      const buildTeamBtn = h('button', { class: 'team-btn primary', id: 'lib-build-team', disabled: true, style: 'margin-left:0.5rem' }, 'Build Team (0)');

      let listContent;
      if (agents.length === 0) {
        listContent = [h('p', { class: 'import-hint' }, 'No saved agents. Create one to reuse across teams.')];
      } else {
        listContent = agents.map((a, i) => {
          const ctx = a._context || 'any';
          const nameChildren = [a.name];
          if (ctx && ctx !== 'any') {
            nameChildren.push(text(' '));
            nameChildren.push(h('span', { class: `context-badge ${ctx}` }, ctx));
          }
          const cb = h('input', { type: 'checkbox', class: 'lib-agent-cb', 'data-idx': String(i) });
          cb.addEventListener('change', () => {
            if (cb.checked) selected.add(i); else selected.delete(i);
            buildTeamBtn.textContent = `Build Team (${selected.size})`;
            buildTeamBtn.disabled = selected.size === 0;
          });
          return h('div', { class: 'saved-agent-card', style: 'display:flex;align-items:center;gap:0.5rem' },
            cb,
            h('span', { class: 'saved-agent-name', style: 'flex:1' }, ...nameChildren),
            h('span', { class: 'saved-agent-role' }, a.role),
            h('button', { class: 'mcp-action-btn lib-edit-agent', 'data-name': a.name }, 'Edit'),
            h('button', { class: 'mcp-action-btn lib-delete-agent', 'data-name': a.name, style: 'background:var(--status-error)' }, 'Delete'),
          );
        });
      }

      replaceContent(body,
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem' },
          h('p', { style: 'color:var(--text-dim);margin:0' }, `${agents.length} saved agent${agents.length !== 1 ? 's' : ''}`),
          h('div', { style: 'display:flex;gap:0.5rem' }, buildTeamBtn, newAgentBtn)
        ),
        h('div', { class: 'saved-agent-list' }, ...listContent)
      );

      buildTeamBtn.addEventListener('click', () => {
        const configStore = document.getElementById('config');
        const teamAgents = [...selected].map(i => convertSavedAgent(agents[i]));
        configStore.setState({ agents: teamAgents, step: 2, teamName: '', errors: {} });
        dlg.close();
        openTeamBuilder(2, 'Build Team');
      });

      newAgentBtn.addEventListener('click', () => {
        dlg.close();
        const configStore = document.getElementById('config');
        const agent = configStore.createDefaultAgent(false);
        openAgentEditor(agent, null, true);
      });

      body.querySelectorAll('.lib-edit-agent').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          const agent = agents.find(a => a.name === name);
          if (agent) {
            dlg.close();
            openAgentEditor({
              name: agent.name,
              role: agent.role,
              model: agent.model || '',
              systemPrompt: agent.system_prompt || '',
              promptSections: agent.prompt_sections || parsePromptSections(agent.system_prompt || '', agent.role),
              tools: agent.tools || [],
              channels: agent.channels || [],
              maxTokens: agent.max_tokens || 8192,
              reasoning: agent.reasoning || false,
              mcpTools: agent.mcp_tools || [],
            }, null, true);
          }
        });
      });

      body.querySelectorAll('.lib-delete-agent').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          await fetch(`/api/agents/${encodeURIComponent(name)}`, { method: 'DELETE' });
          showAgentLibrary();
          updateSetupBar();
        });
      });
    },
  });
}

export async function showSavedAgentPicker() {
  let saved = [];
  try {
    const resp = await fetch('/api/agents');
    if (resp.ok) { const data = await resp.json(); saved = data.agents || []; }
  } catch { /* ignore */ }
  if (saved.length === 0) saved = JSON.parse(localStorage.getItem('porter-pod-agents') || '[]');
  if (saved.length === 0) {
    const dlg = getDlg();
    dlg.openTemplate('tpl-detail', {
      title: 'Saved Agents',
      onOpen: () => {
        replaceContent(dlg.bodyEl.querySelector('#dialog-body'),
          h('p', { style: 'color:var(--text-dim);padding:1rem' }, 'No saved agents found. Save an agent first — agents are automatically saved to your Pod when you add or edit them.')
        );
      },
    });
    return;
  }

  const dlg = getDlg();
  dlg.openTemplate('tpl-detail', {
    title: 'Add Saved Agents',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#dialog-body');
      const selected = new Set();
      const addBtn = h('button', { class: 'team-btn primary', disabled: true, style: 'margin-top:0.75rem;width:100%' }, 'Add Selected (0)');

      const agentCards = saved.map((a, i) => {
        const ctx = a._context || 'any';
        const compatible = isContextCompatible(ctx);
        const nameChildren = [a.name];
        if (ctx && ctx !== 'any') {
          nameChildren.push(text(' '));
          nameChildren.push(h('span', { class: `context-badge ${ctx}` }, ctx));
        }
        const cb = h('input', { type: 'checkbox', 'data-idx': String(i) });
        cb.addEventListener('change', () => {
          if (cb.checked) selected.add(i); else selected.delete(i);
          addBtn.textContent = `Add Selected (${selected.size})`;
          addBtn.disabled = selected.size === 0;
        });
        return h('div', { class: `saved-agent-card ${compatible ? '' : 'context-incompatible'}`, style: 'display:flex;align-items:center;gap:0.5rem' },
          cb,
          h('span', { class: 'saved-agent-name', style: 'flex:1' }, ...nameChildren),
          h('span', { class: 'saved-agent-role' }, a.role),
        );
      });

      replaceContent(body,
        h('div', { class: 'saved-agent-list' }, ...agentCards),
        addBtn
      );

      addBtn.addEventListener('click', () => {
        const configStore = document.getElementById('config');
        for (const i of selected) {
          configStore.addAgent(convertSavedAgent(saved[i]));
        }
        dlg.close();
        openTeamBuilder(2);
      });
    },
  });
}
