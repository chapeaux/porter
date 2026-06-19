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
        case 'federation': showFederationDialog(); break;
        case 'session': showSessionLauncher(); break;
      }
    });
  });

  // Metrics detail button
  document.getElementById('m-detail-btn')?.addEventListener('click', showMetricsDetail);
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

  updateTeamCount();
  updateAgentCount();
  updateFederationStatus();
  document.querySelector('flipboard-bar')?._updateWidths?.();
}

export function updateFederationStatus() {
  const cell = document.getElementById('fb-federation');
  const val = document.getElementById('fb-federation-val');
  if (!cell || !val) return;
  fetch('/api/activitypub/config')
    .then(r => r.ok ? r.json() : { enabled: false })
    .then(data => {
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
      val.textContent = '--';
      cell.removeAttribute('status');
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
