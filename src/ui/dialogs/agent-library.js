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
import { syncAgentsToPod, deleteAgentFromPod, setResourcePublic } from '../sync/sync-helpers.js';

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

      const selected = new Set();
      const buildTeamBtn = h('button', { class: 'dialog-header-add', id: 'lib-build-team', disabled: true }, 'Build Team (0)');

      // Header buttons
      const importBtn2 = h('button', { class: 'dialog-header-add' }, 'Import');
      const newAgentBtn = h('button', { class: 'dialog-header-add' }, '+ New');
      dlg.headerExtra.replaceChildren(buildTeamBtn, importBtn2, newAgentBtn);

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

      replaceContent(body,
        h('p', { style: 'color:var(--text-dim);margin:0 0 0.75rem' }, `${agents.length} saved agent${agents.length !== 1 ? 's' : ''}`),
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
              maxTurns: agent.max_turns || undefined,
              maxContextTokens: agent.max_context_tokens || undefined,
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
          // Delete from Pod explicitly
          await deleteAgentFromPod(name);
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

      // Share URI — prefer Pod Turtle URI if Pod sync is active
      body.querySelectorAll('.lib-share-agent').forEach(btn => {
        btn.addEventListener('click', async () => {
          const name = btn.dataset.name;
          if (window._podSync) {
            const podRoot = window._podSync._podRoot;
            const authFetch = window._podSync._fetch;
            const podUri = `${podRoot}porter/agents/${encodeURIComponent(name)}.ttl`;
            try {
              btn.textContent = 'Sharing...';
              await setResourcePublic(authFetch, podUri);
              await navigator.clipboard.writeText(podUri);
              btn.textContent = 'Shared ✓';
              btn.title = podUri;
              btn.disabled = true;
            } catch (e) {
              console.error('[porter] Share failed:', e);
              const serverUri = `${location.origin}/api/agents/${encodeURIComponent(name)}`;
              try { await navigator.clipboard.writeText(serverUri); } catch { /* ignore */ }
              btn.textContent = 'Copied (server)';
              setTimeout(() => { btn.textContent = 'Share'; }, 2000);
            }
          } else {
            const agentUri = `${location.origin}/api/agents/${encodeURIComponent(name)}`;
            try {
              await navigator.clipboard.writeText(agentUri);
              btn.textContent = 'Copied ✓';
              btn.title = agentUri;
            } catch {
              btn.textContent = 'URI copied';
            }
            setTimeout(() => { btn.textContent = 'Share'; }, 3000);
          }
        });
      });

      // Import (URL or file)
      importBtn2.addEventListener('click', () => {
        showImportDialog(() => showAgentLibrary());
      });
    },
  });
}

/**
 * Unified import dialog — URL or file upload.
 * URL supports Link (remote reference) or Copy (local ownership).
 * File upload always creates a local copy.
 */
