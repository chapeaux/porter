/**
 * Sync helper functions — Pod synchronisation utilities.
 *
 * Dependencies on app.js (resolved at runtime via callbacks):
 *   - getDlg() — used by showReloginPrompt()
 *   - updateSetupBar() — used by initPodSync()
 *
 * Note: injectMcpTokens lives in ../stores/config-store.js (already extracted).
 */

import { classifyMcpContext, classifyModelContext } from '../constants.js';
import { h, replaceContent } from '../dom.js';
import { PorterPodSync } from './pod-sync.js';

/**
 * Callback registry — app.js injects these after import so the helpers
 * can call back into app-level functions without a circular import.
 */
let _getDlg = () => document.getElementById('porter-dlg');
let _updateSetupBar = () => {};

export function setSyncHelpersCallbacks({ getDlg, updateSetupBar }) {
  if (getDlg) _getDlg = getDlg;
  if (updateSetupBar) _updateSetupBar = updateSetupBar;
}

export function syncToPod(key, value) {
  if (!window._podSync) return;
  window._podSync.save(key, value);
}

export function syncAgentsToPod(agents) {
  if (!window._podSync) return;
  const configStore = document.getElementById('config');
  const mcpServers = configStore?.state?.mcpServers ?? {};
  const safe = agents.map(a => {
    let ctx = 'any';
    if (a.mcpTools?.length) {
      for (const t of a.mcpTools) {
        const serverName = t.split('.')[0];
        if (mcpServers[serverName] && classifyMcpContext(mcpServers[serverName]) === 'local') { ctx = 'local'; break; }
      }
    }
    return {
      name: a.name, role: a.role, systemPrompt: a.systemPrompt,
      promptSections: a.promptSections, tools: a.tools,
      channels: a.channels, mcpTools: a.mcpTools,
      maxTokens: a.maxTokens, reasoning: a.reasoning,
      _context: ctx,
    };
  });
  syncToPod('saved_agents', safe);
}

export async function syncTeamsToPod() {
  if (!window._podSync) return;
  try {
    const resp = await fetch('/api/teams');
    if (resp.ok) {
      const data = await resp.json();
      const configStore = document.getElementById('config');
      const mcpServers = configStore?.state?.mcpServers ?? {};
      const teams = (data.teams || []).map(t => {
        let ctx = 'any';
        for (const cfg of Object.values(t.config?.mcp_servers || {})) {
          if (classifyMcpContext(cfg) === 'local') { ctx = 'local'; break; }
        }
        return { name: t.name, config: t.config, _context: ctx };
      });
      syncToPod('teams', teams);
    }
  } catch { /* best-effort */ }
}

export function syncModelsToPod(models) {
  const tagged = (models || []).map(m => ({ ...m, _context: classifyModelContext(m) }));
  syncToPod('models', tagged);
}

export async function syncPublishedTeamsToPod() {
  if (!window._podSync) return;
  try {
    const resp = await fetch('/api/activitypub/teams');
    if (resp.ok) {
      const data = await resp.json();
      const slugs = (data.teams || []).map(t => t.teamSlug || t.slug || t.name);
      syncToPod('published_teams', slugs);
    }
  } catch { /* best-effort */ }
}

export function syncMcpToPod() {
  if (!window._podSync) return;
  const configStore = document.getElementById('config');
  const servers = configStore?.state?.mcpServers ?? {};
  const safe = {};
  for (const [name, cfg] of Object.entries(servers)) {
    safe[name] = { name: cfg.name, transport: cfg.transport, url: cfg.url, command: cfg.command, args: cfg.args, auth: cfg.auth, _context: classifyMcpContext(cfg) };
  }
  syncToPod('mcp_servers', safe);
}

