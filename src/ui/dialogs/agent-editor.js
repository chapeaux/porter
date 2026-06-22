/**
 * Agent editor dialog — create/edit individual agents.
 */

import { h, replaceContent } from '../dom.js';
import { getDlg, getOverlayDlg } from './dialog-helpers.js';
import {
  ALL_TOOLS,
  ROLE_TOOL_DEFAULTS, ROLE_CHANNEL_DEFAULTS, ROLE_SECTION_DEFAULTS,
  getDefaultSections, parsePromptSections,
  getAvailableModels, formatModelOption,
} from '../stores/config-store.js';
import { updateSetupBar } from '../features/flipboard-setup.js';
import { renderEmptyState } from '../features/empty-state.js';
import { syncAgentsToPod } from '../sync/sync-helpers.js';
// TODO: renderTeamStep is in team-builder.js — imported here to avoid circular dep
// by re-exporting from a shared location or passing as callback
import { renderTeamStep } from './team-builder.js';

export function renderPromptSections(container, sections) {
  const sectionEls = sections.map((s, i) => {
    const titleSpan = document.createElement('span');
    titleSpan.className = 'prompt-section-title';
    titleSpan.contentEditable = 'true';
    titleSpan.textContent = s.title;

    const revertBtn = h('button', { type: 'button', class: 'prompt-section-revert', title: 'Revert to default', disabled: !(s.default || ['job','comm','memory','processing'].includes(s.id)) }, '↺');
    const removeBtn = h('button', { type: 'button', class: 'prompt-section-remove', title: 'Remove section', disabled: ['job','comm','memory','processing'].includes(s.id) }, '✕');
    const toggleBtn = h('button', { type: 'button', class: 'prompt-section-toggle' }, '▾');

    const textarea = h('textarea', { class: 'prompt-section-content' });
    textarea.value = s.content;

    return h('div', { class: 'prompt-section', 'data-section-id': s.id, 'data-idx': String(i) },
      h('div', { class: 'prompt-section-header' }, titleSpan, revertBtn, removeBtn, toggleBtn),
      textarea
    );
  });

  replaceContent(container, ...sectionEls);
  wirePromptSectionEvents(container.closest('.team-field') || container.parentElement);
}

export function wirePromptSectionEvents(scope) {
  scope.querySelectorAll('.prompt-section-toggle').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.prompt-section');
      section.classList.toggle('collapsed');
      btn.textContent = section.classList.contains('collapsed') ? '▸' : '▾';
    });
  });
  scope.querySelectorAll('.prompt-section-revert').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.prompt-section');
      const id = section.dataset.sectionId;
      const role = scope.querySelector('#agent-role-value')?.value || 'worker';
      const defaults = ROLE_SECTION_DEFAULTS[role] || [];
      const def = defaults.find(d => d.id === id);
      if (def) section.querySelector('.prompt-section-content').value = def.content;
    });
  });
  scope.querySelectorAll('.prompt-section-remove').forEach(btn => {
    btn.addEventListener('click', () => {
      const section = btn.closest('.prompt-section');
      if (!['job','comm','memory','processing'].includes(section.dataset.sectionId)) {
        section.remove();
      }
    });
  });
  scope.querySelector('#add-prompt-section')?.addEventListener('click', () => {
    const container = scope.querySelector('#prompt-sections');
    const idx = container.querySelectorAll('.prompt-section').length;
    const id = 'custom-' + Date.now();

    const titleSpan = document.createElement('span');
    titleSpan.className = 'prompt-section-title';
    titleSpan.contentEditable = 'true';
    titleSpan.textContent = 'Custom Section';

    const div = h('div', { class: 'prompt-section', 'data-section-id': id, 'data-idx': String(idx) },
      h('div', { class: 'prompt-section-header' },
        titleSpan,
        h('button', { type: 'button', class: 'prompt-section-revert', title: 'Revert to default', disabled: true }, '↺'),
        h('button', { type: 'button', class: 'prompt-section-remove', title: 'Remove section' }, '✕'),
        h('button', { type: 'button', class: 'prompt-section-toggle' }, '▾'),
      ),
      h('textarea', { class: 'prompt-section-content' })
    );
    container.appendChild(div);
    wirePromptSectionEvents(scope);
  });
}

