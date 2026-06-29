/**
 * Flipboard setup bar — header status cells and gear icon wiring.
 */

import { renderModelSetup } from '../dialogs/model-setup.js';
import { openMcpEditorDialog, showMcpManageDialog } from '../dialogs/mcp-editor.js';
import { showAgentLibrary } from '../dialogs/agent-library.js';
import { openTeamBuilder } from '../dialogs/team-builder.js';
import { showSessionLauncher } from '../dialogs/session-launcher.js';
import { showMetricsDetail } from './metrics.js';
import { showFederationDialog } from '../dialogs/federation-editor.js';
import { showPatternsDialog } from '../dialogs/pattern-manager.js';

export function setupFlipboard() {
  // Header gear toggle
  document.getElementById('config-toggle')?.addEventListener('click', () => {
    document.getElementById('config-panel').classList.toggle('hidden');
    document.getElementById('config-toggle').classList.toggle('active');
  });

  // Cell clicks open dialogs
  document.getElementById('fb-models')?.addEventListener('click', () => renderModelSetup());
  document.getElementById('fb-mcp')?.addEventListener('click', () => {
    const configStore = document.getElementById('config');
    const count = Object.keys(configStore?.state?.mcpServers ?? {}).length;
    count > 0 ? showMcpManageDialog() : openMcpEditorDialog();
  });
  document.getElementById('fb-agents')?.addEventListener('click', () => showAgentLibrary());
  document.getElementById('fb-teams')?.addEventListener('click', () => openTeamBuilder());
  document.getElementById('fb-patterns')?.addEventListener('click', () => showPatternsDialog());
  document.getElementById('fb-federation')?.addEventListener('click', () => showFederationDialog());
  document.getElementById('fb-session')?.addEventListener('click', () => showSessionLauncher());

  // Gear icons inside cells
  document.querySelectorAll('.fb-gear').forEach(gear => {
    gear.addEventListener('click', (e) => {
      e.stopPropagation();
      switch (gear.dataset.action) {
        case 'models': renderModelSetup(); break;
        case 'mcp': {
          const cs = document.getElementById('config');
          const n = Object.keys(cs?.state?.mcpServers ?? {}).length;
          n > 0 ? showMcpManageDialog() : openMcpEditorDialog();
          break;
        }
        case 'agents': showAgentLibrary(); break;
        case 'teams': openTeamBuilder(); break;
        case 'patterns': showPatternsDialog(); break;
        case 'federation': showFederationDialog(); break;
        case 'session': showSessionLauncher(); break;
      }
    });
  });

  // Metrics detail button
  document.getElementById('m-detail-btn')?.addEventListener('click', showMetricsDetail);

  // Export config button
  document.getElementById('fb-export')?.addEventListener('click', async () => {
    const { downloadConfig } = await import('./empty-state.js');
    downloadConfig();
  });
}

export function updateSetupBar() {
  const modelStore = document.getElementById('models');
  const availableCount = modelStore?.getAvailable()?.length ?? 0;
  const modelsCell = document.getElementById('fb-models');
  const modelsVal = document.getElementById('fb-models-val');
  if (modelsCell && modelsVal) {
    modelsVal.textContent = availableCount === 0 ? 'NONE' : `${availableCount} AVAILABLE`;
    modelsCell.setAttribute('status', availableCount === 0 ? 'warn' : 'ok');
  }

  const configStore = document.getElementById('config');
  const mcpCount = Object.keys(configStore?.state?.mcpServers ?? {}).length;
  const mcpCell = document.getElementById('fb-mcp');
  const mcpVal = document.getElementById('fb-mcp-val');
  if (mcpCell && mcpVal) {
    mcpVal.textContent = mcpCount === 0 ? 'NONE' : `${mcpCount} SERVER${mcpCount > 1 ? 'S' : ''}`;
    mcpCell.setAttribute('status', mcpCount === 0 ? 'warn' : 'ok');
  }

  const browserMode = document.querySelector('meta[name="porter-mode"]')?.content === 'browser';
  if (browserMode) {
    // In browser mode, read counts from localStorage (populated by Pod sync)
    const agents = JSON.parse(localStorage.getItem('porter-pod-agents') || '[]');
    const teams = JSON.parse(localStorage.getItem('porter-pod-teams') || '[]');
    const agentCell = document.getElementById('fb-agents');
    const agentVal = document.getElementById('fb-agents-val');
    if (agentCell && agentVal) {
      agentVal.textContent = agents.length === 0 ? 'NONE' : `${agents.length} SAVED`;
      agentCell.setAttribute('status', agents.length === 0 ? 'warn' : 'ok');
    }
    const teamCell = document.getElementById('fb-teams');
    const teamVal = document.getElementById('fb-teams-val');
    if (teamCell && teamVal) {
      teamVal.textContent = teams.length === 0 ? 'NONE' : `${teams.length} SAVED`;
      teamCell.setAttribute('status', teams.length === 0 ? 'warn' : 'ok');
    }
    // Hide federation and patterns in browser mode
    const fedCell = document.getElementById('fb-federation');
    if (fedCell) fedCell.style.display = 'none';
    document.querySelector('flipboard-bar')?._updateWidths?.();
    return;
  }
  updateTeamCount();
  updateAgentCount();
  updatePatternCount();
  updateFederationStatus();
  document.querySelector('flipboard-bar')?._updateWidths?.();
}

