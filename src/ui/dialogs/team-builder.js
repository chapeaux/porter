/**
 * Team Builder — multi-step wizard for creating and managing agent teams.
 */

import { classifyMcpContext, isContextCompatible } from '../constants.js';
import { h, text, replaceContent } from '../dom.js';
import { getDlg, getOverlayDlg, dlgQuery, showDialog } from './dialog-helpers.js';
import { renderBusFlow } from '../render/flow-diagram.js';
import {
  injectMcpTokens,
  getAvailableModels, formatModelOption, generateSessionName,
  parsePromptSections,
} from '../stores/config-store.js';
import { renderModelSetup } from './model-setup.js';
import { renderMcpList } from './mcp-editor.js';
import { openAgentEditor } from './agent-editor.js';
import { showSavedAgentPicker } from './agent-library.js';
import { showSessionLauncher } from './session-launcher.js';
import { updateSetupBar } from '../features/flipboard-setup.js';
import { renderEmptyState } from '../features/empty-state.js';
import { startMetricsPolling } from '../features/metrics.js';
import { restoreMainContent } from '../features/empty-state.js';
import { syncTeamsToPod } from '../sync/sync-helpers.js';

// TODO: connectWebSocket and renderTimeline are in app.js — passed via
// setTeamBuilderCallbacks to avoid circular dependency
let _connectWebSocket = null;
let _renderTimeline = null;

export function setTeamBuilderCallbacks({ connectWebSocket, renderTimeline }) {
  _connectWebSocket = connectWebSocket;
  _renderTimeline = renderTimeline;
}

export function setupTeamBuilder() {
}

export function openTeamBuilder(startStep = 0, title) {
  const configStore = document.getElementById('config');
  if (startStep !== undefined) configStore.setStep(startStep);

  const dlg = getDlg();
  dlg.openTemplate('tpl-team-builder', {
    title: title || (startStep === 0 ? 'Manage Teams' : 'Team Builder'),
    id: 'team-dialog',
    onOpen: () => {
      wireTeamBuilderEvents();
      renderTeamStep();
    },
  });
}

export function wireTeamBuilderEvents() {
  const configStore = document.getElementById('config');

  // Step navigation
  dlgQuery('#team-prev')?.addEventListener('click', () => {
    const s = configStore.state;
    if (s.step > 0) { configStore.setStep(s.step - 1); renderTeamStep(); }
  });

  dlgQuery('#team-next')?.addEventListener('click', () => {
    const s = configStore.state;
    if (s.step === 1) {
      if (!configStore.validate(1)) { renderTeamStep(); return; }
      configStore.setStep(2);
    } else if (s.step === 2) {
      if (!configStore.validate(2)) { renderTeamStep(); return; }
      configStore.setStep(3);
    } else if (s.step === 3) {
      handleTeamSave();
      return;
    }
    renderTeamStep();
  });

  // Step indicator clicks
  const stepsEl = dlgQuery('#team-steps');
  stepsEl?.querySelectorAll('.step').forEach(el => {
    el.addEventListener('click', () => {
      const step = parseInt(el.dataset.step);
      configStore.setStep(step);
      renderTeamStep();
    });
  });
}

export function renderTeamStep() {
  const dlg = getDlg();
  const configStore = document.getElementById('config');
  const body = dlg.bodyEl?.querySelector('#team-dialog-body');
  if (!body) return;
  const s = configStore.state;

  const stepsEl = dlg.headerExtra.querySelector('#team-steps');
  const prevBtn = dlg.footerEl.querySelector('#team-prev');
  const nextBtn = dlg.footerEl.querySelector('#team-next');

  // Step 0: Team management list
  if (s.step === 0) {
    if (stepsEl) stepsEl.style.display = 'none';
    if (prevBtn) prevBtn.style.display = 'none';
    if (nextBtn) nextBtn.style.display = 'none';
    dlg.dialogTitle = 'Manage Teams';
    renderTeamList(body);
    return;
  }

  if (stepsEl) stepsEl.style.display = '';
  dlg.dialogTitle = 'Team Builder';

  // Update step indicators
  stepsEl?.querySelectorAll('.step').forEach(el => {
    const step = parseInt(el.dataset.step);
    el.classList.toggle('active', step === s.step);
    el.classList.toggle('complete', step < s.step);
  });

  // Update footer buttons
  if (prevBtn) {
    prevBtn.style.display = '';
    prevBtn.textContent = s.step === 1 ? '← Teams' : 'Back';
  }
  if (nextBtn) {
    nextBtn.style.display = '';
    nextBtn.textContent = s.step === 3 ? 'Save & Launch' : 'Next';
  }

  if (s.step === 1) renderStep1(body, s);
  else if (s.step === 2) renderStep2(body, s);
  else if (s.step === 3) renderStep3(body, s);
}

