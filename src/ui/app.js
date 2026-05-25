/**
 * Porter Station -- bootstrap, callback wiring, and DOMContentLoaded handler.
 *
 * All domain logic has been extracted into:
 *   - ./stores/       — ProjectStore, ConfigStore, ModelStore, runtime stores
 *   - ./sync/         — PorterPodSync, sync helpers
 *   - ./connection/   — WebSocket bus client
 *   - ./render/       — connection status, agent deck, timeline, filters, compose
 *   - ./dialogs/      — dialog helpers, model setup, MCP editor, agent editor,
 *                        agent library, team builder, session launcher
 *   - ./features/     — empty state, auth state, metrics, flipboard setup,
 *                        project switcher
 */

import { debounce } from './constants.js';

// ── Stores ──────────────────────────────────────────────────────────────
import { ProjectStore } from './stores/project-store.js';
import { ConfigStore } from './stores/config-store.js';
import { ModelStore } from './stores/model-store.js';
import { ConnectionStore, AgentStore, MessageStore } from './stores/runtime-stores.js';

// ── Sync ────────────────────────────────────────────────────────────────
import { setPodSyncCallbacks } from './sync/pod-sync.js';
import {
  showReloginPrompt, initPodSync, initSsoPodSync, setSyncHelpersCallbacks,
} from './sync/sync-helpers.js';

// ── Connection ──────────────────────────────────────────────────────────
import {
  connectWebSocket, setBusClientCallbacks, resetBusState,
} from './connection/bus-client.js';

// ── Render ──────────────────────────────────────────────────────────────
import { renderConnectionStatus } from './render/connection-status.js';
import { renderAgentDeck, setShowDialog as setAgentDeckShowDialog } from './render/agent-deck.js';
import { renderTimeline, setShowDialog as setTimelineShowDialog } from './render/timeline.js';
import { setupFilters } from './render/filters.js';
import { populateTargetDropdown, setupCompose } from './render/compose.js';

// ── Dialogs ─────────────────────────────────────────────────────────────
import { getDlg, setupDialog, showDialog } from './dialogs/dialog-helpers.js';
import { setupTeamBuilder, setTeamBuilderCallbacks } from './dialogs/team-builder.js';
import { switchToSession, setSessionLauncherCallbacks } from './dialogs/session-launcher.js';

// ── Features ────────────────────────────────────────────────────────────
import {
  restoreMainContent, renderEmptyState, setEmptyStateCallbacks,
} from './features/empty-state.js';
import { checkAuthState, getIdentityHeaders } from './features/auth-state.js';
import { startMetricsPolling, stopMetricsPolling } from './features/metrics.js';
import { setupFlipboard, updateSetupBar } from './features/flipboard-setup.js';
import { setupProjectSwitcher, setProjectSwitcherCallbacks } from './features/project-switcher.js';

// =========================================================================
// Wire cross-module callbacks
// =========================================================================

// Sync modules need getDlg, updateSetupBar, getIdentityHeaders
setSyncHelpersCallbacks({ getDlg, updateSetupBar });
setPodSyncCallbacks({ updateSetupBar, getIdentityHeaders });

// Bus client needs populateTargetDropdown
setBusClientCallbacks({ populateTargetDropdown });

// Render modules need showDialog
setAgentDeckShowDialog(showDialog);
setTimelineShowDialog(showDialog);

// Team builder needs connectWebSocket and renderTimeline
setTeamBuilderCallbacks({ connectWebSocket, renderTimeline });

// Session launcher needs connectWebSocket and renderTimeline
setSessionLauncherCallbacks({ connectWebSocket, renderTimeline });

// Empty state needs setupFilters, setupCompose, renderAgentDeck, renderTimeline
setEmptyStateCallbacks({ setupFilters, setupCompose, renderAgentDeck, renderTimeline });

// Project switcher needs connectWebSocket
setProjectSwitcherCallbacks({ connectWebSocket });

// =========================================================================
// Bootstrap
// =========================================================================