export function updatePatternCount() {
  const cell = document.getElementById('fb-patterns');
  const val = document.getElementById('fb-patterns-val');
  if (!cell || !val) return;
  fetch('/api/patterns')
    .then(r => r.ok ? r.json() : { patterns: [] })
    .then(data => {
      const count = data.patterns?.length ?? 0;
      const builtinCount = (data.patterns || []).filter(p => p.builtin !== false).length;
      const customCount = count - builtinCount;
      if (count === 0) {
        val.textContent = 'NONE';
        cell.setAttribute('status', 'warn');
      } else {
        val.textContent = customCount > 0 ? `${builtinCount}+${customCount}` : `${builtinCount} BUILT-IN`;
        cell.setAttribute('status', 'ok');
      }
      document.querySelector('flipboard-bar')?._updateWidths?.();
    })
    .catch(() => {
      val.textContent = '--';
      cell.removeAttribute('status');
    });
}

export function updateFederationStatus() {
  const cell = document.getElementById('fb-federation');
  const val = document.getElementById('fb-federation-val');
  if (!cell || !val) return;
  fetch('/api/activitypub/config')
    .then(r => r.ok ? r.json() : null)
    .then(data => {
      if (!data || !data.domain) {
        cell.style.display = 'none';
        document.querySelector('flipboard-bar')?._updateWidths?.();
        return;
      }
      cell.style.display = '';
      if (data.enabled) {
        val.textContent = 'ENABLED';
        cell.setAttribute('status', 'ok');
      } else {
        val.textContent = 'DISABLED';
        cell.setAttribute('status', 'warn');
      }
      document.querySelector('flipboard-bar')?._updateWidths?.();
    })
    .catch(() => {
      cell.style.display = 'none';
    });
}

export function updateTeamCount() {
  const cell = document.getElementById('fb-teams');
  const val = document.getElementById('fb-teams-val');
  if (!cell || !val) return;
  fetch('/api/teams')
    .then(r => r.ok ? r.json() : { teams: [] })
    .then(data => {
      const count = data.teams?.length ?? 0;
      val.textContent = count === 0 ? 'NONE' : `${count} SAVED`;
      cell.setAttribute('status', count === 0 ? 'warn' : 'ok');
      document.querySelector('flipboard-bar')?._updateWidths?.();
    })
    .catch(() => {
      val.textContent = '--';
      cell.removeAttribute('status');
    });
}

export function updateAgentCount() {
  const cell = document.getElementById('fb-agents');
  const val = document.getElementById('fb-agents-val');
  if (!cell || !val) return;
  fetch('/api/agents')
    .then(r => r.ok ? r.json() : { agents: [] })
    .then(data => {
      const count = data.agents?.length ?? 0;
      val.textContent = count === 0 ? 'NONE' : `${count} SAVED`;
      cell.setAttribute('status', count === 0 ? 'warn' : 'ok');
      document.querySelector('flipboard-bar')?._updateWidths?.();
    })
    .catch(() => {
      val.textContent = '--';
      cell.removeAttribute('status');
    });
}