function handleImportFile(file, errorEl) {
  if (!file.name.endsWith('.json') && file.type !== 'application/json') {
    errorEl.textContent = 'Please select a JSON file';
    errorEl.style.display = '';
    return;
  }

  const reader = new FileReader();
  reader.onload = () => {
    try {
      const json = JSON.parse(reader.result);
      // Basic validation
      if (!json.session) {
        errorEl.textContent = 'Invalid config: missing "session" field';
        errorEl.style.display = '';
        return;
      }
      if (!json.agents || !Array.isArray(json.agents) || json.agents.length === 0) {
        errorEl.textContent = 'Invalid config: missing or empty "agents" array';
        errorEl.style.display = '';
        return;
      }

      const configStore = document.getElementById('config');
      configStore.fromJSON(json);
      // fromJSON sets step to 2 — re-render to show agents
      renderTeamStep();
    } catch (e) {
      errorEl.textContent = `Failed to parse JSON: ${e.message}`;
      errorEl.style.display = '';
    }
  };
  reader.onerror = () => {
    errorEl.textContent = 'Failed to read file';
    errorEl.style.display = '';
  };
  reader.readAsText(file);
}

export function renderTeamList(body) {
  const createNewBtn = h('button', { id: 'team-create-new', class: 'team-btn primary' }, '+ New Team');
  const listItems = h('div', { id: 'team-list-items', class: 'team-list-items' },
    h('p', { class: 'import-hint' }, 'Loading teams...')
  );

  replaceContent(body,
    h('div', { class: 'team-list-view' },
      h('div', { class: 'team-list-header' },
        h('p', null, 'Your saved team configurations.'),
        createNewBtn
      ),
      listItems
    )
  );

  createNewBtn.addEventListener('click', () => {
    const configStore = document.getElementById('config');
    configStore.setState({ step: 1, teamName: '', agents: [], errors: {}, editingSession: null, enabledMcpServers: [] });
    renderTeamStep();
  });

  fetch('/api/teams').then(r => r.ok ? r.json() : { teams: [] }).then(data => {
    const list = body.querySelector('#team-list-items');
    if (!data.teams?.length) {
      replaceContent(list, h('p', { class: 'import-hint' }, 'No saved teams yet. Click "+ New Team" to create one.'));
      return;
    }

    const teamCards = data.teams.map(t => {
      const agentCount = t.config?.agents?.length || 0;
      const model = t.config?.model || '';
      const updated = t.updated_at ? new Date(t.updated_at).toLocaleDateString() : '';
      let teamCtx = t._context || 'any';
      if (teamCtx === 'any') {
        for (const cfg of Object.values(t.config?.mcp_servers || {})) {
          if (classifyMcpContext(cfg) === 'local') { teamCtx = 'local'; break; }
        }
      }
      const compatible = isContextCompatible(teamCtx);

      const nameChildren = [t.name];
      if (teamCtx && teamCtx !== 'any') {
        nameChildren.push(text(' '));
        nameChildren.push(h('span', { class: `context-badge ${teamCtx}` }, teamCtx));
      }

      const metaParts = `${agentCount} agent${agentCount !== 1 ? 's' : ''}${model ? ' · ' + model : ''}${updated ? ' · ' + updated : ''}`;

      return h('div', { class: `team-list-card ${compatible ? '' : 'context-incompatible'}`, 'data-team': t.name },
        h('div', { class: 'team-list-info' },
          h('div', { class: 'team-list-name' }, ...nameChildren),
          h('div', { class: 'team-list-meta' }, metaParts)
        ),
        h('div', { class: 'team-list-actions' },
          h('button', { class: 'team-list-action team-action-launch', 'data-team': t.name, title: 'Launch session' }, 'Launch'),
          h('button', { class: 'team-list-action team-action-edit', 'data-team': t.name, title: 'Edit team' }, 'Edit'),
          h('button', { class: 'team-list-action team-action-json', 'data-team': t.name, title: 'View JSON' }, 'JSON'),
          h('button', { class: 'team-list-action team-action-delete', 'data-team': t.name, title: 'Delete team' }, 'Delete'),
        )
      );
    });

    replaceContent(list, ...teamCards);

    // Launch
    list.querySelectorAll('.team-action-launch').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.team;
        const card = btn.closest('.team-list-card');

        // Show inline session name form
        const existing = card.querySelector('.launch-session-form');
        if (existing) { existing.remove(); return; }

        const defaultSessionName = generateSessionName(name);
        const input = h('input', { type: 'text', class: 'launch-session-input', value: defaultSessionName, style: 'flex:1;padding:0.25rem 0.5rem;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary);color:var(--text-primary)' });
        const confirmBtn = h('button', { class: 'team-list-action launch-confirm-btn' }, 'Go');
        const form = h('div', { class: 'launch-session-form', style: 'display:flex;gap:0.5rem;align-items:center;margin-top:0.5rem;padding:0.5rem 0' },
          h('label', { style: 'font-size:0.85rem;white-space:nowrap' }, 'Session Name:'),
          input,
          confirmBtn
        );
        card.appendChild(form);
        input.select();

        confirmBtn.addEventListener('click', async () => {
          const sessionName = input.value.trim() || defaultSessionName;
          btn.textContent = 'Launching...';
          btn.disabled = true;
          form.querySelectorAll('button, input').forEach(el => { el.disabled = true; });
          try {
            const resp = await fetch(`/api/teams/${encodeURIComponent(name)}`);
            if (!resp.ok) throw new Error('Team not found');
            const team = await resp.json();
            const config = { ...team.config, session: team.config.session || name };
            if (config.mcp_servers) {
              config.mcp_servers = injectMcpTokens(config.mcp_servers);
            }
            const launchResp = await fetch('/api/sessions/launch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ config, session_name: sessionName }),
            });
            const result = await launchResp.json();
            if (result.ok) {
              getDlg().close();
              const projectStore = document.getElementById('projects');
              projectStore.setActive(result.session);
              await projectStore.refresh();
              const agentStore = document.getElementById('agents');
              const msgStore = document.getElementById('messages');
              if (agentStore) { agentStore._isInternalChange = true; agentStore.state.agents = {}; agentStore._isInternalChange = false; document.getElementById('agent-deck')?.replaceChildren(); }
              if (msgStore) { msgStore._isInternalChange = true; msgStore.state.messages = []; msgStore._isInternalChange = false; _renderTimeline?.(); }
              const busUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?session=${encodeURIComponent(result.session)}`;
              restoreMainContent();
              _connectWebSocket?.(busUrl);
              startMetricsPolling();
            } else {
              btn.textContent = result.error || 'Failed';
              btn.disabled = false;
              setTimeout(() => { btn.textContent = 'Launch'; }, 3000);
            }
          } catch (e) {
            btn.textContent = e.message;
            btn.disabled = false;
            setTimeout(() => { btn.textContent = 'Launch'; }, 3000);
          }
        });
      });
    });

    // Edit — load into builder
    list.querySelectorAll('.team-action-edit').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.team;
        const resp = await fetch(`/api/teams/${encodeURIComponent(name)}`);
        if (resp.ok) {
          const team = await resp.json();
          const configStore = document.getElementById('config');
          configStore.fromJSON(team.config);
          configStore.setState({ editingSession: null });
          configStore.setStep(1);
          renderTeamStep();
        }
      });
    });

    // View JSON
    list.querySelectorAll('.team-action-json').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.team;
        const resp = await fetch(`/api/teams/${encodeURIComponent(name)}`);
        if (resp.ok) {
          const team = await resp.json();
          showDialog(`Team: ${name}`, JSON.stringify(team.config, null, 2));
        }
      });
    });

    // Delete
    list.querySelectorAll('.team-action-delete').forEach(btn => {
      btn.addEventListener('click', async () => {
        const name = btn.dataset.team;
        if (!confirm(`Delete team "${name}"?`)) return;
        const resp = await fetch(`/api/teams/${encodeURIComponent(name)}`, { method: 'DELETE' });
        if (resp.ok) {
          btn.closest('.team-list-card').remove();
          const remaining = list.querySelectorAll('.team-list-card');
          if (remaining.length === 0) {
            replaceContent(list, h('p', { class: 'import-hint' }, 'No saved teams yet. Click "+ New Team" to create one.'));
          }
        }
      });
    });
  }).catch(() => {
    const list = body.querySelector('#team-list-items');
    if (list) replaceContent(list, h('p', { class: 'import-hint' }, 'Login to see saved teams.'));
  });
}

export function renderStep1(body, s) {
  const available = getAvailableModels();

  // Auto-correct the default model if it's not in the available list
  if (available.length > 0) {
    const ids = available.map(m => m.model_id || m.id);
    if (!ids.includes(s.model)) {
      document.getElementById('config').setModel(ids[0]);
      s = { ...s, model: ids[0] };
    }
  }

  const configState = document.getElementById('config').state;

  // Model field
  let modelFieldContent;
  if (available.length > 0) {
    const modelOpts = available.map(m => {
      const id = m.model_id || m.id;
      return h('option', { value: id, selected: id === s.model }, formatModelOption(m));
    });
    modelFieldContent = h('select', { id: 'cfg-model' }, ...modelOpts);
  } else {
    modelFieldContent = h('div', { class: 'model-gate-msg' },
      'No models configured. ',
      h('button', { type: 'button', class: 'model-gate-btn', id: 'step1-setup-models' }, 'Set up models first')
    );
  }

  // Team name field
  const teamNameChildren = [
    h('label', null, 'Team Name'),
    h('input', { type: 'text', id: 'cfg-session', value: s.teamName, placeholder: 'my-team' }),
  ];
  if (s.errors.teamName) {
    teamNameChildren.push(h('div', { class: 'error' }, s.errors.teamName));
  }

  // Env textarea
  const envTextarea = h('textarea', { id: 'cfg-session-env', rows: '2', placeholder: 'GITLAB_TOKEN=glpat-xxx\nAPI_SECRET=abc123' });
  envTextarea.value = Object.entries(configState.sessionEnv || {}).map(([k,v]) => k+'='+v).join('\n');

  // Runtime tool checkboxes
  const runtimeToolLabels = ['python3', 'nodejs', 'curl', 'wget', 'jq'].map(t => {
    const isChecked = (configState.runtimeTools || []).includes(t);
    return h('label', { style: 'display:flex;align-items:center;gap:0.25rem;cursor:pointer;padding:0.25rem 0.5rem;border:1px solid var(--border);border-radius:4px;background:var(--bg-secondary)' },
      h('input', { type: 'checkbox', class: 'runtime-tool-cb', value: t, checked: isChecked }),
      t
    );
  });

  // Import file input
  const importFileInput = h('input', { type: 'file', id: 'import-file', accept: '.json,application/json' });
  importFileInput.hidden = true;

  replaceContent(body,
    h('div', { class: 'team-explanation' },
      h('p', null, h('strong', null, 'Create an Agent Team')),
      h('p', null, 'Configure a team of AI agents that will run as isolated V8 workers in the cloud. Each agent gets its own execution context with crash containment. You can mix models across agents in the same team.')
    ),
    h('div', { class: 'team-field' }, ...teamNameChildren),
    h('div', { class: 'team-field' },
      h('label', null, 'Default Model'),
      modelFieldContent
    ),
    h('div', { class: 'team-field' },
      h('label', null, 'Collaboration Pattern'),
      h('select', { id: 'cfg-pattern' },
        h('option', { value: 'sequential', selected: configState.pattern === 'sequential' }, 'Sequential (admin / worker / reviewer)'),
        h('option', { value: 'mixture', selected: configState.pattern === 'mixture' }, 'Mixture (parallel specialists + synthesizer)'),
        h('option', { value: 'deliberation', selected: configState.pattern === 'deliberation' }, 'Deliberation (reflector / worker loop)'),
        h('option', { value: 'distillation', selected: configState.pattern === 'distillation' }, 'Distillation (expert plans, learner executes)'),
      ),
      h('div', { class: 'field-hint' }, 'How agents collaborate. Mixture and Deliberation patterns are optimized for small models.'),
      h('div', { id: 'deliberation-rounds-field', class: 'team-field', style: configState.pattern === 'deliberation' ? 'margin-top:0.5rem' : 'display:none' },
        h('label', null, 'Max Deliberation Rounds'),
        h('input', { type: 'number', id: 'cfg-delib-rounds', value: configState.maxDeliberationRounds ?? 3, min: 1, max: 10, style: 'width:4rem' }),
      ),
    ),
    h('div', { class: 'team-divider' }, h('span', null, 'or')),
    h('div', { class: 'team-field', style: 'display:flex;gap:0.5rem' },
      h('div', { style: 'flex:1' },
        h('label', null, 'Import from file'),
        h('div', { class: 'import-zone', id: 'import-zone' },
          importFileInput,
          h('p', { class: 'import-label' },
            'Drop a ',
            h('code', null, 'porter.json'),
            ' or ',
            h('button', { type: 'button', class: 'import-browse', id: 'import-browse' }, 'browse')
          )
        )
      ),
      h('div', { style: 'flex:1' },
        h('label', null, 'Load Saved Team'),
        h('div', { id: 'saved-teams-list', class: 'saved-teams-list' }, 'Loading...')
      )
    ),
    h('div', { id: 'import-error', class: 'error', style: 'display:none' }),
    h('div', { class: 'team-field', style: 'margin-top:1rem' },
      h('label', null, 'MCP Servers'),
      h('div', { id: 'mcp-servers-list', class: 'mcp-servers-list' }),
      h('div', { class: 'field-hint' }, 'Enable MCP servers for this team. Agents can then select tools from enabled servers.')
    ),
    h('div', { class: 'team-field', style: 'margin-top:1rem' },
      h('label', null, 'Environment Variables (KEY=VALUE, one per line)'),
      envTextarea,
      h('div', { class: 'field-hint' }, 'Available to agents via bash/git commands. Secrets are NOT synced to Pod.')
    ),
    h('div', { class: 'team-field', style: 'margin-top:1rem' },
      h('label', { style: 'display:flex;align-items:center;gap:0.5rem;cursor:pointer' },
        h('input', { type: 'checkbox', id: 'cfg-sandbox', checked: !!configState.sandbox }),
        'Sandbox isolation'
      ),
      h('div', { class: 'field-hint' }, 'Run agent commands inside a container with only the workspace directory mounted. Prevents access to host files (~/.ssh, etc.). Requires podman or docker.')
    ),
    h('div', { class: 'team-field', style: 'margin-top:1rem' },
      h('label', null, 'Runtime Tools'),
      h('div', { id: 'cfg-runtime-tools', style: 'display:flex;flex-wrap:wrap;gap:0.5rem;margin-top:0.25rem' }, ...runtimeToolLabels),
      h('div', { class: 'field-hint' }, 'Additional tools installed in agent pods or sandbox containers. All from Red Hat UBI images.')
    )
  );

  // Fetch saved teams
  fetch('/api/teams').then(r => r.ok ? r.json() : { teams: [] }).then(data => {
    const list = body.querySelector('#saved-teams-list');
    if (!data.teams?.length) {
      replaceContent(list, h('p', { class: 'import-hint' }, 'No saved teams yet'));
      return;
    }
    const btns = data.teams.map(t => {
      const btn = h('button', { class: 'saved-team-btn', 'data-team': t.name },
        t.name, ' ',
        h('span', { class: 'saved-team-meta' }, `${t.config?.agents?.length || '?'} agents`)
      );
      btn.addEventListener('click', async () => {
        const name = btn.dataset.team;
        const resp = await fetch(`/api/teams/${encodeURIComponent(name)}`);
        if (resp.ok) {
          const team = await resp.json();
          const configStore = document.getElementById('config');
          configStore.fromJSON(team.config);
          configStore.setStep(1);
          renderTeamStep();
        }
      });
      return btn;
    });
    replaceContent(list, ...btns);
  }).catch(() => {
    const list = body.querySelector('#saved-teams-list');
    if (list) replaceContent(list, h('p', { class: 'import-hint' }, 'Login to see saved teams'));
  });

  // Render MCP server checkbox list
  renderMcpList(body, document.getElementById('config').state.mcpServers);

  body.querySelector('#cfg-session').addEventListener('input', e => {
    document.getElementById('config').setTeamName(e.target.value);
  });
  body.querySelector('#cfg-session-env')?.addEventListener('input', e => {
    const env = {};
    for (const line of e.target.value.split('\n')) {
      const eq = line.indexOf('=');
      if (eq > 0) env[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
    }
    document.getElementById('config').setState({ sessionEnv: env });
  });
  body.querySelector('#cfg-sandbox')?.addEventListener('change', e => {
    document.getElementById('config').setState({ sandbox: e.target.checked });
  });
  body.querySelectorAll('.runtime-tool-cb').forEach(cb => {
    cb.addEventListener('change', () => {
      const selected = [...body.querySelectorAll('.runtime-tool-cb:checked')].map(el => el.value);
      document.getElementById('config').setState({ runtimeTools: selected });
    });
  });
  body.querySelector('#cfg-model')?.addEventListener('change', e => {
    document.getElementById('config').setModel(e.target.value);
  });
  body.querySelector('#cfg-pattern')?.addEventListener('change', e => {
    document.getElementById('config').setPattern(e.target.value);
    const roundsField = body.querySelector('#deliberation-rounds-field');
    if (roundsField) roundsField.style.display = e.target.value === 'deliberation' ? '' : 'none';
  });
  body.querySelector('#cfg-delib-rounds')?.addEventListener('input', e => {
    document.getElementById('config').setState({ maxDeliberationRounds: parseInt(e.target.value) || 3 });
  });
  body.querySelector('#step1-setup-models')?.addEventListener('click', () => {
    renderModelSetup(true);
    // Re-render Step 1 when overlay model dialog closes so the dropdown updates
    getOverlayDlg().addEventListener('porter-dialog-close', () => {
      renderTeamStep();
    }, { once: true });
  });

  // Import from JSON file
  const importZone = body.querySelector('#import-zone');
  const importFile = body.querySelector('#import-file');
  const importError = body.querySelector('#import-error');
  const importBrowse = body.querySelector('#import-browse');

  importBrowse.addEventListener('click', () => importFile.click());

  importFile.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) handleImportFile(file, importError);
  });

  // Drag and drop
  importZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    importZone.classList.add('drag-over');
  });
  importZone.addEventListener('dragleave', () => {
    importZone.classList.remove('drag-over');
  });
  importZone.addEventListener('drop', (e) => {
    e.preventDefault();
    importZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) handleImportFile(file, importError);
  });
}

export function renderStep2(body, s) {
  const configStore = document.getElementById('config');
  const pattern = s.pattern || 'sequential';

  const bodyChildren = [
    h('div', { class: 'team-explanation' },
      h('p', null, h('strong', null, 'Define Your Agents')),
      h('p', null, 'Each agent is an AI assistant with a specific role, set of tools, and communication channels. Agents run independently and coordinate through the message bus.'),
    ),
  ];

  if (s.errors.agents) {
    bodyChildren.push(h('div', { class: 'error', style: 'margin-bottom:0.75rem' }, s.errors.agents));
  }

  // For sequential pattern, show the original flat list since it has flexible role assignment
  if (pattern === 'sequential') {
    bodyChildren[0] = h('div', { class: 'team-explanation' },
      h('p', null, h('strong', null, 'Define Your Agents')),
      h('p', null, 'Each agent is an AI assistant with a specific role, set of tools, and communication channels. Agents run independently and coordinate through the message bus.'),
      h('ul', null,
        h('li', null, h('strong', null, 'Admin'), ' — Plans and coordinates work. Reads from log channel, sends tasks.'),
        h('li', null, h('strong', null, 'Worker'), ' — Executes tasks. Has full tool access including file editing, bash, and git.'),
        h('li', null, h('strong', null, 'Reviewer'), ' — Reviews completed work. Monitors the log channel for quality.'),
      )
    );

    const agentCards = s.agents.map((a, i) => renderAgentCard(a, i));

    const addAgentBtn = h('button', { class: 'add-agent-btn', id: 'add-agent-btn', title: 'New agent' }, '+ New');
    const addFromBtn = h('button', { class: 'add-agent-btn add-agent-from', id: 'add-agent-from-btn', title: 'Create from saved agent' }, 'From Saved...');

    bodyChildren.push(
      h('div', { class: 'agent-deck' },
        ...agentCards,
        h('div', { class: 'add-agent-actions' }, addAgentBtn, addFromBtn)
      )
    );

    replaceContent(body, ...bodyChildren);

    addAgentBtn.addEventListener('click', () => {
      const isFirst = configStore.state.agents.length === 0;
      openAgentEditor(configStore.createDefaultAgent(isFirst));
    });

    addFromBtn.addEventListener('click', () => {
      showSavedAgentPicker();
    });
    return;
  }

  // Non-sequential patterns: render role sections from pattern definition
  renderPatternLayout(body, bodyChildren, s, pattern);
}

function renderAgentCard(a, i) {
  const editBtn = h('button', null, 'Edit');
  const removeBtn = h('button', null, 'Remove');
  editBtn.addEventListener('click', () => window.editAgentAt(i));
  removeBtn.addEventListener('click', () => window.removeAgentAt(i));

  return h('div', { class: 'agent-preview', 'data-role': a.role },
    h('div', { class: 'agent-name' }, a.name),
    h('div', { class: 'agent-meta' }, `${a.role} · ${a.tools.length} tools`),
    h('div', { class: 'agent-meta' }, a.channels.join(', ') || 'no channels'),
    h('div', { class: 'agent-actions' }, editBtn, removeBtn)
  );
}

/**
 * Fetch pattern definition from the API and render role sections.
 */
async function renderPatternLayout(body, bodyChildren, s, patternId) {
  let patternDef = null;
  try {
    const resp = await fetch('/api/patterns');
    if (resp.ok) {
      const data = await resp.json();
      patternDef = (data.patterns || []).find(p => p.id === patternId);
    }
  } catch { /* fallback to flat list */ }

  if (!patternDef) {
    // Fallback: render flat list
    const agentCards = s.agents.map((a, i) => renderAgentCard(a, i));
    const addBtn = h('button', { class: 'add-agent-btn' }, '+ New');
    bodyChildren.push(h('div', { class: 'agent-deck' }, ...agentCards, addBtn));
    replaceContent(body, ...bodyChildren);
    addBtn.addEventListener('click', () => {
      const configStore = document.getElementById('config');
      openAgentEditor(configStore.createDefaultAgent(configStore.state.agents.length === 0));
    });
    return;
  }

  const configStore = document.getElementById('config');
  const roleSections = [];

  // Show flow diagram at the top for non-sequential patterns
  if (patternDef.bus_flow) {
    roleSections.push(
      h('div', { style: 'margin-bottom:0.5rem' },
        renderBusFlow(patternDef.bus_flow, { compact: false }),
      )
    );
  }

  patternDef.roles.forEach((role, roleIdx) => {
    // Show flow arrow between role sections
    if (roleIdx > 0) {
      roleSections.push(h('div', { class: 'pattern-flow-arrow' }, '↓'));
    }

    const roleAgents = s.agents
      .map((a, i) => ({ agent: a, idx: i }))
      .filter(({ agent }) => agent.role === role.id);

    const agentCards = roleAgents.map(({ agent, idx }) => renderAgentCard(agent, idx));

    // Requirement label
    let reqText;
    if (role.min === role.max) {
      reqText = `Exactly ${role.min} required`;
    } else if (role.min === 0) {
      reqText = `Up to ${role.max} (optional)`;
    } else {
      reqText = `${role.min}-${role.max} required`;
    }

    const addBtn = h('button', { class: 'add-agent-btn', style: 'margin-top:0.5rem' }, `+ Add ${role.name}`);
    addBtn.addEventListener('click', () => {
      openAgentEditor(configStore.createDefaultAgent(false, role.id));
    });

    // Show add button only if we haven't hit max
    const canAdd = roleAgents.length < role.max;

    const section = h('div', { class: 'pattern-role-section', 'data-role-id': role.id },
      h('div', { class: 'pattern-role-header' },
        h('strong', null, role.name),
        h('span', { style: 'font-size:0.75rem;color:var(--text-dim);margin-left:0.5rem' }, reqText),
      ),
      h('div', { style: 'font-size:0.8rem;color:var(--text-secondary);margin-bottom:0.5rem' }, role.description),
      ...agentCards,
      canAdd ? addBtn : null,
    );

    roleSections.push(section);
  });

  // Validation section
  const validationErrors = validateComposition(patternDef, s.agents);
  if (validationErrors.length > 0) {
    const errorEls = validationErrors.map(e =>
      h('div', { style: 'font-size:0.8rem;color:var(--status-error);padding:0.25rem 0' },
        `${e.roleName}: ${e.message}`)
    );
    roleSections.push(
      h('div', { class: 'pattern-validation', style: 'margin-top:0.75rem;padding:0.5rem;border:1px solid var(--status-error);border-radius:4px;background:rgba(184,115,51,0.1)' },
        h('strong', { style: 'font-size:0.85rem;color:var(--status-error)' }, 'Composition Issues'),
        ...errorEls,
      )
    );
  }

  // Add "From Saved..." button at the bottom
  const addFromBtn = h('button', { class: 'add-agent-btn add-agent-from', style: 'margin-top:0.75rem' }, 'From Saved...');
  addFromBtn.addEventListener('click', () => showSavedAgentPicker());

  bodyChildren.push(h('div', { class: 'pattern-layout' }, ...roleSections, addFromBtn));
  replaceContent(body, ...bodyChildren);
}

/**
 * Client-side composition validation (mirrors validateTeamComposition from pattern_registry.ts).
 */
function validateComposition(patternDef, agents) {
  const errors = [];
  for (const role of patternDef.roles) {
    const count = agents.filter(a => a.role === role.id).length;
    if (count < role.min) {
      errors.push({
        roleId: role.id,
        roleName: role.name,
        message: role.min === 1
          ? `Requires a ${role.name}`
          : `Requires at least ${role.min} ${role.name}s (have ${count})`,
      });
    }
    if (count > role.max) {
      errors.push({
        roleId: role.id,
        roleName: role.name,
        message: `Maximum ${role.max} ${role.name}${role.max > 1 ? 's' : ''} allowed (have ${count})`,
      });
    }
  }
  return errors;
}

export function renderStep3(body, s) {
  const configStore = document.getElementById('config');
  const json = configStore.toJSON();

  const copyBtn = h('button', { id: 'json-copy' }, 'Copy');
  const downloadBtn = h('button', { id: 'json-download' }, 'Download');
  const saveTeamBtn = h('button', { id: 'json-save-team', class: 'team-save-btn' }, 'Save Team');

  replaceContent(body,
    h('div', { class: 'team-explanation' },
      h('p', null, h('strong', null, 'Review & Save')),
      h('p', null, 'This is the complete team configuration that will be saved. When launched, the orchestrator will:'),
      h('ul', null,
        h('li', null, 'Create a V8 isolate worker for each agent'),
        h('li', null, 'Connect all agents to the message bus for coordination'),
        h('li', null, 'Provide each agent with its configured tools and system prompt'),
        h('li', null, 'Stream all activity to this dashboard in real time'),
      )
    ),
    h('div', { class: 'json-actions' }, copyBtn, downloadBtn, saveTeamBtn),
    h('pre', { class: 'json-preview' }, json)
  );

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(json);
  });
  downloadBtn.addEventListener('click', () => {
    const blob = new Blob([json], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'porter.json';
    a.click();
  });
  saveTeamBtn.addEventListener('click', async () => {
    const btn = saveTeamBtn;
    const config = JSON.parse(json);
    const teamName = config.session;
    console.log('[porter] Save Team clicked, name:', teamName);
    try {
      btn.textContent = 'Saving...';
      const resp = await fetch('/api/teams', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: teamName, config }),
      });
      const data = await resp.json().catch(() => ({}));
      console.log('[porter] Save Team response:', resp.status, data);
      if (resp.ok) {
        btn.textContent = 'Saved';
        setTimeout(() => { btn.textContent = 'Save Team'; }, 2000);
        syncTeamsToPod();
        updateSetupBar();
        if (document.querySelector('.empty-state-prompt')) renderEmptyState();
      } else {
        console.error('[porter] Save Team failed:', resp.status, data);
        btn.textContent = data.error || 'Save failed';
        setTimeout(() => { btn.textContent = 'Save Team'; }, 3000);
      }
    } catch (e) {
      console.error('[porter] Save Team error:', e);
      btn.textContent = 'Save failed';
      setTimeout(() => { btn.textContent = 'Save Team'; }, 2000);
    }
  });
}

export async function handleTeamSave() {
  console.log('[porter] handleTeamSave triggered');
  const configStore = document.getElementById('config');
  if (!configStore.validate(3)) { renderTeamStep(); return; }

  configStore.setState({ saving: true });
  const config = JSON.parse(configStore.toJSON());

  // Save team to server and Pod BEFORE launching
  const teamName = configStore.state.teamName;
  console.log('[porter] Saving team:', teamName);
  try {
    const saveResp = await fetch('/api/teams', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: teamName, config }),
    });
    if (saveResp.ok) syncTeamsToPod();
  } catch (e) { console.error('[porter] Team save failed:', e); }
  const editingSession = configStore.state.editingSession;

  try {
    // If editing an existing session, use the edit endpoint (stop-snapshot-restart)
    const url = editingSession
      ? `/api/sessions/${encodeURIComponent(editingSession)}/edit`
      : '/api/sessions/launch';

    const payload = { config };
    if (!editingSession) {
      payload.session_name = generateSessionName(config.session);
    }

    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const result = await resp.json();

    if (resp.status === 501) {
      // Standalone mode — fall back to config file save
      await handleTeamSaveFallback(config);
      return;
    }

    if (result.ok) {
      configStore.setState({ saving: false, editingSession: null });
      getDlg().close();

      // Auto-switch to the new session
      const projectStore = document.getElementById('projects');
      projectStore.setActive(result.session);

      // Build WebSocket URL for the new session's bus
      // In serve mode, the /ws proxy always routes to the current session
      // We need to reconnect to pick up the new session
      await projectStore.refresh();

      // Restore the main content (agent deck + timeline) before clearing
      // state — renderTimeline() crashes if called while the empty-state
      // prompt is still in <main> because #timeline doesn't exist.
      restoreMainContent();

      // Clear current state and reconnect
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
        _renderTimeline?.();
      }

      // Save team config to server and Pod
      try {
        await fetch('/api/teams', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: config.session, config }),
        });
      } catch { /* team save is best-effort */ }

      syncTeamsToPod();

      const busUrl = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/ws?session=${encodeURIComponent(result.session)}`;
      _connectWebSocket?.(busUrl);
      startMetricsPolling();
    } else {
      configStore.setState({ saving: false, errors: { save: result.error } });
      renderTeamStep();
    }
  } catch (e) {
    configStore.setState({ saving: false, errors: { save: e.message } });
    renderTeamStep();
  }
}

// Fallback for standalone mode (no session manager)
export async function handleTeamSaveFallback(config) {
  const configStore = document.getElementById('config');
  try {
    const resp = await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ config }),
    });
    const result = await resp.json();
    if (result.ok) {
      configStore.setState({ saving: false });
      if (result.path && result.path.startsWith('/tmp')) {
        showDialog('Team Configuration Saved',
          `Configuration saved to ${result.path} inside the container.\n\n` +
          `To apply this configuration, update the ConfigMap:\n\n` +
          `  oc create configmap porter-<session>-config \\\n` +
          `    --from-literal=porter.json='...' \\\n` +
          `    -n <namespace> --dry-run=client -o yaml | oc apply -f -\n\n` +
          `Then restart the orchestrator:\n` +
          `  oc rollout restart deployment/porter-<session>-orchestrator`
        );
      }
      getDlg().close();
    } else {
      configStore.setState({ saving: false, errors: { save: result.error } });
      renderTeamStep();
    }
  } catch (e) {
    configStore.setState({ saving: false, errors: { save: e.message } });
    renderTeamStep();
  }
}

// Global helpers for inline onclick handlers
window.editAgentAt = function(idx) {
  const configStore = document.getElementById('config');
  openAgentEditor(configStore.state.agents[idx], idx);
};
window.removeAgentAt = function(idx) {
  const configStore = document.getElementById('config');
  configStore.removeAgent(idx);
  renderTeamStep();
};
