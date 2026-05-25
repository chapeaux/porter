/**
 * Empty state — shown when no sessions are active.
 */

import { getDlg } from '../dialogs/dialog-helpers.js';
import { h } from '../dom.js';
import { renderModelSetup } from '../dialogs/model-setup.js';
import { openMcpEditorDialog, showMcpManageDialog } from '../dialogs/mcp-editor.js';
import { showAgentLibrary } from '../dialogs/agent-library.js';
import { openTeamBuilder } from '../dialogs/team-builder.js';
import { showSessionLauncher } from '../dialogs/session-launcher.js';
import { checkAuthState, _authChecked, oidcAvailable } from './auth-state.js';

// TODO: setupFilters, setupCompose, renderAgentDeck, renderTimeline are in
// app.js — passed via setEmptyStateCallbacks to avoid circular dependency
let _setupFilters = null;
let _setupCompose = null;
let _renderAgentDeck = null;
let _renderTimeline = null;

export function setEmptyStateCallbacks({ setupFilters, setupCompose, renderAgentDeck, renderTimeline }) {
  _setupFilters = setupFilters;
  _setupCompose = setupCompose;
  _renderAgentDeck = renderAgentDeck;
  _renderTimeline = renderTimeline;
}

export function createSessionContent() {
  const opt = (value, label, selected) => {
    const o = h('option', { value }, label);
    if (selected) o.selected = true;
    return o;
  };

  return [
    h('section', { id: 'agent-section' },
      h('h2', null, 'Agents'),
      h('div', { id: 'agent-deck' })
    ),
    h('section', { id: 'feed-section' },
      h('div', { id: 'feed-header' },
        h('h2', null, 'Message Feed'),
        h('div', { id: 'feed-controls' },
          h('div', { id: 'feed-filters' },
            h('button', { class: 'channel-filter', 'data-channel': 'log' }, 'Log'),
            h('button', { class: 'channel-filter', 'data-channel': 'task' }, 'Task'),
            h('button', { class: 'channel-filter', 'data-channel': 'control' }, 'Control'),
            h('button', { class: 'channel-filter', 'data-channel': 'activity' }, 'Activity'),
            h('button', { class: 'channel-filter active', 'data-channel': 'all' }, 'All')
          ),
          h('select', { id: 'feed-limit', title: 'Messages to show' },
            opt('25', '25'),
            opt('50', '50', true),
            opt('100', '100'),
            opt('200', '200'),
            opt('500', '500')
          )
        )
      ),
      h('div', { id: 'timeline' })
    ),
    h('section', { id: 'compose' },
      h('select', { id: 'compose-target', title: 'Send to a specific agent or broadcast channel' },
        h('optgroup', { id: 'compose-agents', label: 'Agents' }),
        h('optgroup', { label: 'Broadcast' },
          h('option', { value: 'task' }, 'task (all workers)'),
          h('option', { value: 'log' }, 'log'),
          h('option', { value: 'control' }, 'control')
        )
      ),
      h('textarea', { id: 'compose-message', placeholder: 'Send a message... (Ctrl+Enter)', rows: '1' }),
      h('button', { id: 'compose-send' }, 'Dispatch')
    ),
  ];
}

export function restoreMainContent() {
  const main = document.querySelector('main');
  main.replaceChildren(...createSessionContent());
  _setupFilters?.();
  _setupCompose?.();
  _renderAgentDeck?.();
  _renderTimeline?.();
}

let _emptyStateRendering = false;
let _stepRefs = null;

const STEP_DEFS = [
  { id: 'login', optional: false },
  { id: 'models', optional: false },
  { id: 'mcp', optional: true },
  { id: 'agents', optional: false },
  { id: 'team', optional: false },
  { id: 'launch', optional: false },
];

