/**
 * Sync helper functions — Pod synchronisation utilities.
 *
 * Dependencies on app.js (resolved at runtime via callbacks):
 *   - getDlg() — used by showReloginPrompt()
 *   - updateSetupBar() — used by initPodSync()
 *
 * Note: injectMcpTokens lives in ../stores/config-store.js (already extracted).
 */

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

export async function syncAgentsToPod(agents) {
  if (!window._podSync) {
    // Pod sync not initialized — skip silently
    return;
  }
  const podRoot = window._podSync._podRoot;
  const authFetch = window._podSync._fetch;

  // Ensure agents/ container exists
  const containerUrl = `${podRoot}porter/agents/`;
  await ensureContainer(authFetch, containerUrl);

  // Write each agent as a Turtle file
  for (const agent of agents) {
    const name = agent.name;
    if (!name) continue;
    const url = `${podRoot}porter/agents/${encodeURIComponent(name)}.ttl`;
    const turtle = agentToTurtle(agent, url);
    try {
      const resp = await authFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`[porter-pod] PUT failed: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error(`[porter-pod] PUT error:`, err);
    }
  }

  // Don't delete orphans here — the server may not have all agents yet
  // (e.g., fresh pod hasn't loaded from Pod yet). Deletion only happens
  // via explicit deleteAgentFromPod().
}

export async function deleteAgentFromPod(agentName) {
  if (!window._podSync) return;
  const podRoot = window._podSync._podRoot;
  const authFetch = window._podSync._fetch;
  const url = `${podRoot}porter/agents/${encodeURIComponent(agentName)}.ttl`;
  await authFetch(url, { method: 'DELETE' }).catch(() => {});
}

export async function syncTeamsToPod() {
  if (!window._podSync) return;
  const podRoot = window._podSync._podRoot;
  const authFetch = window._podSync._fetch;

  try {
    const resp = await fetch('/api/teams');
    if (!resp.ok) return;
    const data = await resp.json();
    const teams = data.teams || [];

    // Ensure teams/ container exists
    await ensureContainer(authFetch, `${podRoot}porter/teams/`);

    // Get existing team files on Pod
    const existingFiles = await listContainer(authFetch, `${podRoot}porter/teams/`);
    const teamNames = new Set(teams.map(t => t.name).filter(Boolean));

    // Write each team as a Turtle file
    for (const team of teams) {
      if (!team.name) continue;
      const url = `${podRoot}porter/teams/${encodeURIComponent(team.name)}.ttl`;
      const turtle = teamToTurtle(team, url);
      await authFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle,
      });
    }

    // Don't delete orphans — same reason as agents
  } catch { /* best-effort */ }
}

export async function syncModelsToPod(models) {
  if (!window._podSync) return;
  const podRoot = window._podSync._podRoot;
  const authFetch = window._podSync._fetch;

  const containerUrl = `${podRoot}porter/models/`;
  await ensureContainer(authFetch, containerUrl);

  for (const model of (models || [])) {
    const id = model.id || model.model_id;
    if (!id) continue;
    // Replace / with -- for safe filenames (ibm-granite/granite-3b → ibm-granite--granite-3b)
    const safeId = id.replace(/\//g, '--');
    const url = `${containerUrl}${encodeURIComponent(safeId)}.ttl`;
    const turtle = modelToTurtle(model, url);
    try {
      const resp = await authFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`[porter-pod] PUT model failed: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error(`[porter-pod] PUT model error:`, err);
    }
  }
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

export async function syncMcpToPod() {
  if (!window._podSync) return;
  const podRoot = window._podSync._podRoot;
  const authFetch = window._podSync._fetch;

  const configStore = document.getElementById('config');
  const servers = configStore?.state?.mcpServers ?? {};

  const containerUrl = `${podRoot}porter/mcp/`;
  await ensureContainer(authFetch, containerUrl);

  for (const [name, cfg] of Object.entries(servers)) {
    if (!name) continue;
    const url = `${containerUrl}${encodeURIComponent(name)}.ttl`;
    const turtle = mcpToTurtle({ name, ...cfg }, url);
    try {
      const resp = await authFetch(url, {
        method: 'PUT',
        headers: { 'Content-Type': 'text/turtle' },
        body: turtle,
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error(`[porter-pod] PUT mcp failed: ${resp.status} ${body}`);
      }
    } catch (err) {
      console.error(`[porter-pod] PUT mcp error:`, err);
    }
  }
}

export async function syncFederationToPod(config) {
  if (!window._podSync) return;
  const podRoot = window._podSync._podRoot;
  const authFetch = window._podSync._fetch;

  if (!config) return;
  const url = `${podRoot}porter/federation.ttl`;
  const turtle = federationToTurtle(config, url);
  try {
    const resp = await authFetch(url, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: turtle,
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '');
      console.error(`[porter-pod] PUT federation failed: ${resp.status} ${body}`);
    }
  } catch (err) {
    console.error(`[porter-pod] PUT federation error:`, err);
  }
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
  const lastWebId = localStorage.getItem('porter-last-webid');
  if (lastWebId && lastWebId !== webId) {
    caches.keys().then(keys => keys.forEach(k => caches.delete(k)));
    localStorage.removeItem('porter-pod-teams');
    localStorage.removeItem('porter-pod-agents');
  }
  localStorage.setItem('porter-last-webid', webId);
  try {
    const podRoot = await window.solidAuth.discoverPodStorage(webId);
    if (!podRoot) { console.error('[porter-pod] Could not discover Pod storage for', webId); return; }
    const authFetch = window.solidAuth.getAuthFetch();
    const sync = new PorterPodSync(podRoot, authFetch);
    window._podSync = sync;
    await sync.connect();
    const browserMode = document.querySelector('meta[name="porter-mode"]')?.content === 'browser';
    if (!browserMode) {
      await document.getElementById('models')?.refresh();
      _syncAllToPod();
    }
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
    // Full sync of agents and teams to Pod on connect
    _syncAllToPod();
  } catch (e) { console.error('[porter-pod] SSO Pod sync init failed:', e); }
}

async function _syncAllToPod() {
  try {
    const agentsResp = await fetch('/api/agents');
    if (agentsResp.ok) {
      const data = await agentsResp.json();
      if (data.agents?.length) {
        await syncAgentsToPod(data.agents);
      }
    }
    await syncTeamsToPod();

    // Sync models to individual Turtle files
    const modelsResp = await fetch('/api/models');
    if (modelsResp.ok) {
      const data = await modelsResp.json();
      if (data.models?.length) {
        await syncModelsToPod(data.models);
      }
    }

    // Sync MCP servers to individual Turtle files
    await syncMcpToPod();

    // Sync federation config and grant Porter container access
    try {
      const fedResp = await fetch('/api/activitypub/config');
      if (fedResp.ok) {
        const fedConfig = await fedResp.json();
        if (fedConfig.enabled) {
          await syncFederationToPod(fedConfig);

          // Grant Porter's server identity read access to the porter/ container
          // so the AP bridge can fetch teams directly from the user's Pod.
          if (window._podSync) {
            const podRoot = window._podSync._podRoot;
            const ownerWebId = localStorage.getItem('porter-last-webid') || '';
            const porterDomain = fedConfig.domain || window.location.host;
            const porterWebId = `https://${porterDomain}/ap/porter#id`;
            const porterContainerUrl = `${podRoot}porter/`;
            await grantPorterContainerAccess(
              window._podSync._fetch,
              porterContainerUrl,
              porterWebId,
              ownerWebId,
            );
          }
        }
      }
    } catch { /* federation sync is best-effort */ }
  } catch (e) {
    console.error('[porter-pod] Full sync on connect failed:', e);
  }
}

async function exchangeLwsToken(tokenEndpoint) {
  const resp = await fetch(tokenEndpoint, { method: 'POST' });
  if (resp.status === 401) {
    throw new Error('LWS token exchange returned 401');
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
    }
  } catch (e) { console.error('[porter-pod] Memory restore from pod failed:', e); }
}