export function showReloginPrompt() {
  const lastIdp = localStorage.getItem('porter-solid-last-idp');
  if (!lastIdp) return;

  const dlg = _getDlg();
  dlg.openTemplate('tpl-onboarding', {
    title: 'Session Expired',
    onOpen: () => {
      const body = dlg.bodyEl.querySelector('#onboarding-body');

      const issuerInput = h('input', { type: 'url', id: 'relogin-issuer', class: 'auth-input', value: lastIdp, style: 'flex:1' });
      const loginBtn = h('button', { id: 'relogin-btn', class: 'team-btn primary' }, 'Login');
      const dismissBtn = h('button', { id: 'relogin-dismiss', class: 'team-btn secondary' }, 'Continue without Pod sync');

      replaceContent(body,
        h('div', { class: 'team-explanation' },
          h('strong', null, 'Session Expired'),
          h('p', null, 'Your Solid session has expired. Log in again to continue syncing to your Pod.')
        ),
        h('div', { class: 'onboarding-options' },
          h('div', { class: 'onboarding-option' },
            h('div', { style: 'display:flex;gap:0.4rem' },
              issuerInput,
              loginBtn
            )
          ),
          h('div', { class: 'onboarding-option', style: 'margin-top:0.5rem' },
            dismissBtn
          )
        )
      );

      loginBtn.addEventListener('click', () => {
        const issuer = issuerInput.value.trim();
        if (issuer && issuer.startsWith('http')) {
          localStorage.setItem('porter-solid-last-idp', issuer);
          window.solidAuth.solidLogin(issuer, window.location.href);
        }
      });
      dismissBtn.addEventListener('click', () => {
        dlg.close();
      });
    },
  });
}

export async function initPodSync(webId) {
  if (window._podSync) return;
  try {
    const podRoot = await window.solidAuth.discoverPodStorage(webId);
    if (!podRoot) { console.error('[porter-pod] Could not discover Pod storage for', webId); return; }
    const authFetch = window.solidAuth.getAuthFetch();
    const sync = new PorterPodSync(podRoot, authFetch);
    window._podSync = sync;
    await sync.connect();
    await document.getElementById('models')?.refresh();
    _updateSetupBar();
  } catch (e) { console.error('[porter-pod] Sync init failed:', e); }
}

export async function initSsoPodSync(podUrl, tokenEndpoint) {
  if (window._podSync) return;
  if (!tokenEndpoint) {
    console.error('[porter-pod] SSO Pod sync requires tokenEndpoint');
    return;
  }
  try {
    let accessToken = await exchangeLwsToken(tokenEndpoint);
    let tokenExpiry = Date.now() + 3500_000;

    const authFetch = async (url, opts = {}) => {
      if (Date.now() > tokenExpiry) {
        accessToken = await exchangeLwsToken(tokenEndpoint);
        tokenExpiry = Date.now() + 3500_000;
      }
      return fetch(url, {
        ...opts,
        headers: {
          ...(opts.headers || {}),
          'Authorization': `Bearer ${accessToken}`,
        },
      });
    };

    const sync = new PorterPodSync(podUrl, authFetch);
    window._podSync = sync;
    await sync.connect();
    await document.getElementById('models')?.refresh();
    _updateSetupBar();
    console.log('[porter-pod] SSO Pod sync initialized via token exchange:', podUrl);
  } catch (e) { console.error('[porter-pod] SSO Pod sync init failed:', e); }
}

async function exchangeLwsToken(tokenEndpoint) {
  const resp = await fetch(tokenEndpoint, { method: 'POST' });
  if (resp.status === 401) {
    // LWS token lost (router restarted) — silent re-login to refresh it.
    // SSO session is still active so this redirect is transparent.
    window.location.href = `/auth/login?redirect=${encodeURIComponent(window.location.pathname)}`;
    await new Promise(() => {}); // block until redirect
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`LWS token exchange failed: ${resp.status} ${text}`);
  }
  const data = await resp.json();
  return data.access_token;
}

export async function syncMemoryToPod(sessionName) {
  if (!window._podSync) return;
  try {
    const resp = await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/memory`);
    if (resp.ok) {
      const turtle = await resp.text();
      if (turtle.trim()) {
        await window._podSync.saveMemory(sessionName, turtle);
      }
    }
  } catch (e) { console.error('[porter-pod] Memory sync to pod failed:', e); }
}

export async function restoreMemoryFromPod(sessionName) {
  if (!window._podSync) return;
  try {
    const turtle = await window._podSync.loadMemory(sessionName);
    if (turtle && turtle.trim()) {
      await fetch(`/api/sessions/${encodeURIComponent(sessionName)}/memory`, {
        method: 'POST',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle,
      });
      console.log('[porter-pod] Memory restored from pod for session:', sessionName);
    }
  } catch (e) { console.error('[porter-pod] Memory restore from pod failed:', e); }
}