export function renderAgentForm(agent) {
  const body = getOverlayDlg().bodyEl.querySelector('#agent-dialog-body');

  const toolCheckEls = ALL_TOOLS.map(t =>
    h('label', null, h('input', { type: 'checkbox', value: t, checked: agent.tools.includes(t) }), ' ' + t)
  );

  const available = getAvailableModels();
  const modelOpts = [
    h('option', { value: '' }, 'Use team default'),
    ...available.map(m => {
      const id = m.model_id || m.id;
      return h('option', { value: id, selected: id === (agent.model || '') }, formatModelOption(m));
    }),
  ];

  // MCP tools field
  const configStore = document.getElementById('config');
  const enabledMcp = configStore?.state?.enabledMcpServers || [];
  let mcpToolContent;
  if (enabledMcp.length === 0) {
    mcpToolContent = h('div', { class: 'field-hint' }, 'No MCP servers enabled for this team. Enable servers in the Team step.');
  } else {
    const mcpChecks = enabledMcp.map(name =>
      h('label', null,
        h('input', { type: 'checkbox', class: 'mcp-tool-check', value: name + '.*', checked: (agent.mcpTools || []).includes(name + '.*') }),
        ' ' + name + '.* (all tools)'
      )
    );
    mcpToolContent = h('div', { class: 'tool-grid' }, ...mcpChecks);
  }

  // Prompt sections
  const sections = agent.promptSections || parsePromptSections(agent.systemPrompt, agent.role);
  const promptSectionEls = sections.map((s, i) => {
    const titleSpan = document.createElement('span');
    titleSpan.className = 'prompt-section-title';
    titleSpan.contentEditable = 'true';
    titleSpan.textContent = s.title;

    const textarea = h('textarea', { class: 'prompt-section-content' });
    textarea.value = s.content;

    return h('div', { class: 'prompt-section', 'data-section-id': s.id, 'data-idx': String(i) },
      h('div', { class: 'prompt-section-header' },
        titleSpan,
        h('button', { type: 'button', class: 'prompt-section-revert', title: 'Revert to default', disabled: !(s.default || ['job','comm','memory','processing'].includes(s.id)) }, '↺'),
        h('button', { type: 'button', class: 'prompt-section-remove', title: 'Remove section', disabled: ['job','comm','memory','processing'].includes(s.id) }, '✕'),
        h('button', { type: 'button', class: 'prompt-section-toggle' }, '▾'),
      ),
      textarea
    );
  });

  // File input
  const fileInput = h('input', { type: 'file', id: 'prompt-file-input', accept: '.txt,.md,.py,.sh,.ts,.js,.yaml,.yml,.json,.toml,.cfg,.sql,.go,.rs,.java,.c,.cpp,.rb' });
  fileInput.hidden = true;
  fileInput.multiple = true;

  // Max tokens help table
  const helpRows = [
    ['Model', 'Range', 'Recommended', 'Use Case'],
    ['Granite 3.x/4.0', '1 - 8,192', '4,096 - 8,192', 'Code generation, task execution'],
    ['Mistral 7B', '1 - 32,768', '8,192 - 16,384', 'Long-form analysis'],
    ['Qwen3 14B', '1 - 8,192', '4,096 - 8,192', 'Reasoning, code review'],
    ['GPT-OSS 20B', '1 - 8,192', '4,096 - 8,192', 'General purpose'],
    ['Llama 3.3 70B', '1 - 128,000', '8,192 - 32,768', 'Complex analysis, large outputs'],
    ['Claude', '1 - 8,000', '4,000 - 8,000', 'Planning, coordination'],
    ['Gemini 2.5', '1 - 65,536', '8,192 - 32,768', 'Multi-step reasoning'],
  ];
  const tableRows = helpRows.map((row, ri) => {
    const tag = ri === 0 ? 'th' : 'td';
    return h('tr', null, ...row.map(cell => h(tag, null, cell)));
  });

  // Role display: read-only label when role is assigned by pattern slot
  const roleField = agent.role
    ? h('div', { class: 'team-field' },
        h('label', null, 'Role'),
        h('div', { style: 'display:flex;align-items:center;gap:0.5rem' },
          h('span', { id: 'agent-role-label', style: 'color:var(--accent-gold);font-weight:bold;text-transform:capitalize' }, agent.role),
          h('span', { style: 'font-size:0.75rem;color:var(--text-dim)' }, '(assigned by pattern)'),
        ),
        h('input', { type: 'hidden', id: 'agent-role-value', value: agent.role }),
      )
    : h('div', { class: 'team-field' },
        h('label', null, 'Role'),
        h('div', { style: 'color:var(--text-dim);font-size:0.85rem' }, 'Role will be assigned by pattern slot'),
        h('input', { type: 'hidden', id: 'agent-role-value', value: 'worker' }),
      );

  replaceContent(body,
    h('div', { class: 'team-field' },
      h('label', null, 'Name'),
      h('input', { type: 'text', id: 'agent-name', value: agent.name }),
    ),
    roleField,
    h('div', { class: 'team-field' },
      h('label', null, 'Model (optional override)'),
      h('select', { id: 'agent-model' }, ...modelOpts),
    ),
    h('div', { class: 'team-field' },
      h('label', null, 'Tools'),
      h('div', { class: 'tool-grid', id: 'agent-tools' }, ...toolCheckEls),
    ),
    h('div', { class: 'team-field' },
      h('label', null, 'MCP Tools'),
      mcpToolContent,
      h('input', { type: 'text', id: 'agent-mcp-tools', placeholder: 'Additional: server.specific_tool', value: (agent.mcpTools || []).filter(t => !t.endsWith('.*')).join(', ') }),
    ),
    h('div', { class: 'team-field' },
      h('label', null, 'Channels (comma-separated)'),
      h('input', { type: 'text', id: 'agent-channels', value: agent.channels.join(', ') }),
    ),
    h('div', { class: 'team-field' },
      h('label', { class: 'inline-check' },
        h('input', { type: 'checkbox', id: 'agent-reasoning', checked: !!agent.reasoning }),
        ' Enable reasoning mode'
      ),
      h('div', { class: 'field-hint' },
        'Enables extended thinking via ', h('code', null, 'chat_template_kwargs'), ' for models that support it (Granite 3.2+, Qwen3, GPT-OSS, Llama-3.3-70B).'
      ),
    ),
    h('div', { class: 'team-field' },
      h('label', null, 'System Prompt'),
      h('div', { class: 'prompt-sections', id: 'prompt-sections' }, ...promptSectionEls),
      h('div', { class: 'prompt-section-actions' },
        h('button', { type: 'button', id: 'add-prompt-section', class: 'prompt-upload-btn' }, '+ Add Section'),
        h('button', { type: 'button', id: 'prompt-upload-btn', class: 'prompt-upload-btn' }, 'Upload File'),
        fileInput,
        h('span', { id: 'prompt-file-status', class: 'prompt-file-list' }),
      ),
    ),
    h('div', { class: 'team-field' },
      h('label', null, 'Max Tokens ',
        h('span', { class: 'max-tokens-help-toggle', id: 'max-tokens-toggle', title: 'What is this?' }, '(? help)')
      ),
      h('input', { type: 'number', id: 'agent-max-tokens', value: String(agent.maxTokens) }),
      h('div', { id: 'agent-max-tokens-hint', class: 'field-hint' }),
      h('div', { id: 'max-tokens-help', class: 'max-tokens-help', style: 'display:none' },
        h('p', null, h('strong', null, 'Max Tokens'), ' controls the maximum length of each model response. One token is roughly 3/4 of a word.'),
        h('table', { class: 'max-tokens-table' }, ...tableRows),
        h('p', null, 'Higher values = longer responses but more token usage. For agent teams, 4,096-8,192 is usually sufficient.'),
      ),
    ),
    h('div', { class: 'team-field' },
      h('label', null, 'Max Turns ',
        h('span', { class: 'max-tokens-help-toggle', id: 'max-turns-toggle', title: 'What is this?' }, '(? help)')
      ),
      h('input', { type: 'number', id: 'agent-max-turns', value: agent.maxTurns ? String(agent.maxTurns) : '', placeholder: 'Unlimited' }),
      h('div', { id: 'agent-max-turns-hint', class: 'field-hint' }, 'Limits conversation history length. Oldest turns are dropped.'),
      h('div', { id: 'max-turns-help', class: 'max-tokens-help', style: 'display:none' },
        h('p', null, h('strong', null, 'Max Turns'), ' caps how many user/assistant turn pairs are kept in context. Older turns are dropped to save input tokens.'),
        h('table', { class: 'max-tokens-table' },
          h('tr', null, h('th', null, 'Use Case'), h('th', null, 'Max Turns'), h('th', null, 'Notes')),
          h('tr', null, h('td', null, 'Quick tasks (lint, format)'), h('td', null, '10'), h('td', null, 'Low cost, short memory')),
          h('tr', null, h('td', null, 'Standard development'), h('td', null, '30'), h('td', null, 'Good balance of cost and context')),
          h('tr', null, h('td', null, 'Deep analysis / research'), h('td', null, '100'), h('td', null, 'Higher cost, longer memory')),
          h('tr', null, h('td', null, 'Large context models'), h('td', null, 'blank'), h('td', null, 'Default: unlimited (Claude, Gemini)')),
        ),
      ),
    ),
    h('div', { class: 'team-field' },
      h('label', null, 'Max Context Tokens ',
        h('span', { class: 'max-tokens-help-toggle', id: 'max-context-toggle', title: 'What is this?' }, '(? help)')
      ),
      h('input', { type: 'number', id: 'agent-max-context-tokens', value: agent.maxContextTokens ? String(agent.maxContextTokens) : '', placeholder: 'Unlimited' }),
      h('div', { id: 'agent-max-context-hint', class: 'field-hint' }, 'Estimated input token budget. Oldest turns are dropped when exceeded.'),
      h('div', { id: 'max-context-help', class: 'max-tokens-help', style: 'display:none' },
        h('p', null, h('strong', null, 'Max Context Tokens'), ' sets a soft budget for input tokens. When the estimated token count exceeds this, oldest turns are dropped. Set this below your model\'s context window to leave room for the response.'),
        h('table', { class: 'max-tokens-table' },
          h('tr', null, h('th', null, 'Model'), h('th', null, 'Context Window'), h('th', null, 'Suggested Max Context')),
          h('tr', null, h('td', null, 'Mistral 7B'), h('td', null, '32,768'), h('td', null, '24,000')),
          h('tr', null, h('td', null, 'Qwen3 14B / GPT-OSS 20B'), h('td', null, '32,768'), h('td', null, '24,000')),
          h('tr', null, h('td', null, 'Llama 3.3 70B'), h('td', null, '131,072'), h('td', null, '100,000')),
          h('tr', null, h('td', null, 'Claude Sonnet'), h('td', null, '200,000'), h('td', null, '150,000')),
          h('tr', null, h('td', null, 'Gemini 2.5'), h('td', null, '1,048,576'), h('td', null, 'unlimited')),
        ),
        h('p', null, 'Rule of thumb: set to ~75% of the model\'s context window. On pay-per-token endpoints, lower values reduce cost.'),
      ),
    )
  );

  // Prompt section interactions
  wirePromptSectionEvents(body);

  // System prompt file upload
  body.querySelector('#prompt-upload-btn')?.addEventListener('click', () => {
    body.querySelector('#prompt-file-input')?.click();
  });
  body.querySelector('#prompt-file-input')?.addEventListener('change', async (e) => {
    const files = e.target.files;
    const lastSection = body.querySelector('.prompt-section:last-of-type .prompt-section-content');
    const status = body.querySelector('#prompt-file-status');
    for (const file of files) {
      const text = await file.text();
      if (lastSection) lastSection.value += `\n\n--- ${file.name} ---\n${text}`;
      if (window._podSync) {
        try {
          const podRoot = window._podSync._podRoot;
          const authFetch = window._podSync._fetch;
          await authFetch(`${podRoot}/porter/files/${encodeURIComponent(file.name)}`, {
            method: 'PUT',
            headers: { 'Content-Type': 'text/plain' },
            body: text,
          });
        } catch { /* best-effort Pod upload */ }
      }
    }
    if (status) status.textContent = `${files.length} file(s) appended`;
  });

  // Help toggles
  for (const [toggleId, helpId] of [['max-tokens-toggle', 'max-tokens-help'], ['max-turns-toggle', 'max-turns-help'], ['max-context-toggle', 'max-context-help']]) {
    body.querySelector(`#${toggleId}`)?.addEventListener('click', () => {
      const help = body.querySelector(`#${helpId}`);
      if (help) help.style.display = help.style.display === 'none' ? '' : 'none';
    });
  }

  // Max tokens auto-suggestion based on selected model
  function updateMaxTokensHint() {
    const modelId = body.querySelector('#agent-model')?.value || document.getElementById('config')?.state.model;
    const available = getAvailableModels();
    const model = available.find(m => (m.model_id || m.id) === modelId);
    const hint = body.querySelector('#agent-max-tokens-hint');
    if (model && model.max_tokens && hint) {
      hint.textContent = `Model max: ${model.max_tokens.toLocaleString()} | Recommended: ${Math.min(model.max_tokens, 8192).toLocaleString()}`;
    }
  }
  body.querySelector('#agent-model')?.addEventListener('change', updateMaxTokensHint);
  updateMaxTokensHint();
}