function _ensureSkeleton() {
  const existing = document.querySelector('.empty-state-prompt');
  if (existing && _stepRefs) return;

  const main = document.querySelector('main');
  _stepRefs = {};
  const stepEls = STEP_DEFS.map(def => {
    const icon = h('span', { class: 'setup-step-icon' }, '○');
    const label = h('span', { class: 'setup-step-label' }, '');
    const btn = h('button', { class: 'team-btn primary setup-step-btn', 'data-action': def.id }, '');
    const row = h('div', { class: `setup-step pending${def.optional ? ' optional' : ''}`, 'data-step': def.id }, icon, label, btn);
    _stepRefs[def.id] = { row, icon, label, btn };
    return row;
  });

  const emptyState = h('div', { id: 'empty-state', class: 'empty-state-prompt' },
    h('img', { src: './porter.svg', class: 'empty-logo-img' }),
    h('h3', null, 'Get Started'),
    h('div', { class: 'setup-steps' }, ...stepEls)
  );
  main.replaceChildren(emptyState);

  // Wire up click handlers (once, on the stable skeleton)
  for (const def of STEP_DEFS) {
    _stepRefs[def.id].btn.addEventListener('click', () => _handleStepAction(def.id));
  }
}

function _handleStepAction(action) {
  switch (action) {
    case 'login': {
      const hasEmail = localStorage.getItem('porter-user-email');
      const solidSession = window.solidAuth?.getSessionInfo?.();
      if (hasEmail || solidSession?.isLoggedIn) {
        if (window._podSync) { window._podSync.disconnect(); window._podSync = null; }
        window.solidAuth?.solidLogoutUser?.();
        localStorage.removeItem('porter-user-email');
        checkAuthState();
        renderEmptyState();
      } else {
        showOnboardingDialog();
      }
      break;
    }
    case 'models': renderModelSetup(); break;
    case 'mcp': {
      const cs = document.getElementById('config');
      const n = Object.keys(cs?.state?.mcpServers ?? {}).length;
      n > 0 ? showMcpManageDialog() : openMcpEditorDialog();
      break;
    }
    case 'agents': showAgentLibrary(); break;
    case 'team': {
      const ref = _stepRefs?.team;
      const hasTeams = ref?.row.classList.contains('done');
      openTeamBuilder(hasTeams ? 0 : 1);
      break;
    }
    case 'launch': showSessionLauncher(); break;
  }
}

function _updateStep(id, done, label, btnText, visible = true) {
  const ref = _stepRefs?.[id];
  if (!ref) return;
  const { row, icon, label: labelEl, btn } = ref;

  row.style.display = visible ? '' : 'none';

  const wasDone = row.classList.contains('done');
  if (wasDone !== done) {
    row.classList.toggle('done', done);
    row.classList.toggle('pending', !done);
  }

  const optional = STEP_DEFS.find(d => d.id === id)?.optional;
  const newIcon = done ? '✓' : (optional ? '◉' : '○');
  if (icon.textContent !== newIcon) icon.textContent = newIcon;
  if (labelEl.textContent !== label) labelEl.textContent = label;
  if (btn.textContent !== btnText) btn.textContent = btnText;

  const newBtnClass = `team-btn ${done ? 'secondary' : 'primary'} setup-step-btn`;
  if (btn.className !== newBtnClass) btn.className = newBtnClass;
}

export async function renderEmptyState() {
  if (_emptyStateRendering) return;
  _emptyStateRendering = true;

  _ensureSkeleton();

  const modelStore = document.getElementById('models');
  const modelCount = modelStore?.getAvailable()?.length ?? 0;
  const hasModels = modelCount > 0;

  const configStore = document.getElementById('config');
  const mcpCount = Object.keys(configStore?.state?.mcpServers ?? {}).length;

  const hasEmail = localStorage.getItem('porter-user-email');
  const solidSession = window.solidAuth?.getSessionInfo?.();
  const ssoActive = _authChecked ? await _authChecked : false;
  const hasIdentity = hasEmail || ssoActive || solidSession?.isLoggedIn;

  // Update synchronous steps immediately (no jumping)
  _updateStep('login', !!hasIdentity, hasIdentity ? 'Signed in' : 'Sign in', hasIdentity ? 'Sign Out' : 'Sign In');
  _updateStep('models', hasModels, hasModels ? `${modelCount} model${modelCount > 1 ? 's' : ''} configured` : 'Configure models', hasModels ? 'Manage' : 'Set Up');
  _updateStep('mcp', mcpCount > 0, mcpCount > 0 ? `${mcpCount} MCP server${mcpCount > 1 ? 's' : ''}` : 'MCP servers (optional)', mcpCount > 0 ? 'Manage' : 'Add');

  // Fetch async data without blocking the UI
  let hasTeams = false;
  let agentCount = 0;
  try {
    const [teamsResp, agentsResp] = await Promise.all([
      fetch('/api/teams').catch(() => null),
      fetch('/api/agents').catch(() => null),
    ]);
    if (teamsResp?.ok) { const d = await teamsResp.json(); hasTeams = (d.teams?.length ?? 0) > 0; }
    if (agentsResp?.ok) { const d = await agentsResp.json(); agentCount = d.agents?.length ?? 0; }
  } catch { /* ignore */ }

  _updateStep('agents', agentCount > 0, agentCount > 0 ? `${agentCount} agent${agentCount > 1 ? 's' : ''} saved` : 'Create an agent', agentCount > 0 ? 'Manage' : 'Create');
  _updateStep('team', hasTeams, hasTeams ? 'Teams available' : 'Create a team', hasTeams ? 'Manage' : 'Create');
  _updateStep('launch', false, 'Launch a session', 'Launch', hasTeams && hasModels);

  _emptyStateRendering = false;
}