// --- Solid Pod container helpers ---

export async function ensureContainer(authFetch, url) {
  const containerTypes = [
    '<http://www.w3.org/ns/ldp#BasicContainer>; rel="type"',
    '<https://www.w3.org/ns/lws#Container>; rel="type"',
  ];
  for (const linkType of containerTypes) {
    try {
      const resp = await authFetch(url, {
        method: 'PUT',
        headers: { 'Link': linkType, 'Content-Type': 'text/turtle' },
        body: '',
      });
      if (resp.ok || resp.status === 201 || resp.status === 409) return;
    } catch (err) {
      console.error(`[porter-pod] ensureContainer error:`, err);
    }
  }
}

export async function listContainer(authFetch, url) {
  try {
    const resp = await authFetch(url, { headers: { 'Accept': 'text/turtle' } });
    if (!resp.ok) return [];
    const text = await resp.text();
    // Extract all URIs from ldp:contains — handles both single and comma-separated lists
    // Match everything from ldp:contains until " ." (space-dot) which ends the Turtle statement
    // Can't use [^.]+ because URLs contain dots
    const containsMatch = text.match(/ldp:contains\s+([\s\S]+?)\s+\./m);
    if (!containsMatch) {
      return [];
    }
    const uriMatches = [...containsMatch[1].matchAll(/<([^>]+)>/g)];
    const files = uriMatches.map(m => decodeURIComponent(m[1].split('/').pop())).filter(Boolean);
    return files;
  } catch (err) {
    console.error(`[porter-pod] listContainer error:`, err);
    return [];
  }
}