document.addEventListener('DOMContentLoaded', async () => {
  await Promise.all([
    customElements.whenDefined('connection-store'),
    customElements.whenDefined('agent-store'),
    customElements.whenDefined('message-store'),
    customElements.whenDefined('config-store'),
    customElements.whenDefined('project-store'),
    customElements.whenDefined('model-store'),
  ]);

  const connStore = document.getElementById('connection');
  const agentStore = document.getElementById('agents');
  const msgStore = document.getElementById('messages');

  connStore.addEventListener('change', renderConnectionStatus);
  agentStore.addEventListener('change', debounce(renderAgentDeck, 100));
  msgStore.addEventListener('change', debounce(renderTimeline, 100));

  setupDialog();
  setupTeamBuilder();
  setupProjectSwitcher();
  setupFlipboard();

  // Handle session switches: disconnect current WS and reconnect to new bus URL
  window.addEventListener('porter-switch-session', (e) => {
    const { busUrl } = e.detail;
    resetBusState();
    restoreMainContent();
    connectWebSocket(busUrl);
  });

  // Show loading state — don't render stale localStorage content until
  // we confirm sessions exist on the server.
  const main = document.querySelector('main');
  main.classList.add('porter-loading');

  // Restore Solid session and AWAIT Pod sync so model data is ready
  // before any "no models" checks run.
  let solidRestored = false;
  let solidWebId = null;
  if (window.location.search.includes('code=') && sessionStorage.getItem('porter-solid-state')) {
    try {
      const result = await window.solidAuth.handleRedirect();
      window.history.replaceState({}, '', window.location.pathname);
      if (result.isLoggedIn) {
        solidRestored = true;
        solidWebId = result.webId;
      }
    } catch (err) {
      console.error('[porter] Solid redirect failed:', err);
    }
  } else {
    const restored = window.solidAuth?.restoreSession?.();
    if (restored?.isLoggedIn) {
      solidRestored = true;
      solidWebId = restored.webId;
    }
  }

  if (solidRestored && solidWebId) {
    await initPodSync(solidWebId);
  }

  // SSO users: initialize Pod sync if the server provides a pod_url (LWS)
  if (!window._podSync) {
    try {
      const meResp = await fetch('/auth/me');
      if (meResp.ok) {
        const me = await meResp.json();
        if (me.authenticated && me.pod_url && me.lws_token_endpoint) {
          await initSsoPodSync(me.pod_url, me.lws_token_endpoint);
        }
      }
    } catch { /* not authenticated or no LWS configured */ }
  }

  checkAuthState();

  // Re-show login when Solid session expires
  window.addEventListener('porter-auth-expired', () => {
    if (window._podSync) { window._podSync.disconnect(); window._podSync = null; }
    checkAuthState();
    showReloginPrompt();
  });

  // Check for active sessions — show empty state if none, restore when sessions appear
  const projectStore = document.getElementById('projects');
  projectStore.addEventListener('change', (e) => {
    if (e.detail.prop === 'sessions') {
      const sessions = projectStore.state.sessions;
      if (sessions.length === 0) {
        stopMetricsPolling();
        document.getElementById('metrics-bar')?.classList.add('hidden');
        projectStore.setActive(null);
        // Disconnect WebSocket — reconnect to lobby to stop retrying
        resetBusState();
        const connStore = document.getElementById('connection');
        connStore.setDisconnected();
        // Clear stale UI state
        agentStore._isInternalChange = true;
        agentStore.state.agents = {};
        agentStore._isInternalChange = false;
        msgStore._isInternalChange = true;
        msgStore.state.messages = [];
        msgStore._isInternalChange = false;
        renderAgentDeck();
        renderTimeline();
        renderEmptyState();
      } else if (sessions.length > 0) {
        document.getElementById('metrics-bar')?.classList.remove('hidden');
        if (document.querySelector('.empty-state-prompt') || document.getElementById('loading-indicator')) {
          restoreMainContent();
        }
        renderAgentDeck();
        renderTimeline();
        const hydratedAgents = agentStore.state.agents;
        if (Object.keys(hydratedAgents).length > 0) {
          populateTargetDropdown(Object.entries(hydratedAgents).map(([name, info]) => ({
            name, role: info.role, model: info.model, tools: info.tools,
          })));
        }
        const active = projectStore.state.activeSession;
        const activeGone = active && !sessions.find(s => s.session === active);
        if (!active || activeGone) {
          const first = sessions[0].session;
          switchToSession(first);
        }
      }
    }
  });

  // Fetch models and sessions — wait for both before removing loading state
  await document.getElementById('models')?.refresh();
  updateSetupBar();
  await projectStore.refresh();

  // If the loading indicator is still showing (no sessions triggered the
  // empty state or session content), render the empty state now.
  if (document.getElementById('loading-indicator')) {
    await renderEmptyState();
  }

  main.classList.remove('porter-loading');

  connectWebSocket();
});
