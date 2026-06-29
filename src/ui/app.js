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
  syncAgentsToPod,
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
import { renderModelSetup } from './dialogs/model-setup.js';
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
  // Register service worker for PWA support
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('message', (event) => {
      const { type, data } = event.data || {};
      if (type === 'metrics') {
        const fmt = (n) => n >= 1000000 ? (n / 1000000).toFixed(1) + 'M' : n >= 1000 ? (n / 1000).toFixed(1) + 'K' : String(n);
        document.getElementById('m-tokens-in').textContent = `IN: ${fmt(data.totalIn)}`;
        document.getElementById('m-tokens-out').textContent = `OUT: ${fmt(data.totalOut)}`;
        document.getElementById('m-api-calls').textContent = `API: ${data.totalApi}`;
        document.getElementById('m-errors').textContent = `ERR: ${data.totalErr}`;
        document.getElementById('m-rate-limits').textContent = `LIMITS: ${data.rateLimits}`;
      }
      if (type === 'sessions') {
        document.getElementById('projects')?.setSessions(data.sessions || []);
      }
    });
  }

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

  const main = document.querySelector('main');
  main.classList.add('porter-loading');

  // --- Authenticate before doing anything else ---
  let authenticated = false;
  let solidRestored = false;
  let solidWebId = null;

  // 1. Handle Solid OIDC callback
  if (window.location.search.includes('code=') && (localStorage.getItem('porter-solid-state') || localStorage.getItem('porter-solid-last-idp'))) {
    try {
      const result = await window.solidAuth.handleRedirect();
      window.history.replaceState({}, '', window.location.pathname);
      if (result.isLoggedIn) {
        solidRestored = true;
        solidWebId = result.webId;
        authenticated = true;
      }
    } catch (err) {
      console.error('[porter] Solid redirect failed:', err);
    }
  }

  // 2. Restore Solid session from localStorage
  if (!authenticated) {
    const restored = window.solidAuth?.restoreSession?.();
    if (restored?.isLoggedIn) {
      solidRestored = true;
      solidWebId = restored.webId;
      authenticated = true;
    }
  }

  // 3. Fallback: check live Solid session state
  if (!authenticated) {
    const liveSession = window.solidAuth?.getSessionInfo?.();
    if (liveSession?.isLoggedIn && liveSession.webId) {
      solidRestored = true;
      solidWebId = liveSession.webId;
      authenticated = true;
    }
  }

  // 4. Check email identity (standalone mode)
  if (!authenticated) {
    const email = localStorage.getItem('porter-user-email');
    if (email) authenticated = true;
  }

  // 5. Browser mode — no backend, skip server checks
  const { BROWSER_MODE } = await import('./constants.js');
  if (BROWSER_MODE) {
    authenticated = true; // allow through — auth is via Solid login only
  }

  // 6. Check server-side session (SSO or server-side Solid)
  let ssoMe = null;
  if (!authenticated && !BROWSER_MODE) {
    try {
      const meResp = await fetch('/auth/me');
      if (meResp.ok) {
        ssoMe = await meResp.json();
        if (ssoMe.authenticated) authenticated = true;
        if (!ssoMe.authenticated && !ssoMe.oidc_configured) authenticated = true;
      }
    } catch {
      authenticated = true;
    }
  }

  // 6. Not authenticated — show only sign-in, don't load anything else
  if (!authenticated) {
    main.classList.remove('porter-loading');
    checkAuthState();
    return;
  }

  // --- Authenticated — wait for pod readiness before making API calls ---
  const loadingEl = document.getElementById('loading-indicator');
  const loadingText = loadingEl?.querySelector('.loading-text');
  if (BROWSER_MODE) {
    // Skip pod readiness, API init, and WebSocket — just render the static UI
    main.classList.remove('porter-loading');
    if (loadingEl) {
      await renderEmptyState();
    }
    checkAuthState();
    return;
  }
  if (ssoMe?.authenticated) {
    // In router mode, the user pod may still be starting
    let podReady = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        const statusResp = await fetch('/api/pod-status');
        if (statusResp.ok) {
          const status = await statusResp.json();
          if (status.ready) { podReady = true; break; }
        } else if (statusResp.status !== 503 && statusResp.status !== 401) {
          // Not in router mode (no pod-status endpoint) — proceed immediately
          podReady = true;
          break;
        }
      } catch {
        podReady = true; // fetch failed — likely standalone mode
        break;
      }
      if (loadingText) loadingText.textContent = 'Starting workspace...';
      await new Promise(r => setTimeout(r, 2000));
    }
    if (loadingText) loadingText.textContent = 'Loading...';
  }

  // --- Initialize UI components that make API calls ---
  setupProjectSwitcher();
  setupFlipboard();

  window.addEventListener('porter-switch-session', (e) => {
    const { busUrl } = e.detail;
    resetBusState();
    restoreMainContent();
    connectWebSocket(busUrl);
  });
  if (solidRestored && solidWebId) {
    await initPodSync(solidWebId);
  }
  if (!window._podSync && ssoMe?.pod_url && ssoMe?.lws_token_endpoint) {
    try {
      await initSsoPodSync(ssoMe.pod_url, ssoMe.lws_token_endpoint);
    } catch { /* best effort */ }
  }
  // Retry Pod sync if pod_url is known but token wasn't ready yet (race on Solid callback)
  if (!window._podSync && ssoMe?.pod_url && !ssoMe?.lws_token_endpoint && ssoMe?.solid_user) {
    setTimeout(async () => {
      if (window._podSync) return;
      try {
        const retryResp = await fetch('/auth/me');
        if (retryResp.ok) {
          const retryMe = await retryResp.json();
          if (retryMe.pod_url && retryMe.lws_token_endpoint) {
            await initSsoPodSync(retryMe.pod_url, retryMe.lws_token_endpoint);
          }
        }
      } catch { /* best effort */ }
    }, 2000);
  }

  checkAuthState();

  // --- Check for ?config= querystring auto-import ---
  {
    const configUrl = new URLSearchParams(window.location.search).get('config');
    if (configUrl) {
      sessionStorage.setItem('porter-config-import', configUrl);
      history.replaceState(null, '', window.location.pathname);
    }
    const pendingConfig = sessionStorage.getItem('porter-config-import');
    if (pendingConfig) {
      sessionStorage.removeItem('porter-config-import');
      try {
        const resp = await fetch(pendingConfig);
        if (resp.ok) {
          const text = await resp.text();
          const ct = resp.headers.get('content-type') || '';
          const importResp = await fetch('/api/config/import', {
            method: 'POST',
            headers: { 'Content-Type': ct.includes('turtle') ? 'text/turtle' : 'application/ld+json' },
            body: text,
          });
          if (importResp.ok) {
            const result = await importResp.json();
            console.log('[porter] Config auto-import:', result.imported);
            // Refresh models store
            await document.getElementById('models')?.refresh();
            updateSetupBar();
            // Sync imported agents to Pod
            try {
              const agentsResp = await fetch('/api/agents');
              if (agentsResp.ok) {
                const data = await agentsResp.json();
                if (data.agents?.length) syncAgentsToPod(data.agents);
              }
            } catch { /* best effort */ }
            // If models need keys, open model setup
            if (result.models_needing_keys?.length > 0) {
              renderModelSetup();
            }
          }
        }
      } catch (e) {
        console.error('[porter] Config import from URL failed:', e);
      }
    }
  }

  window.addEventListener('porter-auth-expired', () => {
    if (window._podSync) { window._podSync.disconnect(); window._podSync = null; }
    checkAuthState();
    showReloginPrompt();
  });

  const projectStore = document.getElementById('projects');
  projectStore.addEventListener('change', (e) => {
    if (e.detail.prop === 'sessions') {
      const sessions = projectStore.state.sessions;
      if (sessions.length === 0) {
        stopMetricsPolling();
        document.getElementById('metrics-bar')?.classList.add('hidden');
        projectStore.setActive(null);
        resetBusState();
        const connStore = document.getElementById('connection');
        connStore.setDisconnected();
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

  await document.getElementById('models')?.refresh();
  updateSetupBar();
  await projectStore.refresh();

  if (document.getElementById('loading-indicator')) {
    await renderEmptyState();
  }

  main.classList.remove('porter-loading');

  connectWebSocket();
});