// --- Turtle serializers (client-side, matching porter: vocabulary) ---

function escapeTtl(s) {
  return (s || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function agentToTurtle(agent, uri) {
  // Normalize field names (accept both camelCase and snake_case)
  const name = agent.name || '';
  const expertise = agent.systemPrompt || agent.system_prompt || '';
  const tools = agent.tools || [];
  const mcpTools = agent.mcpTools || agent.mcp_tools || [];
  const model = agent.model || '';
  const maxTokens = agent.maxTokens || agent.max_tokens || 0;
  const maxTurns = agent.maxTurns || agent.max_turns || 0;
  const maxContextTokens = agent.maxContextTokens || agent.max_context_tokens || 0;
  const reasoning = agent.reasoning || false;
  const role = agent.role || 'worker';
  const visibility = agent.visibility || 'private';
  const channels = agent.channels || agent.subscribe || [];

  const lines = [
    '@prefix porter: <https://porter.chapeaux.io/vocab#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `<${uri}> a porter:Agent ;`,
    `  porter:name "${escapeTtl(name)}" ;`,
    `  porter:assignedRole "${escapeTtl(role)}" ;`,
  ];

  if (expertise) {
    lines.push(`  porter:agentExpertise """${escapeTtl(expertise)}""" ;`);
  }

  for (const t of tools) {
    lines.push(`  porter:hasTool "${escapeTtl(t)}" ;`);
  }
  for (const t of mcpTools) {
    lines.push(`  porter:hasMcpTool "${escapeTtl(t)}" ;`);
  }
  for (const ch of channels) {
    lines.push(`  porter:subscribesTo "${escapeTtl(ch)}" ;`);
  }

  if (model) lines.push(`  porter:usesModel "${escapeTtl(model)}" ;`);
  if (maxTokens) lines.push(`  porter:maxTokens "${maxTokens}"^^xsd:integer ;`);
  if (maxTurns) lines.push(`  porter:maxTurns "${maxTurns}"^^xsd:integer ;`);
  if (maxContextTokens) lines.push(`  porter:maxContextTokens "${maxContextTokens}"^^xsd:integer ;`);
  if (reasoning) lines.push(`  porter:reasoning "true"^^xsd:boolean ;`);
  if (visibility !== 'private') lines.push(`  porter:visibility "${escapeTtl(visibility)}" ;`);

  // Replace last ; with .
  const lastLine = lines[lines.length - 1];
  lines[lines.length - 1] = lastLine.replace(/\s;$/, ' .');

  return lines.join('\n') + '\n';
}

export function teamToTurtle(team, uri) {
  const name = team.name || '';
  const config = team.config || {};

  const lines = [
    '@prefix porter: <https://porter.chapeaux.io/vocab#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `<${uri}> a porter:Team ;`,
    `  porter:name "${escapeTtl(name)}" ;`,
  ];

  if (config.pattern) lines.push(`  porter:teamPattern "${escapeTtl(config.pattern)}" ;`);
  if (config.model) lines.push(`  porter:usesModel "${escapeTtl(config.model)}" ;`);
  if (config.api_key_env) lines.push(`  porter:apiKeyEnv "${escapeTtl(config.api_key_env)}" ;`);
  if (config.working_dir && config.working_dir !== '.') lines.push(`  porter:workingDir "${escapeTtl(config.working_dir)}" ;`);
  if (config.max_deliberation_rounds) lines.push(`  porter:maxDeliberationRounds "${config.max_deliberation_rounds}"^^xsd:integer ;`);

  // Agents as full inline slots
  for (const a of (config.agents || [])) {
    const ref = a.ref || a.name || '';
    const role = a.role || 'worker';
    const expertise = a.system_prompt || a.systemPrompt || '';
    const tools = a.tools || [];
    const mcpTools = a.mcp_tools || a.mcpTools || [];
    const model = a.model || '';
    const maxTokens = a.max_tokens || a.maxTokens || 0;
    const maxTurns = a.max_turns || a.maxTurns || 0;
    const maxContextTokens = a.max_context_tokens || a.maxContextTokens || 0;
    const reasoning = a.reasoning || false;

    const parts = [`porter:agentRef "${escapeTtl(ref)}"`, `porter:assignedRole "${escapeTtl(role)}"`];
    if (model) parts.push(`porter:usesModel "${escapeTtl(model)}"`);
    if (expertise) parts.push(`porter:agentExpertise """${escapeTtl(expertise)}"""`);
    for (const t of tools) parts.push(`porter:hasTool "${escapeTtl(t)}"`);
    for (const t of mcpTools) parts.push(`porter:hasMcpTool "${escapeTtl(t)}"`);
    if (maxTokens) parts.push(`porter:maxTokens "${maxTokens}"^^xsd:integer`);
    if (maxTurns) parts.push(`porter:maxTurns "${maxTurns}"^^xsd:integer`);
    if (maxContextTokens) parts.push(`porter:maxContextTokens "${maxContextTokens}"^^xsd:integer`);
    if (reasoning) parts.push(`porter:reasoning "true"^^xsd:boolean`);

    lines.push(`  porter:hasAgentSlot [ ${parts.join(' ; ')} ] ;`);
  }

  // MCP servers as inline blank nodes
  for (const [mcpName, cfg] of Object.entries(config.mcp_servers || {})) {
    const parts = [`porter:name "${escapeTtl(mcpName)}"`, `porter:transport "${escapeTtl(cfg.transport || 'stdio')}"`];
    if (cfg.url) parts.push(`porter:mcpUrl "${escapeTtl(cfg.url)}"`);
    if (cfg.command) parts.push(`porter:mcpCommand "${escapeTtl(cfg.command)}"`);
    if (cfg.auth?.type) parts.push(`porter:authType "${escapeTtl(cfg.auth.type)}"`);
    if (cfg.auth?.token_env) parts.push(`porter:tokenEnv "${escapeTtl(cfg.auth.token_env)}"`);
    if (cfg.auth?.issuer_url) parts.push(`porter:mcpIssuerUrl "${escapeTtl(cfg.auth.issuer_url)}"`);
    if (cfg.args) for (const arg of cfg.args) parts.push(`porter:mcpArgs "${escapeTtl(arg)}"`);
    lines.push(`  porter:hasMcpServer [ ${parts.join(' ; ')} ] ;`);
  }

  // Session env as repeated KEY=VALUE strings
  for (const [k, v] of Object.entries(config.env || {})) {
    lines.push(`  porter:sessionEnv "${escapeTtl(k)}=${escapeTtl(v)}" ;`);
  }

  // Runtime tools
  for (const t of (config.runtime_tools || [])) {
    const toolName = typeof t === 'string' ? t : t.name;
    lines.push(`  porter:runtimeTool "${escapeTtl(toolName)}" ;`);
  }

  // Replace trailing ; with .
  const lastLine = lines[lines.length - 1];
  lines[lines.length - 1] = lastLine.replace(/\s;$/, ' .');

  return lines.join('\n') + '\n';
}

// --- Turtle parsers (simple regex-based, no full RDF parser) ---

export function parseTurtleAgent(turtle) {
  if (!turtle) return null;
  // Normalize full IRIs to prefixed form for simpler regex matching
  const NS = 'https://porter.chapeaux.io/vocab#';
  const norm = turtle.replace(new RegExp(`<${NS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^>]+)>`, 'g'), 'porter:$1');
  if (!norm.includes('porter:Agent')) return null;

  const extractLiteral = (predicate) => {
    // Handle triple-quoted strings
    const longMatch = norm.match(new RegExp(`${predicate}\\s+"""((?:[^"]|"(?!""))*?)"""`, 's'));
    if (longMatch) return longMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    // Handle single-quoted strings
    const shortMatch = norm.match(new RegExp(`${predicate}\\s+"([^"]*?)"`));
    if (shortMatch) return shortMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return '';
  };

  const extractAll = (predicate) => {
    const results = [];
    // Find all blocks starting with the predicate and ending with ; or .
    // Handles both repeated predicates and comma-separated values:
    //   porter:hasTool "a" ;        (separate lines)
    //   porter:hasTool "a", "b" ;   (comma-separated)
    const blockRe = new RegExp(`${predicate}\\s+([^;.]+)[;.]`, 'gs');
    let blockMatch;
    while ((blockMatch = blockRe.exec(norm)) !== null) {
      const valRe = /"([^"]*?)"/g;
      let m;
      while ((m = valRe.exec(blockMatch[1])) !== null) {
        const val = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (!results.includes(val)) results.push(val);
      }
    }
    return results;
  };

  const name = extractLiteral('porter:name');
  if (!name) return null;

  const agent = {
    name,
    role: extractLiteral('porter:assignedRole') || 'worker',
    systemPrompt: extractLiteral('porter:agentExpertise'),
    tools: extractAll('porter:hasTool'),
    mcpTools: extractAll('porter:hasMcpTool'),
    channels: extractAll('porter:subscribesTo'),
    model: extractLiteral('porter:usesModel'),
    maxTokens: parseInt(extractLiteral('porter:maxTokens'), 10) || 8192,
    reasoning: extractLiteral('porter:reasoning') === 'true',
    visibility: extractLiteral('porter:visibility') || 'private',
  };

  return agent;
}