export function showOnboardingDialog() {
  const dlg = getDlg();
  dlg.openTemplate('tpl-onboarding', {
    title: 'Welcome to Porter',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#onboarding-body');
      _renderOnboardingContent(dlg, body);
    },
  });
}

export function _renderOnboardingContent(dlg, body) {

  const solidIssuerInput = h('input', {
    type: 'url', id: 'onboard-solid-issuer', class: 'auth-input',
    placeholder: 'https://login.inrupt.com',
    value: localStorage.getItem('porter-solid-last-idp') || '',
    style: 'flex:1',
  });
  const solidLoginBtn = h('button', { id: 'onboard-solid-login', class: 'team-btn primary' }, 'Login');

  const emailInput = h('input', {
    type: 'email', id: 'onboard-email', class: 'auth-input',
    placeholder: 'you@example.com', style: 'flex:1',
  });
  const emailSaveBtn = h('button', { id: 'onboard-email-save', class: 'team-btn primary' }, 'Continue');

  const ssoChildren = oidcAvailable ? [
    h('div', { class: 'onboarding-option' },
      h('h4', null, 'Login with SSO'),
      h('a', { href: '/auth/login', class: 'team-btn primary' }, 'Login'),
      h('p', { class: 'field-hint' }, 'Authenticate via your organization\'s identity provider.')
    ),
    h('div', { class: 'onboarding-divider' }, h('span', null, 'or')),
  ] : [];

  const content = [
    h('div', { class: 'team-explanation' },
      h('img', { src: './porter.svg', style: 'width:3rem;margin-bottom:0.5rem' }),
      h('strong', null, 'All Aboard!'),
      h('p', null, 'Porter helps you create and orchestrate AI agent teams to work on your tasks. Help us get you on your way by letting us know who you are.')
    ),
    h('div', { class: 'onboarding-options' },
      ...ssoChildren,
      h('div', { class: 'onboarding-option' },
        h('h4', null, 'Login with Solid / LWS'),
        h('div', { style: 'display:flex;gap:0.4rem' }, solidIssuerInput, solidLoginBtn),
        h('p', { class: 'field-hint' }, 'Authenticate via a Solid OIDC identity provider. Your config syncs to your Pod.')
      ),
      h('div', { class: 'onboarding-divider' }, h('span', null, 'or')),
      h('div', { class: 'onboarding-option' },
        h('h4', null, 'Continue with Email'),
        h('div', { style: 'display:flex;gap:0.4rem' }, emailInput, emailSaveBtn),
        h('p', { class: 'field-hint' }, 'Enter your email to store your model credentials and team configurations.')
      )
    ),
  ];

  body.replaceChildren(...content);

  solidLoginBtn.addEventListener('click', () => {
    const issuer = solidIssuerInput.value.trim();
    if (issuer && issuer.startsWith('http')) {
      localStorage.setItem('porter-solid-last-idp', issuer);
      window.solidAuth.solidLogin(issuer, window.location.href);
    }
  });
  solidIssuerInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') solidLoginBtn.click();
  });

  emailSaveBtn.addEventListener('click', () => {
    const email = emailInput.value.trim();
    if (!email || !email.includes('@')) { emailInput.style.borderColor = 'var(--status-error)'; return; }
    localStorage.setItem('porter-user-email', email);
    dlg.close();
    checkAuthState();
    if (document.querySelector('.empty-state-prompt')) renderEmptyState();
  });

  emailInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') emailSaveBtn.click();
  });
}