export function openAgentEditor(agent, editIdx = null, saveToLibrary = false) {
  const dlg = getOverlayDlg();
  dlg.openTemplate('tpl-agent-editor', {
    title: editIdx !== null ? 'Edit Agent' : 'Add Agent',
    id: 'agent-dialog',
    onOpen: () => {
      // Store editIdx on the dialog element for handleAgentSave
      dlg.dataset.editIdx = editIdx !== null ? String(editIdx) : '';
      dlg.dataset.saveToLibrary = String(saveToLibrary);
      renderAgentForm(agent);
      // Wire save/cancel buttons
      dlg.footerEl.querySelector('#agent-save')?.addEventListener('click', handleAgentSave);
      dlg.footerEl.querySelector('#agent-cancel')?.addEventListener('click', () => dlg.close());
    },
  });
}

export function handleAgentSave() {
  const dlg = getOverlayDlg();
  const body = dlg.bodyEl.querySelector('#agent-dialog-body');
  const configStore = document.getElementById('config');

  const agent = {
    name: body.querySelector('#agent-name').value.trim(),
    role: body.querySelector('#agent-role-value')?.value || 'worker',
    model: body.querySelector('#agent-model')?.value || '',
    promptSections: [...body.querySelectorAll('.prompt-section')].map(el => ({
      id: el.dataset.sectionId,
      title: el.querySelector('.prompt-section-title').textContent.trim(),
      content: el.querySelector('.prompt-section-content').value,
      default: '',
    })),
    systemPrompt: [...body.querySelectorAll('.prompt-section-content')].map(ta => ta.value).filter(Boolean).join('\n\n'),
    tools: [...body.querySelectorAll('#agent-tools input:checked')].map(cb => cb.value),
    channels: body.querySelector('#agent-channels').value.split(',').map(s => s.trim()).filter(Boolean),
    maxTokens: parseInt(body.querySelector('#agent-max-tokens').value) || 8192,
    maxTurns: parseInt(body.querySelector('#agent-max-turns').value) || undefined,
    maxContextTokens: parseInt(body.querySelector('#agent-max-context-tokens').value) || undefined,
    reasoning: body.querySelector('#agent-reasoning')?.checked || false,
    mcpTools: [
      ...[...body.querySelectorAll('.mcp-tool-check:checked')].map(cb => cb.value),
      ...(body.querySelector('#agent-mcp-tools')?.value.split(',').map(s => s.trim()).filter(Boolean) || []),
    ],
  };

  const editIdx = dlg.dataset.editIdx;
  if (editIdx !== '') {
    configStore.updateAgent(parseInt(editIdx), agent);
  } else {
    configStore.addAgent(agent);
  }

  // Save to agent library
  const saveLib = dlg.dataset.saveToLibrary === 'true';
  if (saveLib || editIdx === '') {
    fetch('/api/agents', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: agent.name,
        role: agent.role,
        model: agent.model,
        system_prompt: agent.systemPrompt,
        prompt_sections: agent.promptSections,
        tools: agent.tools,
        channels: agent.channels,
        mcp_tools: agent.mcpTools,
        max_tokens: agent.maxTokens,
        reasoning: agent.reasoning,
      }),
    }).catch(() => {});
  }

  dlg.close();
  if (!saveLib) {
    const teamBody = getDlg().bodyEl?.querySelector('#team-dialog-body');
    if (teamBody) renderTeamStep();
  }
  syncAgentsToPod(configStore.state.agents);
  updateSetupBar();
  if (document.querySelector('.empty-state-prompt')) renderEmptyState();
}