export function parseTurtleTeam(turtle) {
  if (!turtle) return null;
  const NS = 'https://porter.chapeaux.io/vocab#';
  const norm = turtle.replace(new RegExp(`<${NS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^>]+)>`, 'g'), 'porter:$1');
  if (!norm.includes('porter:Team')) return null;

  const extractLiteral = (predicate, src) => {
    const text = src || norm;
    const longMatch = text.match(new RegExp(`${predicate}\\s+"""((?:[^"]|"(?!""))*?)"""`, 's'));
    if (longMatch) return longMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const shortMatch = text.match(new RegExp(`${predicate}\\s+"([^"]*?)"`));
    if (shortMatch) return shortMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return '';
  };

  const extractAll = (predicate, src) => {
    const text = src || norm;
    const results = [];
    const blockRe = new RegExp(`${predicate}\\s+([^;.]+)[;.]`, 'gs');
    let blockMatch;
    while ((blockMatch = blockRe.exec(text)) !== null) {
      const valRe = /"([^"]*?)"/g;
      let m;
      while ((m = valRe.exec(blockMatch[1])) !== null) {
        const val = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (!results.includes(val)) results.push(val);
      }
    }
    return results;
  };

  const name = extractLiteral('porter:name');
  if (!name) return null;

  // Backwards compat: try configJson first
  const configJson = extractLiteral('porter:configJson');
  if (configJson) {
    try {
      const config = JSON.parse(configJson);
      return { name, config };
    } catch { /* fall through to RDF parsing */ }
  }

  // Parse all fields from RDF
  const pattern = extractLiteral('porter:teamPattern');
  const model = extractLiteral('porter:usesModel');
  const apiKeyEnv = extractLiteral('porter:apiKeyEnv') || 'ANTHROPIC_API_KEY';
  const workingDir = extractLiteral('porter:workingDir') || '.';
  const maxRoundsStr = extractLiteral('porter:maxDeliberationRounds');
  const maxRounds = maxRoundsStr ? parseInt(maxRoundsStr, 10) : undefined;

  // Parse agent slots (blank nodes)
  const agents = [];
  const slotRe = /porter:hasAgentSlot\s+\[([\s\S]*?)\]/g;
  let slotMatch;
  while ((slotMatch = slotRe.exec(norm)) !== null) {
    const block = slotMatch[1];
    const agent = {
      name: extractLiteral('porter:agentRef', block),
      ref: extractLiteral('porter:agentRef', block),
      role: extractLiteral('porter:assignedRole', block) || 'worker',
      model: extractLiteral('porter:usesModel', block) || undefined,
      system_prompt: extractLiteral('porter:agentExpertise', block),
      tools: extractAll('porter:hasTool', block),
      mcp_tools: extractAll('porter:hasMcpTool', block),
      max_tokens: parseInt(extractLiteral('porter:maxTokens', block), 10) || 8192,
      max_turns: parseInt(extractLiteral('porter:maxTurns', block), 10) || undefined,
      max_context_tokens: parseInt(extractLiteral('porter:maxContextTokens', block), 10) || undefined,
      reasoning: extractLiteral('porter:reasoning', block) === 'true',
    };
    agents.push(agent);
  }

  // Also try legacy hasAgentRef format
  if (agents.length === 0) {
    const agentRefRe = /porter:hasAgentRef\s+\[\s*porter:agentRef\s+"([^"]*?)"\s*;\s*porter:assignedRole\s+"([^"]*?)"(?:\s*;\s*porter:usesModel\s+"([^"]*?)")?\s*\]/g;
    let m;
    while ((m = agentRefRe.exec(norm)) !== null) {
      const entry = { name: m[1], ref: m[1], role: m[2] };
      if (m[3]) entry.model = m[3];
      agents.push(entry);
    }
  }

  // Parse MCP servers (blank nodes)
  const mcpServers = {};
  const mcpRe = /porter:hasMcpServer\s+\[([\s\S]*?)\]/g;
  let mcpMatch;
  while ((mcpMatch = mcpRe.exec(norm)) !== null) {
    const block = mcpMatch[1];
    const mcpName = extractLiteral('porter:name', block);
    if (!mcpName) continue;
    const cfg = { transport: extractLiteral('porter:transport', block) || 'stdio' };
    const url = extractLiteral('porter:mcpUrl', block);
    if (url) cfg.url = url;
    const cmd = extractLiteral('porter:mcpCommand', block);
    if (cmd) cfg.command = cmd;
    const authType = extractLiteral('porter:authType', block);
    if (authType) {
      cfg.auth = { type: authType };
      const tokenEnv = extractLiteral('porter:tokenEnv', block);
      if (tokenEnv) cfg.auth.token_env = tokenEnv;
      const issuerUrl = extractLiteral('porter:mcpIssuerUrl', block);
      if (issuerUrl) cfg.auth.issuer_url = issuerUrl;
    }
    mcpServers[mcpName] = cfg;
  }

  // Also try legacy mcpServersJson
  if (Object.keys(mcpServers).length === 0) {
    const mcpJson = extractLiteral('porter:mcpServersJson');
    if (mcpJson) {
      try { Object.assign(mcpServers, JSON.parse(mcpJson)); } catch { /* ignore */ }
    }
  }

  // Session env
  const envStrings = extractAll('porter:sessionEnv');
  const env = {};
  for (const s of envStrings) {
    const eq = s.indexOf('=');
    if (eq > 0) env[s.slice(0, eq)] = s.slice(eq + 1);
  }

  // Runtime tools
  const runtimeTools = extractAll('porter:runtimeTool');

  return {
    name,
    config: {
      session: name,
      pattern: pattern || undefined,
      model,
      api_key_env: apiKeyEnv,
      working_dir: workingDir,
      max_deliberation_rounds: maxRounds,
      agents,
      mcp_servers: Object.keys(mcpServers).length > 0 ? mcpServers : undefined,
      env: Object.keys(env).length > 0 ? env : undefined,
      runtime_tools: runtimeTools.length > 0 ? runtimeTools : undefined,
    },
  };
}

