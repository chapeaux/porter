/**
 * Agent library — browse, create, edit, delete saved agents.
 */

import { isContextCompatible } from '../constants.js';
import { h, text, replaceContent } from '../dom.js';
import { getDlg, getOverlayDlg } from './dialog-helpers.js';
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
    maxTurns: raw.max_turns || raw.maxTurns || undefined,
    maxContextTokens: raw.max_context_tokens || raw.maxContextTokens || undefined,
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
            h('button', { class: 'mcp-action-btn lib-download-agent', 'data-name': a.name, title: 'Download as JSON-LD' }, 'Download'),
            h('button', { class: 'mcp-action-btn lib-share-agent', 'data-name': a.name, title: 'Share URI' }, 'Share'),
            h('button', { class: 'mcp-action-btn lib-edit-agent', 'data-name': a.name }, 'Edit'),
            h('button', { class: 'mcp-action-btn lib-delete-agent', 'data-name': a.name, style: 'background:var(--status-error)' }, 'Delete'),
          );
        });
      }

      const importUrlBtn = h('button', { class: 'team-btn', id: 'lib-import-url' }, 'Import from URL');

      replaceContent(body,
        h('div', { style: 'display:flex;justify-content:space-between;align-items:center;margin-bottom:0.75rem' },
          h('p', { style: 'color:var(--text-dim);margin:0' }, `${agents.length} saved agent${agents.length !== 1 ? 's' : ''}`),
          h('div', { style: 'display:flex;gap:0.5rem' }, buildTeamBtn, importUrlBtn, newAgentBtn)
        ),
        h('div', { class: 'saved-agent-list' }, ...listContent)
      );

      buildTeamBtn.addEventListener('click', () => {
        const configStore = document.getElementById('config');
        const teamAgents = [...selected].map(i => {
          const a = convertSavedAgent(agents[i]);
          a._isRef = true;
          a._fromLibrary = true;
          a.ref = agents[i].name;
          return a;
        });
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

      // Download as JSON-LD
      body.querySelectorAll('.lib-download-agent').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          try {
            const resp = await fetch(`/api/agents/${encodeURIComponent(name)}`, {
              headers: { 'Accept': 'application/ld+json' },
            });
            if (!resp.ok) throw new Error('Download failed');
            const data = await resp.text();
            const blob = new Blob([data], { type: 'application/ld+json' });
            const a = document.createElement('a');
            a.href = URL.createObjectURL(blob);
            a.download = `${name}.jsonld`;
            a.click();
            URL.revokeObjectURL(a.href);
          } catch {
            btn.textContent = 'Failed';
            setTimeout(() => { btn.textContent = 'Download'; }, 2000);
          }
        });
      });

      // Share URI
      body.querySelectorAll('.lib-share-agent').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          const agentUri = `${location.origin}/api/agents/${encodeURIComponent(name)}`;
          try {
            await navigator.clipboard.writeText(agentUri);
            btn.textContent = 'Copied';
          } catch {
            btn.textContent = 'URI copied';
          }
          setTimeout(() => { btn.textContent = 'Share'; }, 2000);
        });
      });

      // Import from URL
      importUrlBtn.addEventListener('click', () => {
        showImportFromUrlDialog(() => showAgentLibrary());
      });
    },
  });
}

/**
 * Show import-from-URL dialog. Lets the user paste a URL to an agent definition
 * and choose whether to link or copy it into the local library.
 */
function showImportFromUrlDialog(onSuccess) {
  const dlg = getOverlayDlg();
  dlg.openTemplate('tpl-detail', {
    title: 'Import Agent from URL',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#dialog-body');

      const urlInput = h('input', {
        type: 'url',
        id: 'import-agent-url',
        placeholder: 'https://example.com/agents/my-agent.jsonld',
        style: 'width:100%;padding:0.5rem;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary)',
      });

      const modeLink = h('input', { type: 'radio', name: 'import-mode', value: 'link', checked: true });
      const modeCopy = h('input', { type: 'radio', name: 'import-mode', value: 'copy' });

      const importBtn = h('button', { class: 'team-btn primary', style: 'width:100%;margin-top:0.75rem' }, 'Import');
      const statusEl = h('div', { id: 'import-url-status', style: 'margin-top:0.5rem;font-size:0.85rem;display:none' });

      replaceContent(body,
        h('div', { class: 'team-field' },
          h('label', null, 'Agent URL'),
          urlInput,
          h('div', { class: 'field-hint' }, 'URL to a JSON or JSON-LD agent definition.'),
        ),
        h('div', { class: 'team-field', style: 'margin-top:0.75rem' },
          h('label', null, 'Import Mode'),
          h('div', { style: 'display:flex;gap:1rem;margin-top:0.25rem' },
            h('label', { style: 'display:flex;align-items:center;gap:0.3rem;cursor:pointer' }, modeLink, 'Link (reference only)'),
            h('label', { style: 'display:flex;align-items:center;gap:0.3rem;cursor:pointer' }, modeCopy, 'Copy (full local copy)'),
          ),
          h('div', { class: 'field-hint' }, 'Link keeps a reference to the remote agent. Copy downloads the full definition.'),
        ),
        importBtn,
        statusEl,
      );

      importBtn.addEventListener('click', async () => {
        const url = urlInput.value.trim();
        if (!url) {
          statusEl.textContent = 'Please enter a URL';
          statusEl.style.color = 'var(--status-error)';
          statusEl.style.display = '';
          return;
        }

        const mode = body.querySelector('input[name="import-mode"]:checked')?.value || 'link';
        importBtn.textContent = 'Importing...';
        importBtn.disabled = true;

        try {
          const resp = await fetch('/api/agents/import', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url, mode }),
          });

          if (resp.ok) {
            statusEl.textContent = 'Agent imported successfully';
            statusEl.style.color = 'var(--status-ok)';
            statusEl.style.display = '';
            setTimeout(() => {
              dlg.close();
              if (onSuccess) onSuccess();
              updateSetupBar();
            }, 800);
          } else {
            const data = await resp.json().catch(() => ({}));
            statusEl.textContent = data.error || 'Import failed';
            statusEl.style.color = 'var(--status-error)';
            statusEl.style.display = '';
            importBtn.textContent = 'Import';
            importBtn.disabled = false;
          }
        } catch (e) {
          statusEl.textContent = `Error: ${e.message}`;
          statusEl.style.color = 'var(--status-error)';
          statusEl.style.display = '';
          importBtn.textContent = 'Import';
          importBtn.disabled = false;
        }
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
          const agentForTeam = convertSavedAgent(saved[i]);
          agentForTeam._isRef = true;
          agentForTeam._fromLibrary = true;
          agentForTeam.ref = saved[i].name;
          configStore.addAgent(agentForTeam);
        }
        dlg.close();
        openTeamBuilder(2);
      });
    },
  });
}