function showImportDialog(onSuccess) {
  const dlg = getOverlayDlg();
  dlg.openTemplate('tpl-detail', {
    title: 'Import Agent',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#dialog-body');

      // Source tabs
      const tabUrl = h('button', { class: 'team-btn primary', style: 'flex:1' }, 'From URL');
      const tabFile = h('button', { class: 'team-btn secondary', style: 'flex:1' }, 'From File');
      const tabs = h('div', { style: 'display:flex;gap:0.3rem;margin-bottom:0.75rem' }, tabUrl, tabFile);

      // URL section
      const urlInput = h('input', {
        type: 'url',
        placeholder: 'https://example.com/agents/my-agent.jsonld',
        style: 'width:100%',
      });
      const modeLink = h('input', { type: 'radio', name: 'import-mode', value: 'link', checked: true });
      const modeCopy = h('input', { type: 'radio', name: 'import-mode', value: 'copy' });
      const urlSection = h('div', { id: 'import-url-section' },
        h('div', { class: 'team-field' },
          h('label', null, 'Agent URL'),
          urlInput,
          h('div', { class: 'field-hint' }, 'Accepts .jsonld, .ttl, or .json from any URL (GitHub raw, Solid Pod, etc.)'),
        ),
        h('div', { class: 'team-field', style: 'margin-top:0.5rem' },
          h('label', null, 'Import Mode'),
          h('div', { style: 'display:flex;gap:1rem;margin-top:0.25rem' },
            h('label', { style: 'display:flex;align-items:center;gap:0.3rem;cursor:pointer' }, modeLink, 'Link (remote reference)'),
            h('label', { style: 'display:flex;align-items:center;gap:0.3rem;cursor:pointer' }, modeCopy, 'Copy (local ownership)'),
          ),
          h('div', { class: 'field-hint' }, 'Link keeps a live reference — updates at the source propagate. Copy is independent.'),
        ),
      );

      // File section
      const fileInput = h('input', {
        type: 'file',
        accept: '.jsonld,.ttl,.json',
        style: 'width:100%',
      });
      const fileSection = h('div', { id: 'import-file-section', style: 'display:none' },
        h('div', { class: 'team-field' },
          h('label', null, 'Agent File'),
          fileInput,
          h('div', { class: 'field-hint' }, 'Upload a .jsonld, .ttl, or .json agent definition. Creates a local copy.'),
        ),
      );

      const importBtn = h('button', { class: 'team-btn primary', style: 'width:100%;margin-top:0.75rem' }, 'Import');
      const statusEl = h('div', { style: 'margin-top:0.5rem;font-size:0.85rem;display:none' });

      replaceContent(body, tabs, urlSection, fileSection, importBtn, statusEl);

      // Tab switching
      let activeTab = 'url';
      tabUrl.addEventListener('click', () => {
        activeTab = 'url';
        tabUrl.className = 'team-btn primary';
        tabFile.className = 'team-btn secondary';
        urlSection.style.display = '';
        fileSection.style.display = 'none';
        statusEl.style.display = 'none';
      });
      tabFile.addEventListener('click', () => {
        activeTab = 'file';
        tabFile.className = 'team-btn primary';
        tabUrl.className = 'team-btn secondary';
        fileSection.style.display = '';
        urlSection.style.display = 'none';
        statusEl.style.display = 'none';
      });

      importBtn.addEventListener('click', async () => {
        statusEl.style.display = 'none';
        importBtn.textContent = 'Importing...';
        importBtn.disabled = true;

        try {
          if (activeTab === 'url') {
            // URL import
            const url = urlInput.value.trim();
            if (!url) {
              statusEl.textContent = 'Please enter a URL';
              statusEl.style.color = 'var(--status-error)';
              statusEl.style.display = '';
              importBtn.textContent = 'Import';
              importBtn.disabled = false;
              return;
            }
            const mode = body.querySelector('input[name="import-mode"]:checked')?.value || 'link';
            // Check for duplicate before URL import
            const urlCheckResp = await fetch('/api/agents/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url, mode, dry_run: true }),
            });
            if (urlCheckResp.ok) {
              const checkData = await urlCheckResp.json();
              if (checkData.exists) {
                const confirmed = confirm(`An agent named "${checkData.agent}" already exists. Replace it?`);
                if (!confirmed) {
                  importBtn.textContent = 'Import';
                  importBtn.disabled = false;
                  return;
                }
              }
            }
            const resp = await fetch('/api/agents/import', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ url, mode }),
            });
            if (!resp.ok) {
              const data = await resp.json().catch(() => ({}));
              throw new Error(data.error || 'Import failed');
            }
          } else {
            // File import — always copy
            const file = fileInput.files?.[0];
            if (!file) {
              statusEl.textContent = 'Please select a file';
              statusEl.style.color = 'var(--status-error)';
              statusEl.style.display = '';
              importBtn.textContent = 'Import';
              importBtn.disabled = false;
              return;
            }
            const text = await file.text();
            let agentData;
            if (file.name.endsWith('.ttl')) {
              // Parse Turtle — extract fields via regex
              const { parseTurtleAgent } = await import('../sync/sync-helpers.js');
              agentData = parseTurtleAgent(text);
              if (!agentData) throw new Error('Could not parse Turtle file');
            } else {
              // JSON or JSON-LD
              agentData = JSON.parse(text);
            }
            // Normalize field names
            const agent = {
              name: agentData.name || agentData['porter:name'] || file.name.replace(/\.(jsonld|json|ttl)$/, ''),
              role: agentData.role || agentData['porter:assignedRole'] || 'worker',
              model: agentData.model || agentData['porter:usesModel'] || '',
              system_prompt: agentData.expertise || agentData.system_prompt || agentData.systemPrompt || agentData['porter:agentExpertise'] || '',
              tools: agentData.tools || agentData['porter:hasTool'] || [],
              channels: [],
              mcp_tools: agentData.mcp_tools || [],
              max_tokens: agentData.maxTokens || agentData.max_tokens || 8192,
              max_turns: agentData.maxTurns || agentData.max_turns || undefined,
              max_context_tokens: agentData.maxContextTokens || agentData.max_context_tokens || undefined,
              reasoning: agentData.reasoning || false,
              derived_from: `file:${file.name}`,
            };
            // Check for duplicate
            const existsResp = await fetch(`/api/agents/${encodeURIComponent(agent.name)}`);
            if (existsResp.ok) {
              const confirmed = confirm(`An agent named "${agent.name}" already exists. Replace it?`);
              if (!confirmed) {
                importBtn.textContent = 'Import';
                importBtn.disabled = false;
                return;
              }
            }
            const resp = await fetch('/api/agents', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(agent),
            });
            if (!resp.ok) throw new Error('Failed to save agent');
          }

          statusEl.textContent = 'Agent imported successfully';
          statusEl.style.color = 'var(--status-ok)';
          statusEl.style.display = '';
          // Sync to Pod
          fetch('/api/agents')
            .then(r => r.ok ? r.json() : { agents: [] })
            .then(data => syncAgentsToPod(data.agents || []))
            .catch(() => {});
          setTimeout(() => {
            dlg.close();
            if (onSuccess) onSuccess();
            updateSetupBar();
          }, 800);
        } catch (e) {
          statusEl.textContent = e.message || 'Import failed';
          statusEl.style.color = 'var(--status-error)';
          statusEl.style.display = '';
          importBtn.textContent = 'Import';
          importBtn.disabled = false;
        }
      });
    },
  });
}

export async function showSavedAgentPicker(forRole) {
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
          if (forRole) agentForTeam.role = forRole;
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