// --- Model Turtle serializer (client-side, matching porter: vocabulary) ---

export function modelToTurtle(model, uri) {
  const id = model.id || model.model_id || '';
  const displayName = model.display_name || id;
  const providerType = model.provider_type || 'openai_compat';
  const baseUrl = model.base_url || '';
  const auth = model.auth || 'bearer';
  const contextWindow = model.context_window || 0;
  const maxTokens = model.max_tokens || 0;
  const capabilities = model.capabilities || {};

  const lines = [
    '@prefix porter: <https://porter.chapeaux.io/vocab#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `<${uri}> a porter:Model ;`,
    `  porter:name "${escapeTtl(id)}" ;`,
    `  porter:displayName "${escapeTtl(displayName)}" ;`,
    `  porter:providerType "${escapeTtl(providerType)}" ;`,
    `  porter:baseUrl "${escapeTtl(baseUrl)}" ;`,
    `  porter:authMethod "${escapeTtl(auth)}" ;`,
  ];

  if (contextWindow) lines.push(`  porter:contextWindow "${contextWindow}"^^xsd:integer ;`);
  if (maxTokens) lines.push(`  porter:maxTokens "${maxTokens}"^^xsd:integer ;`);
  if (capabilities.tool_calling) lines.push(`  porter:toolCalling "true"^^xsd:boolean ;`);
  if (capabilities.reasoning) lines.push(`  porter:reasoning "true"^^xsd:boolean ;`);
  if (capabilities.vision) lines.push(`  porter:vision "true"^^xsd:boolean ;`);
  if (capabilities.json_mode) lines.push(`  porter:jsonMode "true"^^xsd:boolean ;`);

  // Replace last ; with .
  const lastLine = lines[lines.length - 1];
  lines[lines.length - 1] = lastLine.replace(/\s;$/, ' .');

  return lines.join('\n') + '\n';
}

// --- MCP Turtle serializer (client-side) ---

export function mcpToTurtle(mcp, uri) {
  const name = mcp.name || '';
  const transport = mcp.transport || 'stdio';

  const lines = [
    '@prefix porter: <https://porter.chapeaux.io/vocab#> .',
    '',
    `<${uri}> a porter:McpServer ;`,
    `  porter:name "${escapeTtl(name)}" ;`,
    `  porter:transport "${escapeTtl(transport)}" ;`,
  ];

  if (mcp.url) lines.push(`  porter:mcpUrl "${escapeTtl(mcp.url)}" ;`);
  if (mcp.command) lines.push(`  porter:mcpCommand "${escapeTtl(mcp.command)}" ;`);
  if (mcp.auth?.type) lines.push(`  porter:authType "${escapeTtl(mcp.auth.type)}" ;`);
  if (mcp.auth?.token_env) lines.push(`  porter:tokenEnv "${escapeTtl(mcp.auth.token_env)}" ;`);

  const lastLine = lines[lines.length - 1];
  lines[lines.length - 1] = lastLine.replace(/\s;$/, ' .');

  return lines.join('\n') + '\n';
}

// --- Federation Turtle serializer (client-side) ---

export function federationToTurtle(config, uri) {
  const lines = [
    '@prefix porter: <https://porter.chapeaux.io/vocab#> .',
    '@prefix xsd: <http://www.w3.org/2001/XMLSchema#> .',
    '',
    `<${uri}> a porter:FederationConfig ;`,
  ];

  if (config.domain) lines.push(`  porter:baseUrl "${escapeTtl(config.domain)}" ;`);
  if (config.approval_mode) lines.push(`  porter:approvalMode "${escapeTtl(config.approval_mode)}" ;`);
  if (config.public_summaries != null) {
    lines.push(`  porter:publicSummaries "${!!config.public_summaries}"^^xsd:boolean ;`);
  }
  for (const entry of config.allowlist || []) {
    lines.push(`  porter:allowlistEntry "${escapeTtl(entry)}" ;`);
  }

  const lastLine = lines[lines.length - 1];
  lines[lines.length - 1] = lastLine.replace(/\s;$/, ' .');

  return lines.join('\n') + '\n';
}

// --- Server-side RDF parsers (delegates to N3.js on the server) ---

export async function parseTurtleModel(turtle) {
  return _parseTurtleViaServer(turtle, 'model');
}

export async function parseTurtleMcp(turtle) {
  return _parseTurtleViaServer(turtle, 'mcp');
}

async function _parseTurtleViaServer(turtle, type) {
  if (!turtle) return null;
  const browserMode = document.querySelector('meta[name="porter-mode"]')?.content === 'browser';
  if (browserMode) {
    // In browser mode, use client-side regex parsers
    if (type === 'model') return _parseModelTurtleLocal(turtle);
    if (type === 'mcp') return _parseMcpTurtleLocal(turtle);
    return null;
  }
  try {
    const resp = await fetch(`/api/rdf/parse?type=${type}`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/turtle' },
      body: turtle,
    });
    if (resp.ok) return resp.json();
  } catch (err) {
    console.error(`[porter-pod] RDF parse (${type}) error:`, err);
  }
  return null;
}

export function parseTurtleFederation(turtle) {
  if (!turtle) return null;
  const NS = 'https://porter.chapeaux.io/vocab#';
  const norm = turtle.replace(new RegExp(`<${NS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^>]+)>`, 'g'), 'porter:$1');
  if (!norm.includes('porter:FederationConfig')) return null;

  const extractLiteral = (predicate) => {
    const longMatch = norm.match(new RegExp(`${predicate}\\s+"""((?:[^"]|"(?!""))*?)"""`, 's'));
    if (longMatch) return longMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const shortMatch = norm.match(new RegExp(`${predicate}\\s+"([^"]*?)"`));
    if (shortMatch) return shortMatch[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    return '';
  };

  const extractAll = (predicate) => {
    const results = [];
    const blockRe = new RegExp(`${predicate}\\s+([^;.]+)[;.]`, 'gs');
    let blockMatch;
    while ((blockMatch = blockRe.exec(norm)) !== null) {
      const valRe = /"([^"]*?)"/g;
      let m;
      while ((m = valRe.exec(blockMatch[1])) !== null) {
        const val = m[1].replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        if (!results.includes(val)) results.push(val);
      }
    }
    return results;
  };

  return {
    domain: extractLiteral('porter:baseUrl'),
    approval_mode: extractLiteral('porter:approvalMode') || 'allowlist',
    public_summaries: extractLiteral('porter:publicSummaries') === 'true',
    allowlist: extractAll('porter:allowlistEntry'),
  };
}

// --- ACL helpers for Porter container access ---

/**
 * Grant Porter's server-side identity read access to the user's
 * {podRoot}/porter/ container so the AP bridge can fetch teams
 * directly from the Pod without routing through the orchestrator pod.
 *
 * Sets a container-level ACL with:
 *   - Porter WebID: Read (+ default for child resources)
 *   - Owner WebID: Read, Write, Control
 *
 * @param {Function} authFetch  Authenticated fetch for the user's Pod.
 * @param {string} porterContainerUrl  The container URL, e.g. "https://pod.example/porter/".
 * @param {string} porterWebId  Porter's WebID (server identity).
 * @param {string} ownerWebId  The Pod owner's WebID.
 */
export async function grantPorterContainerAccess(authFetch, porterContainerUrl, porterWebId, ownerWebId) {
  const aclUrl = porterContainerUrl + '.acl';
  const acl = `@prefix acl: <http://www.w3.org/ns/auth/acl#> .
@prefix foaf: <http://xmlns.com/foaf/0.1/> .

<#porter-read>
  a acl:Authorization ;
  acl:agent <${porterWebId}> ;
  acl:default <./> ;
  acl:accessTo <./> ;
  acl:mode acl:Read .

<#owner>
  a acl:Authorization ;
  acl:agent <${ownerWebId}> ;
  acl:default <./> ;
  acl:accessTo <./> ;
  acl:mode acl:Read, acl:Write, acl:Control .
`;
  try {
    await authFetch(aclUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'text/turtle' },
      body: acl,
    });
  } catch (err) {
    console.error('[porter-pod] grantPorterContainerAccess error:', err);
  }
}

// --- ACL helpers for sharing individual resources ---

export async function setResourcePublic(authFetch, resourceUrl) {
  const aclUrl = resourceUrl + '.acl';
  // Determine owner WebID from Pod sync context
  const ownerWebId = window._podSyncWebId || '';
  const acl = [
    '@prefix acl: <http://www.w3.org/ns/auth/acl#> .',
    '@prefix foaf: <http://xmlns.com/foaf/0.1/> .',
    '',
    '<#public>',
    '  a acl:Authorization ;',
    '  acl:agentClass foaf:Agent ;',
    `  acl:accessTo <${resourceUrl}> ;`,
    '  acl:mode acl:Read .',
    '',
    '<#owner>',
    '  a acl:Authorization ;',
    ...(ownerWebId ? [`  acl:agent <${ownerWebId}> ;`] : ['  acl:agentClass foaf:Agent ;']),
    `  acl:accessTo <${resourceUrl}> ;`,
    '  acl:mode acl:Read, acl:Write, acl:Control .',
  ].join('\n') + '\n';

  await authFetch(aclUrl, {
    method: 'PUT',
    headers: { 'Content-Type': 'text/turtle' },
    body: acl,
  });
}

export async function setResourcePrivate(authFetch, resourceUrl) {
  const aclUrl = resourceUrl + '.acl';
  await authFetch(aclUrl, { method: 'DELETE' }).catch(() => {});
}

// --- Client-side Turtle parsers for browser mode (no server to delegate to) ---

function _parseModelTurtleLocal(turtle) {
  if (!turtle) return null;
  const NS = 'https://porter.chapeaux.io/vocab#';
  const norm = turtle.replace(new RegExp(`<${NS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^>]+)>`, 'g'), 'porter:$1');
  if (!norm.includes('porter:Model')) return null;
  const ex = (pred) => {
    const m = norm.match(new RegExp(`${pred}\\s+"([^"]*?)"`));
    return m ? m[1] : '';
  };
  const id = ex('porter:name');
  if (!id) return null;
  return {
    id,
    display_name: ex('porter:displayName') || id,
    provider_type: ex('porter:providerType') || 'openai_compat',
    base_url: ex('porter:baseUrl') || '',
    auth: ex('porter:authMethod') || 'bearer',
    context_window: parseInt(ex('porter:contextWindow'), 10) || 0,
    max_tokens: parseInt(ex('porter:maxTokens'), 10) || 0,
    capabilities: {
      tool_calling: norm.includes('porter:toolCalling "true"'),
      reasoning: norm.includes('porter:reasoning "true"'),
      vision: norm.includes('porter:vision "true"'),
      json_mode: norm.includes('porter:jsonMode "true"'),
    },
  };
}

function _parseMcpTurtleLocal(turtle) {
  if (!turtle) return null;
  const NS = 'https://porter.chapeaux.io/vocab#';
  const norm = turtle.replace(new RegExp(`<${NS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^>]+)>`, 'g'), 'porter:$1');
  if (!norm.includes('porter:McpServer')) return null;
  const ex = (pred) => {
    const m = norm.match(new RegExp(`${pred}\\s+"([^"]*?)"`));
    return m ? m[1] : '';
  };
  const name = ex('porter:name');
  if (!name) return null;
  const cfg = { name, transport: ex('porter:transport') || 'stdio' };
  const url = ex('porter:mcpUrl');
  if (url) cfg.url = url;
  const cmd = ex('porter:mcpCommand');
  if (cmd) cfg.command = cmd;
  const authType = ex('porter:authType');
  if (authType) {
    cfg.auth = { type: authType };
    const tokenEnv = ex('porter:tokenEnv');
    if (tokenEnv) cfg.auth.token_env = tokenEnv;
  }
  return cfg;
}
